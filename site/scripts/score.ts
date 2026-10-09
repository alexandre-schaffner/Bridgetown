// The launch film's score, synthesised from the cues the film reports (src/dev/launch.ts): a
// bed on the film's 120 BPM grid (a drone under the noise, a pad for the name, then a soft
// groove under the app and a held chord for the end card), and a sound for every cue, all
// through one reverb. Deterministic: the same cues make the same file.
//
// usage: bun scripts/score.ts <cues.json> <out.wav>
//   cues.json   { duration, cues: [{ t, kind, v? }] }, as scripts/record.ts writes it

import { readFileSync, writeFileSync } from "node:fs";

const RATE = 48_000;
const BEAT = 0.5;
const BAR = 4 * BEAT;

interface Cue {
  t: number;
  kind: string;
  v?: number;
}

/** Where the film's sections begin, in seconds (launch.ts's marks). */
const AT = { drop: 8, name: 12, notch: 20, app: 28.5, montage: 61, end: 63 };

// MARK: Buffers

class Bus {
  l: Float32Array;
  r: Float32Array;
  constructor(readonly length: number) {
    this.l = new Float32Array(length);
    this.r = new Float32Array(length);
  }
  /** Adds `v` at sample `i`, panned from -1 (left) to 1 (right) at equal power. */
  add(i: number, v: number, pan = 0) {
    if (i < 0 || i >= this.length) return;
    const a = ((pan + 1) * Math.PI) / 4;
    this.l[i]! += v * Math.cos(a);
    this.r[i]! += v * Math.sin(a);
  }
}

let seed = 1;
/** Seeded noise in -1..1, so two scores of the same cues are the same. */
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const S = (t: number) => Math.round(t * RATE);

/** One cycle of a soft, warm tone: odd and even harmonics falling off fast. */
const TABLE = (() => {
  const n = 4096;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 9; h++) v += Math.sin((2 * Math.PI * h * i) / n) / h ** 1.35;
    t[i] = v * 0.62;
  }
  return t;
})();
const wave = (phase: number) => TABLE[Math.floor((phase - Math.floor(phase)) * TABLE.length)]!;

// MARK: Voices

/** A held note on the table wave, three detuned voices spread across the stereo field. */
function pad(bus: Bus, midi: number, t0: number, t1: number, gain: number, attack = 1.2, release = 1.6, shape?: (t: number) => number) {
  const f = hz(midi);
  const voices = [
    { d: -0.004, pan: -0.6 },
    { d: 0, pan: 0 },
    { d: 0.0045, pan: 0.6 },
  ];
  const end = t1 + release;
  for (const { d, pan } of voices) {
    let ph = Math.abs(noise());
    const inc = (f * (1 + d)) / RATE;
    for (let i = S(t0); i < S(end); i++) {
      const t = i / RATE;
      const env = Math.min(1, (t - t0) / attack) * (t > t1 ? Math.max(0, 1 - (t - t1) / release) : 1);
      bus.add(i, wave(ph) * env * gain * (shape ? shape(t) : 1) * 0.42, pan);
      ph += inc;
    }
  }
}

/** A sine with exponential decay: bells and plucks are sums of these. */
function partial(bus: Bus, f: number, t0: number, gain: number, decay: number, pan = 0, attack = 0.002) {
  let ph = 0;
  for (let i = S(t0); i < S(t0 + decay * 7); i++) {
    const t = i / RATE - t0;
    bus.add(i, Math.sin(2 * Math.PI * ph) * gain * Math.min(1, t / attack) * Math.exp(-t / decay), pan);
    ph += f / RATE;
  }
}

/** A bell: inharmonic partials, the high ones dying first. */
function bell(bus: Bus, midi: number, t0: number, gain: number, pan = 0) {
  const f = hz(midi);
  partial(bus, f, t0, gain, 0.9, pan);
  partial(bus, f * 2.0, t0, gain * 0.35, 0.5, pan);
  partial(bus, f * 2.76, t0, gain * 0.22, 0.32, pan);
  partial(bus, f * 5.4, t0, gain * 0.08, 0.12, pan);
}

/** A kick: a sine falling from `top` to `low` Hz, with a click on its front. */
function kick(bus: Bus, t0: number, gain: number, top = 120, low = 50, decay = 0.2) {
  let ph = 0;
  for (let i = S(t0); i < S(t0 + decay * 5); i++) {
    const t = i / RATE - t0;
    const f = low + (top - low) * Math.exp(-t / 0.035);
    ph += f / RATE;
    const click = t < 0.004 ? noise() * 0.25 * (1 - t / 0.004) : 0;
    bus.add(i, (Math.sin(2 * Math.PI * ph) * Math.exp(-t / decay) + click) * gain);
  }
}

/** Noise shaped by a band that moves: whooshes, risers, hats and air. */
function sweep(
  bus: Bus,
  t0: number,
  dur: number,
  gain: number,
  {
    from = 400,
    to = 4000,
    q = 0.7,
    env = (x: number) => Math.sin(Math.PI * x),
    pan = 0,
    panTo = pan,
  }: { from?: number; to?: number; q?: number; env?: (x: number) => number; pan?: number; panTo?: number } = {},
) {
  // A state-variable band-pass, retuned every sample.
  let low = 0;
  let band = 0;
  for (let i = S(t0); i < S(t0 + dur); i++) {
    const x = (i / RATE - t0) / dur;
    const f = from * (to / from) ** x;
    const k = 2 * Math.sin((Math.PI * Math.min(f, RATE / 6)) / RATE);
    const input = noise();
    low += k * band;
    const high = input - low - q * band;
    band += k * high;
    bus.add(i, band * gain * env(x), pan + (panTo - pan) * x);
  }
}

/** A short tick: a bright click and a high, quick sine. */
function tick(bus: Bus, t0: number, gain: number, pan = 0, f = 2600) {
  sweep(bus, t0, 0.012, gain * 0.9, { from: 5000, to: 7000, q: 0.5, env: (x) => 1 - x, pan });
  partial(bus, f, t0, gain * 0.35, 0.025, pan);
}

// MARK: Reverb

/** A Freeverb-style room: eight combs and four all-passes a side, slightly apart. */
function reverb(input: Bus, size = 0.84, damp = 0.3): Bus {
  const out = new Bus(input.length);
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.round((n * RATE) / 44100));
  const passes = [556, 441, 341, 225].map((n) => Math.round((n * RATE) / 44100));
  for (const [side, spread] of [
    ["l", 0],
    ["r", 23],
  ] as const) {
    const src = input[side];
    const dst = out[side];
    for (const n0 of combs) {
      const n = n0 + spread;
      const buf = new Float32Array(n);
      let p = 0;
      let store = 0;
      for (let i = 0; i < src.length; i++) {
        const y = buf[p]!;
        store = y * (1 - damp) + store * damp;
        buf[p] = src[i]! * 0.015 + store * size;
        dst[i]! += y;
        p = (p + 1) % n;
      }
    }
    for (const n0 of passes) {
      const n = n0 + spread;
      const buf = new Float32Array(n);
      let p = 0;
      for (let i = 0; i < dst.length; i++) {
        const b = buf[p]!;
        const x = dst[i]!;
        buf[p] = x + b * 0.5;
        dst[i] = b - x;
        p = (p + 1) % n;
      }
    }
  }
  return out;
}

// MARK: The score

export function score({ duration, cues }: { duration: number; cues: Cue[] }): Bus {
  const length = S(duration + 2.5);
  const music = new Bus(length);
  const sfx = new Bus(length);
  const send = new Bus(length);
  const both = (fn: (b: Bus) => void, wet = 0.5) => {
    fn(sfx);
    const tmp = new Bus(length);
    fn(tmp);
    for (let i = 0; i < length; i++) {
      send.l[i]! += tmp.l[i]! * wet;
      send.r[i]! += tmp.r[i]! * wet;
    }
  };

  // The noise: a low drone that tightens, cut dead at the drop.
  const swell = (t: number) => Math.min(1, t / AT.drop) ** 1.6;
  pad(music, 26, 0, AT.drop - 0.02, 0.3, 2.5, 0.02, swell); // D1
  pad(music, 38, 0.5, AT.drop - 0.02, 0.32, 3, 0.02, swell); // D2
  pad(music, 45, 3, AT.drop - 0.02, 0.2, 3, 0.02, swell); // A2
  pad(music, 51, 5, AT.drop - 0.02, 0.12, 2.5, 0.02, swell); // Eb3: the rub that wants out

  // The name: the chord opens up over the arch, and rises into the light.
  const NAME = [38, 45, 50, 54, 57, 64]; // D2 A2 D3 F#3 A3 E4
  for (const m of NAME) pad(music, m, AT.name, AT.notch - 0.4, 0.22, 2.2, 0.6);

  // The groove, from the notch to the montage: four chords a bar each, I vi IV V in D.
  const CHORDS = [
    { bass: 38, notes: [57, 61, 64, 66] }, // D: A3 C#4 E4 F#4
    { bass: 35, notes: [54, 57, 62, 66] }, // Bm7: F#3 A3 D4 F#4
    { bass: 31, notes: [55, 59, 62, 66] }, // Gmaj7: G3 B3 D4 F#4
    { bass: 33, notes: [57, 61, 62, 64] }, // Asus: A3 C#4 D4 E4
  ];
  /** The pad ducks under each kick, so the pulse breathes. */
  const pump = (t: number) => {
    if (t < AT.notch || t >= AT.montage) return 1;
    const since = (t - AT.notch) % BEAT;
    return 1 - 0.38 * Math.exp(-since / 0.11);
  };
  for (let t = AT.notch, k = 0; t < AT.montage - 1e-6; t += BAR, k++) {
    const c = CHORDS[k % CHORDS.length]!;
    const last = t + BAR >= AT.montage - 1e-6;
    for (const m of c.notes) pad(music, m, t, t + BAR - 0.05, k === 0 ? 0.13 : 0.17, k === 0 ? 1.4 : 0.06, last ? 0.4 : 0.35, pump);
    // The bass, a plucked eighth pattern once the app is on screen.
    for (let b = 0; b < 8; b++) {
      const at = t + b * (BEAT / 2);
      if (at < AT.app && b % 2) continue;
      const g = at < AT.app ? 0.2 : b % 2 ? 0.12 : 0.22;
      partial(music, hz(c.bass + 12), at, g, 0.16, 0, 0.004);
      partial(music, hz(c.bass + 24), at, g * 0.18, 0.08, 0, 0.004);
    }
  }
  // Kicks on the beat; hats on the off-beats once the app is on screen.
  for (let t = AT.notch; t < AT.montage - 1e-6; t += BEAT) {
    kick(music, t, t < AT.app ? 0.28 : 0.36);
    if (t >= AT.app) sweep(music, t + BEAT / 2, 0.05, 0.15, { from: 7000, to: 9000, q: 0.3, env: (x) => (1 - x) ** 3, pan: 0.25 });
  }

  // The montage: a kick under every word, then the end card's chord, held into the fade.
  for (let t = AT.montage; t < AT.end - 1e-6; t += BEAT) kick(music, t, 0.5, 140, 48, 0.26);
  const END = [26, 38, 45, 50, 54, 57, 61, 64, 69];
  for (const m of END) pad(music, m, AT.end, duration - 1.6, m < 40 ? 0.18 : 0.16, 1.4, 2.2);

  // The cues.
  let n = 0;
  for (const c of cues) {
    const pan = Math.sin(n++ * 2.3) * 0.6;
    switch (c.kind) {
      case "tick": {
        const quiet = c.t < AT.drop ? 0.12 + 0.18 * swell(c.t) : 0.22;
        both((b) => tick(b, c.t, quiet, pan, 2200 + 900 * Math.abs(Math.sin(n))), 0.35);
        break;
      }
      case "drop":
        both((b) => kick(b, c.t, 0.9, 90, 36, 0.6), 0.9);
        break;
      case "hit":
        both((b) => {
          kick(b, c.t, 0.32, 160, 70, 0.12);
          sweep(b, c.t, 0.18, 0.12, { from: 2500, to: 1200, env: (x) => (1 - x) ** 2 });
        }, 0.5);
        break;
      case "impact":
        both((b) => {
          kick(b, c.t, 1, 90, 34, 0.9);
          sweep(b, c.t, 2.4, 0.5, { from: 3000, to: 180, env: (x) => (1 - x) ** 3 });
        }, 1);
        break;
      case "riser": {
        const v = c.v ?? 2;
        both((b) => {
          sweep(b, c.t, v, 0.38, { from: 300, to: 7000, q: 0.35, env: (x) => x ** 2.2 });
          pad(b, 62, c.t, c.t + v, 0.06, v * 0.9, 0.02);
        }, 0.6);
        break;
      }
      case "whoosh":
        both((b) => sweep(b, c.t, 0.7, 0.32, { from: 500, to: 3500, env: (x) => Math.sin(Math.PI * x) ** 2, pan: -0.5, panTo: 0.5 }), 0.4);
        break;
      case "push":
        both((b) => sweep(b, c.t - 0.05, 0.47, 0.34, { from: 900, to: 6000, q: 0.45, env: (x) => x ** 2 }), 0.5);
        break;
      case "swell":
        both((b) => sweep(b, c.t, 1.1, 0.2, { from: 250, to: 1600, env: (x) => Math.sin(Math.PI * Math.min(1, x * 1.6)) ** 2 }), 0.6);
        break;
      case "click":
        both((b) => tick(b, c.t, 0.5, 0.15, 1800), 0.25);
        break;
      case "chime":
        both((b) => {
          bell(b, 81, c.t, 0.13, -0.2); // A5
          bell(b, 88, c.t + 0.09, 0.1, 0.2); // E6
        }, 0.9);
        break;
      case "amber":
        both((b) => {
          bell(b, 74, c.t, 0.12, -0.15); // D5
          bell(b, 78, c.t + 0.11, 0.09, 0.15); // F#5
        }, 0.9);
        break;
    }
  }

  // The room, then everything to the stereo pair, faded out at the end.
  for (let i = 0; i < length; i++) {
    send.l[i]! += music.l[i]! * 0.28;
    send.r[i]! += music.r[i]! * 0.28;
  }
  // Lows stay out of the room, or it turns to mud.
  const hp = Math.exp((-2 * Math.PI * 220) / RATE);
  for (const ch of [send.l, send.r]) {
    let x0 = 0;
    let y0 = 0;
    for (let i = 0; i < length; i++) {
      const x = ch[i]!;
      y0 = hp * (y0 + x - x0);
      x0 = x;
      ch[i] = y0;
    }
  }
  const wet = reverb(send, 0.86, 0.32);
  const out = new Bus(length);
  const fade0 = duration - 2.2;
  for (let i = 0; i < length; i++) {
    const t = i / RATE;
    const fade = t < fade0 ? 1 : Math.max(0, 1 - (t - fade0) / 2.4) ** 2;
    out.l[i] = (music.l[i]! * 0.8 + sfx.l[i]! + wet.l[i]! * 0.9) * fade;
    out.r[i] = (music.r[i]! * 0.8 + sfx.r[i]! + wet.r[i]! * 0.9) * fade;
  }
  return out;
}

/** 24-bit stereo PCM. */
export function wav(bus: Bus): Buffer {
  let peak = 1e-9;
  for (let i = 0; i < bus.length; i++) peak = Math.max(peak, Math.abs(bus.l[i]!), Math.abs(bus.r[i]!));
  // Headroom only: loudness is set when the score is muxed (scripts/record.ts).
  const g = 0.7 / peak;
  const data = Buffer.alloc(bus.length * 6);
  for (let i = 0; i < bus.length; i++) {
    data.writeIntLE(Math.round(bus.l[i]! * g * 8388607), i * 6, 3);
    data.writeIntLE(Math.round(bus.r[i]! * g * 8388607), i * 6 + 3, 3);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 6, 28);
  h.writeUInt16LE(6, 32);
  h.writeUInt16LE(24, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

if (import.meta.main) {
  const [cuesFile, out] = process.argv.slice(2);
  if (!cuesFile || !out) {
    console.error("usage: bun scripts/score.ts <cues.json> <out.wav>");
    process.exit(2);
  }
  writeFileSync(out, wav(score(JSON.parse(readFileSync(cuesFile, "utf8")))));
  console.log(out);
}
