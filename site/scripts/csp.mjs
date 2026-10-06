// Run by `bun run build`, after Astro: every inline script and style in the built pages has to
// be allowed by the Content-Security-Policy in public/_headers, or the browser blocks it. Fails
// with the hash to add.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const policy = /^\s+Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(join(dist, "_headers"), "utf8"))?.[1];
if (!policy) {
  console.error("csp: public/_headers has no Content-Security-Policy");
  process.exit(1);
}
const sources = (name) => policy.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1) ?? [];
const allowed = { script: sources("script-src"), style: sources("style-src") };

const pages = readdirSync(dist, { recursive: true }).filter((f) => f.endsWith(".html"));
const missing = [];
for (const page of pages) {
  const html = readFileSync(join(dist, page), "utf8");
  for (const [, tag, body] of html.matchAll(/<(script|style)(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/\1>/g)) {
    const hash = `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
    if (!allowed[tag].includes(hash)) missing.push(`${page}: an inline ${tag} is blocked; add ${hash} to ${tag}-src`);
  }
}
if (missing.length) {
  console.error(`csp: public/_headers doesn't allow what the build inlines:\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`csp: ${pages.length} pages, everything inline allowed`);
