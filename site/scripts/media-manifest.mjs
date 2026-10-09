// Writes worker/media.json: the size of every video the Worker answers byte ranges for (the
// films in public/media). Static assets don't report a length to the Worker, and a
// byte-range answer has to state the total.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";

const pub = new URL("../public/", import.meta.url);
const sizes = {};
const walk = (dir) => {
  for (const f of readdirSync(new URL(dir, pub), { withFileTypes: true })) {
    const path = `${dir}${f.name}`;
    if (f.isDirectory()) walk(`${path}/`);
    else if (f.name.endsWith(".mp4")) sizes[`/${path}`] = statSync(new URL(path, pub)).size;
  }
};
// None yet in a checkout whose films are still to be recorded (scripts/record.ts).
if (existsSync(new URL("media/", pub))) walk("media/");
writeFileSync(new URL("../worker/media.json", import.meta.url), `${JSON.stringify(sizes, null, 2)}\n`);
console.log(`media.json: ${Object.keys(sizes).length} videos`);
