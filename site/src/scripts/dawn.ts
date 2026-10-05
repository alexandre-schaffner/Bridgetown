// The hero's light, drawn by one fragment shader: the dark limb of a world low in the frame,
// day breaking along its edge where the pointer is, silk of light drifting above it. It rises
// as you scroll, backlights the board, and at the end floods the frame with the day the next
// chapter is lit by. Plain WebGL, so the page's first screen never waits on three.js.

export interface DawnState {
  /** Seconds, for the drift; held still under Reduce Motion. */
  time: number;
  /** The hero's scroll progress, 0 to 1. */
  scroll: number;
  /** The dawn coming up on arrival, 0 to 1. */
  intro: number;
  /** Day filling the frame from the sun outward, 0 to 1. */
  flood: number;
  /** The pointer, -1 to 1 across the screen (y down), eased. */
  pointer: [number, number];
  /** The board's rectangle in CSS pixels, and how present it is (0 to 1). */
  board: DOMRect | null;
  boardOn: number;
}

export interface Dawn {
  render(s: DawnState): void;
  setDay(rgb: [number, number, number]): void;
}

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uScroll;
uniform float uIntro;
uniform float uFlood;
uniform vec2 uPointer;
uniform vec3 uDay;
uniform vec4 uBoard;
uniform float uBoardOn;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

float roundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  // Centred, a unit is the screen's height, y up.
  vec2 p = (frag - 0.5 * uRes) / uRes.y;
  float t = uTime;
  float aspect = uRes.x / uRes.y;

  // The limb: a great dark circle below the frame, its edge rising with the dawn and the scroll.
  float R = 1.7 + 0.35 * aspect;
  float edge = mix(-0.66, -0.36, uIntro) + uScroll * 0.16;
  vec2 c = vec2(0.0, edge - R);
  float d = length(p - c) - R;
  float sky = max(d, 0.0);

  // The sun sits on the edge, where the pointer is, and day breaks around it.
  float sx = uPointer.x * 0.32 * aspect;
  vec2 sun = vec2(sx, edge - (R - sqrt(max(R * R - sx * sx, 0.0))));
  float along = (p.x - sx) / aspect;
  float hot = exp(-along * along * 9.0);
  float warm = exp(-along * along * 1.6);

  vec3 white = vec3(0.93, 0.955, 1.0);
  vec3 blue = vec3(0.22, 0.42, 1.0);
  vec3 col = vec3(0.0);

  // Air above the edge: a wide cool scatter, brighter toward the sun.
  float air = exp(-sky * 2.6) * (0.18 + 0.82 * warm);
  col += blue * air * 0.32;
  col += mix(blue, white, 0.55) * exp(-sky * 8.0) * warm * 0.42;

  // Silk: light drifting in folds above the edge, bent toward the pointer.
  vec2 q = vec2(p.x * 0.9 - uPointer.x * 0.06, sky * 2.6 + uPointer.y * 0.04);
  vec2 w = vec2(fbm(q * 1.4 + vec2(0.0, t * 0.045)), fbm(q * 1.4 + vec2(5.2, -t * 0.038)));
  float f = fbm(q * 2.1 + w * 2.2 + vec2(t * 0.025, -t * 0.01));
  float silk = smoothstep(0.52, 0.98, f) * exp(-sky * 1.5) * step(0.0, d);
  col += mix(white, blue, 0.4) * silk * (0.1 + 0.5 * air);

  // The edge itself: a hairline of light, thickest and whitest at the sun.
  float rim = exp(-abs(d) * mix(150.0, 48.0, hot)) * (0.22 + 1.1 * hot);
  col += white * rim * 1.3;

  // The sun, and a long thin streak through it, as a lens would see it.
  float r = length((p - sun) * vec2(1.0, 1.6));
  col += white * exp(-r * 24.0) * 1.2;
  col += white * exp(-abs(p.y - sun.y) * 160.0) * exp(-abs(p.x - sx) * 2.6) * 0.3;

  // The world below the edge: black, with the faintest sheen along it.
  col += white * step(d, 0.0) * exp(d * 22.0) * 0.05 * (0.3 + hot);

  // Light from behind the board, spilling past its edges.
  if (uBoardOn > 0.001) {
    vec2 bp = (frag - uBoard.xy) / uRes.y;
    vec2 bs = uBoard.zw / uRes.y;
    float bd = roundRect(bp, bs, 0.02);
    float spill = exp(-max(bd, 0.0) * 7.0) * step(0.0, bd);
    float lip = exp(-max(bd, 0.0) * 55.0) * step(0.0, bd);
    col += mix(white, blue, 0.5) * spill * 0.16 * uBoardOn;
    col += white * lip * 0.22 * uBoardOn;
  }

  // A soft roll-off, so the brightest light never clips to a flat white.
  col = 1.0 - exp(-col * 1.35);
  col *= uIntro;

  // Day, from the sun outward. Light runs ahead of its front, so the night it crosses
  // brightens on the way instead of greying into it. On a dark day there is nothing to run ahead.
  float reach = uFlood * 3.0;
  float dist = length((p - sun) * vec2(0.8, 1.0));
  float day = smoothstep(reach, reach - 0.6, dist) * smoothstep(0.0, 0.12, uFlood);
  float lum = dot(uDay, vec3(0.2126, 0.7152, 0.0722));
  float ahead = exp(-max(dist - reach + 0.3, 0.0) * 2.6) * smoothstep(0.0, 0.25, uFlood) * lum;
  col += mix(white, blue, 0.3) * ahead * (1.0 - day) * 0.6;
  col = mix(col, uDay, clamp(day, 0.0, 1.0));

  // Dither, so the long gradients never band.
  col += (hash(frag + fract(t * 7.3)) - 0.5) / 160.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createDawn(canvas: HTMLCanvasElement): Dawn | null {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, powerPreference: "high-performance" });
  if (!gl) return null;

  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const program = gl.createProgram()!;
  try {
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
  } catch {
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name);
  const uRes = u("uRes");
  const uTime = u("uTime");
  const uScroll = u("uScroll");
  const uIntro = u("uIntro");
  const uFlood = u("uFlood");
  const uPointer = u("uPointer");
  const uDay = u("uDay");
  const uBoard = u("uBoard");
  const uBoardOn = u("uBoardOn");

  // The light is soft everywhere but the edge, so it is drawn under the screen's density and
  // scaled up; slow frames draw fewer pixels still.
  let quality = 1;
  let slow = 0;
  let last = performance.now();
  const size = () => {
    const ratio = Math.min(devicePixelRatio, 2) * 0.6 * quality;
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    return ratio;
  };

  return {
    setDay([r, g, b]) {
      gl.uniform3f(uDay, r, g, b);
    },
    render(s) {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (dt > 0 && dt < 250) {
        slow = dt > 24 ? slow + 1 : Math.max(0, slow - 0.5);
        if (slow > 30 && quality > 0.5) {
          quality *= 0.8;
          slow = 0;
        }
      }
      const ratio = size();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, s.time);
      gl.uniform1f(uScroll, s.scroll);
      gl.uniform1f(uIntro, s.intro);
      gl.uniform1f(uFlood, s.flood);
      gl.uniform2f(uPointer, s.pointer[0], s.pointer[1]);
      gl.uniform1f(uBoardOn, s.board ? s.boardOn : 0);
      if (s.board) {
        const b = s.board;
        // Centre and half size in the canvas's pixels, y up.
        gl.uniform4f(
          uBoard,
          (b.left + b.width / 2) * ratio,
          canvas.height - (b.top + b.height / 2) * ratio,
          (b.width / 2) * ratio,
          (b.height / 2) * ratio,
        );
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
