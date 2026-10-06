/**
 * Just enough POSIX shell grammar to find every command a Bash call would run,
 * for the guard. Lists (`;` `&&` `||` `|` `&` newlines), subshells, command and
 * process substitution, backticks, quoting, escapes, comments, redirections and
 * heredocs are understood; everything a substitution runs comes out as its own
 * command. Input it cannot make sense of is reported, never guessed at.
 */

export interface Word {
  /** The word after quote removal. Expansions stay verbatim (`$HOME`, `$(…)`). */
  readonly text: string
  /** Holds an expansion, substitution or glob, so its runtime value is unknown. */
  readonly dynamic: boolean
  /** May become several words at runtime, or none: an expansion or glob outside quotes (`$X` may be `1 --watch`), or `"$@"`. */
  readonly splits: boolean
  /** Some part of it was quoted; a quoted heredoc delimiter disables expansion of the body. */
  readonly quoted: boolean
}

export type Command = ReadonlyArray<Word>

export type Parsed =
  | { readonly _tag: "Parsed"; readonly commands: ReadonlyArray<Command> }
  | { readonly _tag: "Unparsable"; readonly reason: string }

class ParseError extends Error {}

interface Heredoc {
  readonly delimiter: string
  readonly stripTabs: boolean
  readonly expand: boolean
}

const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"])
const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/
const SPECIAL_PARAMETER = /[0-9@*#?$!-]/
/** Unquoted text that the shell would expand as a glob or brace pattern. */
const PATTERN = /[*?]|\[[^\]]*\]|\{[^}]*(,|\.\.)[^}]*\}/
/** An expansion that is one word per element even inside double quotes: `"$@"`, `"${args[@]}"`, `"${!prefix@}"`, zsh's `"${(@)x}"`. */
const ELEMENTS = /^\$(@|\{(@|!?[A-Za-z_][A-Za-z0-9_]*\[@\]|![A-Za-z_][A-Za-z0-9_]*@|\([^)]*@[^)]*\)))/

/** Nesting (`$(…)`, subshells, `"…"`) past this many levels is reported rather than recursed into, so a pathological `$(` chain cannot blow the stack. Far above anything a real command reaches. */
const MAX_NESTING = 256

class Parser {
  private i = 0
  private depth = 0
  private readonly heredocs: Array<Heredoc> = []

  constructor(
    private readonly source: string,
    private readonly commands: Array<Command>,
  ) {}

  private peek(offset = 0): string {
    return this.source[this.i + offset] ?? ""
  }

  private get done(): boolean {
    return this.i >= this.source.length
  }

  /** Enters one nesting level, failing before the recursion can overflow the stack. */
  private enter(): void {
    if (++this.depth > MAX_NESTING) throw new ParseError("too deeply nested")
  }

  /**
   * A complete list. `closer` is the `)` of an enclosing subshell or `$(…)`, or the
   * `}` of a `${ …; }`, which closes it only where a command starts and no `{ …; }`
   * group of its own is open.
   */
  parseList(closer: ")" | "}" | undefined): void {
    this.enter()
    let words: Array<Word> = []
    let redirectTarget = false
    let groups = 0
    const endCommand = () => {
      if (words.length > 0) this.commands.push(words)
      words = []
      redirectTarget = false
    }
    while (!this.done) {
      const c = this.peek()
      if (closer === "}" && c === "}" && words.length === 0 && groups === 0) {
        this.i++
        this.depth--
        return
      }
      if (c === " " || c === "\t") {
        this.i++
      } else if (c === "\\" && this.peek(1) === "\n") {
        this.i += 2
      } else if (c === "\n") {
        this.i++
        endCommand()
        this.readHeredocBodies()
      } else if (c === "#") {
        while (!this.done && this.peek() !== "\n") this.i++
      } else if (c === ";" || c === "|" || (c === "&" && this.peek(1) !== ">")) {
        this.i++
        if (this.peek() === c || this.peek() === "&") this.i++
        endCommand()
      } else if (c === "(" && this.peek(1) === "(" && this.tryArithmetic()) {
        endCommand()
      } else if (c === "(") {
        this.i++
        endCommand()
        this.parseList(")")
      } else if (c === ")") {
        this.i++
        endCommand()
        // A stray `)` is a `case` pattern; inside a subshell it closes it.
        if (closer === ")") {
          this.depth--
          return
        }
      } else if (c === "<" || c === ">" || c === "&") {
        const redirection = this.readRedirection()
        if (redirection._tag === "Redirect") redirectTarget = redirection.target
        else if (redirectTarget) redirectTarget = false
        else words.push(redirection.word)
      } else {
        const { word, fd } = this.readWord()
        // `2>&1`: digits glued to a redirection are a file descriptor, not an argument.
        if (fd && (this.peek() === "<" || this.peek() === ">")) continue
        // Every unquoted `{` word counts as a group, an argument `{` too: one counted too many leaves a `${ …; }` unterminated, never closed early.
        if (!word.quoted && word.text === "{") groups++
        else if (!word.quoted && word.text === "}" && words.length === 0 && groups > 0) groups--
        if (redirectTarget) redirectTarget = false
        else words.push(word)
      }
    }
    if (closer !== undefined) throw new ParseError(`unterminated ${closer === ")" ? "(" : "${"}`)
    endCommand()
    this.depth--
  }

  /**
   * At `<`, `>` or `&>`: a process substitution (an argument), or a redirection
   * whose next word is its target rather than an argument. A heredoc has no
   * target word; its delimiter is read here and its body after the line ends.
   */
  private readRedirection(): { readonly _tag: "Substitution"; readonly word: Word } | { readonly _tag: "Redirect"; readonly target: boolean } {
    if (this.peek() === "&") this.i++
    const op = this.peek()
    this.i++
    if (this.peek() === "(") {
      this.i++
      this.parseList(")")
      return { _tag: "Substitution", word: { text: `${op}(…)`, dynamic: true, splits: false, quoted: false } }
    }
    if (op === "<" && this.peek() === "<") {
      this.i++
      if (this.peek() === "<") {
        this.i++
        return { _tag: "Redirect", target: true }
      }
      const stripTabs = this.peek() === "-"
      if (stripTabs) this.i++
      while (this.peek() === " " || this.peek() === "\t") this.i++
      if (this.done || WORD_END.has(this.peek())) throw new ParseError("heredoc without a delimiter")
      const { word } = this.readWord()
      this.heredocs.push({ delimiter: word.text, stripTabs, expand: !word.quoted })
      return { _tag: "Redirect", target: false }
    }
    if (this.peek() === ">" || this.peek() === "&" || this.peek() === "|") this.i++
    return { _tag: "Redirect", target: true }
  }

  /** Consumes the bodies of heredocs opened on the line that just ended. */
  private readHeredocBodies(): void {
    while (this.heredocs.length > 0) {
      const heredoc = this.heredocs.shift()
      if (heredoc === undefined) return
      const lines: Array<string> = []
      while (!this.done) {
        const end = this.source.indexOf("\n", this.i)
        const line = this.source.slice(this.i, end === -1 ? undefined : end)
        this.i = end === -1 ? this.source.length : end + 1
        if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break
        lines.push(line)
      }
      if (heredoc.expand) new Parser(lines.join("\n"), this.commands).readExpanding(undefined)
    }
  }

  private readWord(): { readonly word: Word; readonly fd: boolean } {
    let text = ""
    let unquoted = ""
    let dynamic = false
    let splits = false
    let quoted = false
    let plainDigits = true
    while (!this.done && !WORD_END.has(this.peek())) {
      const c = this.peek()
      if (c === "'") {
        const end = this.source.indexOf("'", this.i + 1)
        if (end === -1) throw new ParseError("unterminated '")
        text += this.source.slice(this.i + 1, end)
        this.i = end + 1
        quoted = true
        plainDigits = false
      } else if (c === "$" && this.peek(1) === "'") {
        this.i += 2
        text += this.readAnsiC()
        quoted = true
        plainDigits = false
      } else if (c === "$" && this.peek(1) === '"') {
        // `$"…"` is a locale-translated double-quoted string; the `$` is not an expansion.
        this.i++
      } else if (c === '"') {
        this.i++
        const inner = this.readExpanding('"')
        text += inner.text
        dynamic ||= inner.dynamic
        splits ||= inner.splits
        quoted = true
        plainDigits = false
      } else if (c === "\\") {
        if (this.peek(1) === "\n") {
          this.i += 2
          continue
        }
        if (this.i + 1 >= this.source.length) throw new ParseError("trailing backslash")
        text += this.peek(1)
        this.i += 2
        quoted = true
        plainDigits = false
      } else if (c === "$" || c === "`") {
        const expansion = this.readExpansion()
        text += expansion
        splits ||= expansion !== "$"
        plainDigits = false
      } else {
        text += c
        unquoted += c
        if (!/[0-9]/.test(c)) plainDigits = false
        this.i++
      }
    }
    splits ||= PATTERN.test(unquoted)
    return { word: { text, dynamic: dynamic || splits, splits, quoted }, fd: plainDigits && text !== "" }
  }

  /** `$'…'`: escapes decoded, nothing expanded. */
  private readAnsiC(): string {
    let text = ""
    while (!this.done && this.peek() !== "'") {
      if (this.peek() === "\\") {
        const next = this.peek(1)
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", e: "\x1b", v: "\v", f: "\f", b: "\b" }
        const rest = this.source.slice(this.i + 1)
        const hex = /^x([0-9A-Fa-f]{1,2})/.exec(rest)
        const unicode = /^(u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8})/.exec(rest)
        const octal = /^([0-7]{1,3})/.exec(rest)
        const control = /^c(.)/s.exec(rest)
        if (hex !== null) {
          text += String.fromCharCode(parseInt(hex[1] ?? "0", 16))
          this.i += 1 + hex[0].length
        } else if (unicode !== null) {
          text += String.fromCodePoint(parseInt(unicode[0].slice(1), 16))
          this.i += 1 + unicode[0].length
        } else if (octal !== null) {
          text += String.fromCharCode(parseInt(octal[1] ?? "0", 8))
          this.i += 1 + octal[0].length
        } else if (control !== null) {
          // `\cX` is Ctrl-X: the letter's code with the top bits cleared.
          text += String.fromCharCode((control[1] ?? "").toUpperCase().charCodeAt(0) & 0x1f)
          this.i += 1 + control[0].length
        } else {
          text += simple[next] ?? next
          this.i += 2
        }
      } else {
        text += this.peek()
        this.i++
      }
    }
    if (this.done) throw new ParseError("unterminated $'")
    this.i++
    return text
  }

  /**
   * Double-quoted text (terminated by `"`), `${…}` contents (by `}`) or an
   * expanding heredoc body (by the end of input). Substitutions inside run.
   */
  readExpanding(terminator: '"' | "}" | undefined): { readonly text: string; readonly dynamic: boolean; readonly splits: boolean } {
    this.enter()
    let text = ""
    let dynamic = false
    let splits = false
    while (!this.done && this.peek() !== terminator) {
      const c = this.peek()
      if (c === "\\") {
        const next = this.peek(1)
        if (next === "\n") {
          this.i += 2
        } else if (next === "$" || next === "`" || next === '"' || next === "\\" || next === terminator) {
          text += next
          this.i += 2
        } else {
          text += c
          this.i++
        }
      } else if (c === "$" || c === "`") {
        const expansion = this.readExpansion()
        text += expansion
        dynamic ||= expansion !== "$"
        splits ||= ELEMENTS.test(expansion)
      } else {
        text += c
        this.i++
      }
    }
    if (terminator !== undefined) {
      if (this.done) throw new ParseError(`unterminated ${terminator === '"' ? '"' : "${"}`)
      this.i++
    }
    this.depth--
    return { text, dynamic, splits }
  }

  /** At `$` or a backtick. Returns the raw text; any command it runs is recorded. */
  private readExpansion(): string {
    const start = this.i
    if (this.peek() === "`") {
      this.i++
      let inner = ""
      while (!this.done && this.peek() !== "`") {
        if (this.peek() === "\\" && ["`", "\\", "$"].includes(this.peek(1))) {
          inner += this.peek(1)
          this.i += 2
        } else {
          inner += this.peek()
          this.i++
        }
      }
      if (this.done) throw new ParseError("unterminated `")
      this.i++
      new Parser(inner, this.commands).parseAll()
      return this.source.slice(start, this.i)
    }
    this.i++
    const next = this.peek()
    if (next === "(" && this.peek(1) === "(") {
      this.i += 2
      this.skipArithmetic()
    } else if (next === "(") {
      this.i++
      this.parseList(")")
    } else if (next === "{") {
      this.i++
      // bash 5.3 `${ cmd; }` / `${| cmd; }` run a command list (a space or `|` after the brace), not a parameter expansion.
      if (this.peek() === "|" || this.peek() === " " || this.peek() === "\t" || this.peek() === "\n") {
        if (this.peek() === "|") this.i++
        this.parseList("}")
      } else {
        this.readExpanding("}")
      }
    } else if (NAME_START.test(next)) {
      while (NAME_CHAR.test(this.peek())) this.i++
    } else if (SPECIAL_PARAMETER.test(next) && next !== "") {
      this.i++
    } else {
      return "$"
    }
    return this.source.slice(start, this.i)
  }

  /** After `((`: up to the matching `))`. Substitutions inside still run. */
  private skipArithmetic(): void {
    if (!this.tryArithmetic(0)) throw new ParseError("unterminated ((")
  }

  /**
   * At `((` (or just after it, `skip` 0): an arithmetic command when a matching
   * `))` closes it. Otherwise, like bash, it is two nested subshells and nothing
   * is consumed, so the caller parses it as such.
   */
  private tryArithmetic(skip = 2): boolean {
    const start = this.i
    const commands = this.commands.length
    const nesting = this.depth
    this.i += skip
    let depth = 0
    try {
      while (!this.done) {
        const c = this.peek()
        if (c === "$" || c === "`") {
          this.readExpansion()
        } else if (c === "(") {
          depth++
          this.i++
        } else if (c === ")") {
          if (depth === 0) {
            if (this.peek(1) !== ")") break
            this.i += 2
            return true
          }
          depth--
          this.i++
        } else {
          this.i++
        }
      }
    } catch (cause) {
      if (!(cause instanceof ParseError)) throw cause
    }
    this.i = start
    this.commands.length = commands
    this.depth = nesting
    return false
  }

  parseAll(): void {
    this.parseList(undefined)
    if (this.heredocs.length > 0) this.readHeredocBodies()
  }
}

export const parseShell = (source: string): Parsed => {
  const commands: Array<Command> = []
  try {
    new Parser(source, commands).parseAll()
  } catch (cause) {
    if (cause instanceof ParseError) return { _tag: "Unparsable", reason: cause.message }
    throw cause
  }
  return { _tag: "Parsed", commands }
}
