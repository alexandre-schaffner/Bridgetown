import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A fresh `$TMPDIR/<prefix>XXXXXX` directory, removed when the scope that made it ends: the test that
 * called it, or its describe or file at the top level. Not from a `beforeAll`, whose scope ends before the tests.
 */
export const scratchDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
