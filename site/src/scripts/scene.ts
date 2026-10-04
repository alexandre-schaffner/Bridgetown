// The arch in three dimensions: white marble voussoirs on two piers, standing on polished
// black stone, lit from behind. The light behind it is the app's Dock tile light, so it
// speaks the same states: cool white at rest, blue lamps while agents work, amber when
// something needs you, dim when paused. The page drives the camera; the scene only draws.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { ARCH } from "../lib/arch";
import { createAtmosphere, ShaftsShader } from "./atmosphere";

/** The arch in scene units: one unit is 100 of the icon's. */
const U = 1 / 100;
const R = ARCH.outer * U;
const r = ARCH.inner * U;
const PIER = ARCH.pier * U;
const KEY_RISE = ARCH.keyRise * U;
const KEY_DROP = ARCH.keyDrop * U;
const JOINT = 0.085;
const DEPTH = 1.15;
const VOUSSOIRS = 9;
export const FLOOR = -PIER;

const NIGHT = new THREE.Color("#050608");

export type LightName = "rest" | "working" | "needs-you" | "needs-you-working" | "paused" | "out";

interface Lamp {
  /** Along the ring, 0 at the left springing, 1 at the right. */
  at: number;
  level: number;
}

interface Light {
  color: THREE.Color;
  level: number;
  /** Blue lamps behind the ring: agents at work. */
  lamps: [Lamp, Lamp, Lamp];
}

const GLOW = new THREE.Color(0.62, 0.8, 1);
const BLUE = new THREE.Color(0.2, 0.6, 1);
const AMBER = new THREE.Color(1, 0.62, 0.2);
const WHITE = new THREE.Color(1, 1, 1);
const off: Lamp = { at: 0.5, level: 0 };

const LIGHTS: Record<LightName, Light> = {
  rest: { color: GLOW, level: 1, lamps: [off, off, off] },
  working: {
    color: GLOW,
    level: 0.85,
    lamps: [
      { at: 0.3, level: 1 },
      { at: 0.82, level: 1 },
      { at: 0.5, level: 0 },
    ],
  },
  "needs-you": { color: AMBER, level: 1.15, lamps: [off, off, off] },
  "needs-you-working": {
    color: AMBER,
    level: 1.05,
    lamps: [
      { at: 0.5, level: 1 },
      { at: 0.3, level: 0 },
      { at: 0.82, level: 0 },
    ],
  },
  paused: { color: GLOW.clone().lerp(WHITE, 0.5), level: 0.4, lamps: [off, off, off] },
  out: { color: GLOW, level: 0.05, lamps: [off, off, off] },
};

import { restView, type View } from "./view";
export { restView, type View };

// MARK: Geometry

/** One stone of the ring between two angles (y up: 0 right, π left), as a 2D shape. */
function sector(a0: number, a1: number, ri: number, ro: number): THREE.Shape {
  const g = JOINT / 2;
  const o0 = a0 + Math.asin(g / ro);
  const o1 = a1 - Math.asin(g / ro);
  const i0 = a0 + Math.asin(g / ri);
  const i1 = a1 - Math.asin(g / ri);
  const s = new THREE.Shape();
  s.moveTo(ro * Math.cos(o0), ro * Math.sin(o0));
  s.absarc(0, 0, ro, o0, o1, false);
  s.lineTo(ri * Math.cos(i1), ri * Math.sin(i1));
  s.absarc(0, 0, ri, i1, i0, true);
  s.closePath();
  return s;
}

function block(x0: number, y0: number, x1: number, y1: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(x0, y0);
  s.lineTo(x1, y0);
  s.lineTo(x1, y1);
  s.lineTo(x0, y1);
  s.closePath();
  return s;
}

/** Nine voussoirs, the middle one the keystone; two piers of two blocks each. */
function stones(): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  const step = Math.PI / VOUSSOIRS;
  for (let i = 0; i < VOUSSOIRS; i++) {
    const a0 = Math.PI - (i + 1) * step;
    const a1 = Math.PI - i * step;
    const key = i === (VOUSSOIRS - 1) / 2;
    shapes.push(sector(a0, a1, key ? r - KEY_DROP : r, key ? R + KEY_RISE : R));
  }
  const g = JOINT / 2;
  const mid = -PIER / 2;
  for (const [x0, x1] of [
    [-R, -r],
    [r, R],
  ]) {
    shapes.push(block(x0, -g, x1, mid + g));
    shapes.push(block(x0, mid - g, x1, -PIER));
  }
  return shapes;
}

// MARK: Textures

/** Fixed-seed random, so the marble is the same stone on every visit. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** White marble: soft clouds and a few grey veins that wander, like the icon's. */
function marble(): THREE.CanvasTexture {
  const size = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const rand = rng(0x9e3779b9);
  g.fillStyle = "#eeeff1";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const rad = 60 + rand() * 240;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    const tone = rand() < 0.5 ? "120,124,132" : "255,255,255";
    grad.addColorStop(0, `rgba(${tone},${0.025 + rand() * 0.04})`);
    grad.addColorStop(1, `rgba(${tone},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const vein = (width: number, alpha: number, blur: number) => {
    g.save();
    g.filter = blur ? `blur(${blur}px)` : "none";
    g.strokeStyle = `rgba(92,98,108,${alpha})`;
    g.lineWidth = width;
    g.lineCap = "round";
    g.lineJoin = "round";
    let x = rand() * size;
    let y = -40;
    let dir = Math.PI / 2 + (rand() - 0.5) * 1.4;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 260 && y < size + 40; s++) {
      dir += (rand() - 0.5) * 0.35;
      dir = Math.min(Math.PI - 0.35, Math.max(0.35, dir));
      x += Math.cos(dir) * 6;
      y += Math.sin(dir) * 6;
      g.lineTo(x, y);
      if (rand() < 0.012) {
        g.stroke();
        g.beginPath();
        g.moveTo(x, y);
        g.lineWidth = width * (0.5 + rand() * 0.6);
      }
    }
    g.stroke();
    g.restore();
  };
  for (let i = 0; i < 7; i++) {
    vein(12, 0.07, 7);
    vein(1.2 + rand() * 1.6, 0.45, 0);
  }
  for (let i = 0; i < 12; i++) vein(0.7, 0.18, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.repeat.set(0.22, 0.22);
  tex.anisotropy = 8;
  return tex;
}

/** A soft round falloff, white at the centre. */
function radial(stops: [number, number][]): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, a] of stops) grad.addColorStop(at, `rgba(255,255,255,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// MARK: Grade

/** Film grain, a vignette, and the flood to day at the end of the hero. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uWhite: { value: 0 },
    uDay: { value: new THREE.Vector3(1, 1, 1) },
    uGrain: { value: 0.022 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uWhite;
    uniform vec3 uDay;
    uniform float uGrain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      // A lens's colour fringe, only toward the edges.
      vec2 ca = d * dot(d, d) * 0.006;
      vec4 c = texture2D(tDiffuse, vUv);
      c.r = texture2D(tDiffuse, vUv + ca).r;
      c.b = texture2D(tDiffuse, vUv - ca).b;
      // Cool the shadows a touch, as moonlight would.
      float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb += vec3(-0.004, 0.004, 0.018) * (1.0 - smoothstep(0.0, 0.35, luma));
      float vig = smoothstep(0.85, 0.2, length(d * vec2(1.0, 1.15)));
      c.rgb *= mix(0.45, 1.0, vig);
      float n = hash(vUv * 1024.0 + fract(uTime) * 97.0) - 0.5;
      c.rgb += n * uGrain * (1.0 - uWhite);
      // The flood: light from the centre outward, then everything.
      float reach = smoothstep(0.0, 1.0, uWhite * 1.6 - length(d) * 0.9);
      c.rgb = mix(c.rgb, uDay, clamp(max(reach, smoothstep(0.75, 1.0, uWhite)), 0.0, 1.0));
      gl_FragColor = c;
    }
  `,
};

// MARK: Scene

export interface ArchScene {
  /** The camera the page wants; the scene eases toward it. */
  view: View;
  setLight(name: LightName, seconds?: number): void;
  /** Draw only while a night chapter is on screen. */
  setActive(active: boolean): void;
  /** Pointer in -1…1, for a little parallax. */
  setPointer(x: number, y: number): void;
  /** Jump to `view` with no easing (on load, after a resize). */
  snap(): void;
  /** The colour the hero floods to: the page's day, which the theme can change. */
  setDay(day: THREE.Color): void;
  /** One exact frame, for pre-rendering: this camera, this moment, this light, no easing. */
  still(view: View, time: number, light: LightName): void;
  /**
   * Compiles every shader and draws one frame unseen, so the first visible frame doesn't stall
   * the page. `beat` resolves when the page is free to take a short hitch.
   */
  prepare(beat: () => Promise<void>): Promise<void>;
  dispose(): void;
}

export function createArchScene(
  canvas: HTMLCanvasElement,
  {
    day,
    reducedMotion,
    onFirstFrame,
    ultra = false,
  }: {
    day: THREE.Color;
    reducedMotion: boolean;
    onFirstFrame?: () => void;
    /**
     * Offline quality for pre-rendered frames (scripts/render.ts): drawn at twice the size,
     * more fog and motes, twice the shaft samples, full-size mirror and light pass, no
     * baked grain (the page lays its own over the frames), and no frame loop.
     */
    ultra?: boolean;
  },
): ArchScene {
  const small = !ultra && Math.min(window.innerWidth, window.innerHeight) < 700;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  // Resolution is budgeted, not taken from the screen: a 5K display would otherwise ask for
  // fifteen million pixels a frame. Grain and bloom hide the upscale. See resize() and fit().
  const budget = ultra ? Infinity : small ? 1.6e6 : 4.2e6;
  let quality = 1;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = NIGHT;
  scene.fog = new THREE.FogExp2(NIGHT, 0.034);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.22;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 80);

  // The stones.
  const marbleMap = marble();
  const stoneMaterial = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color("#f4f5f7"),
    map: marbleMap,
    roughness: 0.34,
    clearcoat: 0.55,
    clearcoatRoughness: 0.22,
  });
  const arch = new THREE.Group();
  for (const shape of stones()) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: DEPTH,
      bevelEnabled: true,
      bevelThickness: 0.035,
      bevelSize: 0.022,
      bevelSegments: 4,
      curveSegments: 40,
    });
    geo.translate(0, 0, -DEPTH / 2);
    const mesh = new THREE.Mesh(geo, stoneMaterial);
    arch.add(mesh);
  }
  scene.add(arch);

  // Polished black stone underfoot: a mirror, darkened.
  const mirror = new Reflector(new THREE.PlaneGeometry(60, 60), {
    textureWidth: ultra ? window.innerWidth * 2 : Math.round(Math.min(window.innerWidth, 1600) * (small ? 0.4 : 0.6)),
    textureHeight: ultra ? window.innerHeight * 2 : Math.round(Math.min(window.innerHeight, 1000) * (small ? 0.4 : 0.6)),
    color: new THREE.Color("#7a808a"),
    clipBias: 0.003,
  });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = FLOOR;
  scene.add(mirror);
  const tint = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshBasicMaterial({ color: NIGHT, transparent: true, opacity: 0.5, depthWrite: false }),
  );
  tint.rotation.x = -Math.PI / 2;
  tint.position.y = FLOOR + 0.002;
  scene.add(tint);

  // The light behind: a wall of it far back, a pool on the floor, a lamp that lights the stones.
  const halo = radial([
    [0, 1],
    [0.18, 0.55],
    [0.45, 0.14],
    [1, 0],
  ]);
  const wallMat = new THREE.MeshBasicMaterial({
    map: halo,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(15, 15), wallMat);
  wall.position.set(0, 0.6, -7);
  scene.add(wall);

  const core = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 3.4),
    new THREE.MeshBasicMaterial({
      map: radial([
        [0, 1],
        [0.2, 0.6],
        [1, 0],
      ]),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    }),
  );
  core.position.set(0, FLOOR + 0.15, -2.6);
  scene.add(core);

  const poolMat = new THREE.MeshBasicMaterial({
    map: radial([
      [0, 1],
      [0.12, 0.7],
      [0.5, 0.12],
      [1, 0],
    ]),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.5), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, FLOOR + 0.01, -0.15);
  scene.add(pool);

  const backLight = new THREE.PointLight(GLOW, 30, 14, 1.6);
  backLight.position.set(0, FLOOR + 0.9, -1.6);
  scene.add(backLight);

  // Front: a low, cool fill so the marble reads white without looking lit from the front.
  const hemi = new THREE.HemisphereLight(new THREE.Color("#c8d4e6"), new THREE.Color("#050608"), 0.38);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(new THREE.Color("#eef2ff"), 0.95);
  key.position.set(-4, 7, 6);
  scene.add(key);

  // Lamps: blue lights behind the ring, each with a halo the bloom picks up.
  const lampTex = radial([
    [0, 1],
    [0.25, 0.35],
    [1, 0],
  ]);
  const lamps = [0, 1, 2].map(() => {
    const light = new THREE.PointLight(BLUE, 0, 7, 1.5);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: lampTex,
        color: BLUE,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        opacity: 0,
      }),
    );
    sprite.scale.setScalar(3.4);
    scene.add(light, sprite);
    return { light, sprite };
  });
  const placeLamp = (i: number, at: number) => {
    const a = Math.PI * (1 - at);
    const rad = R + 0.15;
    const x = rad * Math.cos(a);
    const y = rad * Math.sin(a);
    lamps[i]!.light.position.set(x, y, -1.2);
    lamps[i]!.sprite.position.set(x, y, -1.9);
  };

  // The air: mist, a far haze, motes in the beam.
  const air = createAtmosphere({ floor: FLOOR, small, ultra });
  scene.add(air.group);

  // The mirror shows the stone and the light, not the air: reflecting the mist and motes
  // would draw them twice for something the darkened floor mostly hides.
  const reflect = mirror.onBeforeRender.bind(mirror);
  mirror.onBeforeRender = (...args: Parameters<typeof reflect>) => {
    air.group.visible = false;
    reflect(...args);
    air.group.visible = true;
  };

  // Post.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const shafts = new ShaderPass(ShaftsShader);
  shafts.uniforms.uSamples!.value = ultra ? 80 : small ? 28 : 40;
  // The light alone, the arch black in front of it, at half size: what the shafts scatter.
  const lightTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  shafts.uniforms.tLight!.value = lightTarget.texture;
  const silhouette = new THREE.MeshBasicMaterial({ color: 0x000000 });
  // A small sun behind the ring, seen only by this pass: light that breaks through the opening
  // and leaks between the stones.
  const sunMat = new THREE.SpriteMaterial({
    map: radial([
      [0, 1],
      [0.3, 0.5],
      [1, 0],
    ]),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const sun = new THREE.Sprite(sunMat);
  sun.scale.setScalar(5);
  sun.position.set(0, 0.15, -2.2);
  sun.visible = false;
  scene.add(sun);
  const lightOnly = [sun, core, ...lamps.map((l) => l.sprite)];
  // Everything the light pass leaves out, found once: the scene doesn't change shape.
  const hidden: THREE.Object3D[] = [];
  const renderLight = () => {
    if (!hidden.length) {
      scene.traverse((o) => {
        if (o === scene || o === arch || arch.children.includes(o as THREE.Mesh) || lightOnly.includes(o as never)) return;
        if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) hidden.push(o);
      });
    }
    hidden.forEach((o) => (o.visible = false));
    sun.visible = true;
    const fog = scene.fog;
    scene.fog = null;
    for (const m of arch.children as THREE.Mesh[]) m.material = silhouette;
    renderer.setRenderTarget(lightTarget);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    for (const m of arch.children as THREE.Mesh[]) m.material = stoneMaterial;
    scene.fog = fog;
    sun.visible = false;
    hidden.forEach((o) => (o.visible = true));
  };
  composer.addPass(shafts);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.7, 0.7);
  composer.addPass(bloom);
  // Graded after output, in display colour, so the flood lands exactly on the page's day.
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  const { r: dr, g: dg, b: db } = day.getRGB({ r: 1, g: 1, b: 1 }, THREE.SRGBColorSpace);
  grade.uniforms.uDay!.value = new THREE.Vector3(dr, dg, db);
  if (ultra) grade.uniforms.uGrain!.value = 0;
  composer.addPass(grade);

  // State.
  const source = new THREE.Vector3();
  const view = restView();
  const eased = restView();
  const pointer = { x: 0, y: 0, ex: 0, ey: 0 };
  const light = {
    color: LIGHTS.rest.color.clone(),
    level: 0,
    lamps: LIGHTS.rest.lamps.map((l) => ({ ...l })),
  };
  let target: Light = LIGHTS.rest;
  let lightSpeed = 1.6;
  let active = true;
  let raf = 0;
  let last = performance.now();
  let first = true;

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    // The screen's density, held under the pixel budget, then scaled by how the frames are going.
    const ratio = ultra ? 2 : Math.min(window.devicePixelRatio, 2, Math.sqrt(budget / (w * h))) * quality;
    renderer.setPixelRatio(ratio);
    composer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    const lightScale = ultra ? 0.75 : 0.4;
    lightTarget.setSize(Math.round(w * ratio * lightScale), Math.round(h * ratio * lightScale));
    bloom.resolution.set(w * ratio, h * ratio);
    camera.aspect = w / h;
    // Narrow screens: widen the lens so the arch keeps its margins.
    camera.fov = camera.aspect < 0.8 ? 46 : camera.aspect < 1.2 ? 38 : 32;
    camera.updateProjectionMatrix();
  }

  /** The light behind the arch breathes, very slowly. */
  let breath = 1;

  function applyLight(dt: number) {
    const k = 1 - Math.exp(-dt * lightSpeed * 2.2);
    light.color.lerp(target.color, k);
    light.level += (target.level - light.level) * k;
    light.lamps.forEach((lamp, i) => {
      const t = target.lamps[i]!;
      lamp.level += (t.level - lamp.level) * k;
      if (t.level > 0.01) lamp.at += (t.at - lamp.at) * k;
    });

    const lv = light.level * breath;
    // The front fill dims with the light behind, so paused and out read as dimmer stone.
    const front = 0.45 + 0.55 * Math.min(1, lv);
    key.intensity = 0.95 * front;
    hemi.intensity = 0.38 * front;
    wallMat.color.copy(light.color).multiplyScalar(0.34 * lv);
    (core.material as THREE.MeshBasicMaterial).color.copy(light.color).multiplyScalar(0.8 * lv);
    poolMat.color.copy(light.color).lerp(WHITE, 0.45).multiplyScalar(1.15 * lv);
    backLight.color.copy(light.color);
    backLight.intensity = 14 * lv;
    light.lamps.forEach((lamp, i) => {
      placeLamp(i, lamp.at);
      lamps[i]!.light.intensity = 26 * lamp.level;
      lamps[i]!.sprite.material.opacity = 0.85 * lamp.level;
    });
  }

  // Adaptive resolution: if frames run long for a second, draw fewer pixels; if they've been
  // comfortable for a while, try a few more. Waits after a drop so it doesn't see-saw.
  let slow = 0;
  let calm = 0;
  let hold = 0;
  function fit(dt: number) {
    if (dt <= 0 || dt > 0.25) return;
    hold = Math.max(0, hold - dt);
    if (dt > 1 / 45) {
      slow += dt;
      calm = 0;
    } else {
      calm += dt;
      slow = Math.max(0, slow - dt * 0.5);
    }
    if (slow > 0.8 && quality > 0.55) {
      quality = Math.max(0.55, quality * 0.82);
      slow = 0;
      hold = 8;
      resize();
    } else if (calm > 6 && hold === 0 && quality < 1) {
      quality = Math.min(1, quality * 1.1);
      calm = 0;
      resize();
    }
  }

  /** Everything after the camera has been placed: lights, air, shafts, grade, and the render. */
  function draw(t: number, dt: number, sway: number) {
    camera.position.set(
      eased.x + pointer.ex * 0.55 * sway + Math.sin(t * 0.21) * 0.08 * sway,
      eased.y + pointer.ey * 0.25 * sway + Math.sin(t * 0.17) * 0.05 * sway,
      eased.z,
    );
    camera.lookAt(eased.lookX, eased.lookY, eased.lookZ);

    breath = reducedMotion ? 1 : 1 + 0.07 * Math.sin(t * 0.7) + 0.03 * Math.sin(t * 1.93 + 1.3);
    applyLight(dt);
    air.update(reducedMotion ? 12 : t, light.color, light.level * breath, camera);

    // Shafts pour from the light behind the opening while it is in front of the camera.
    sunMat.color.copy(light.color).multiplyScalar(0.55 * light.level * breath);
    source.copy(sun.position).project(camera);
    const facing = source.z < 1 ? 1 : 0;
    shafts.uniforms.uSource!.value.set(source.x * 0.5 + 0.5, source.y * 0.5 + 0.5);
    shafts.uniforms.uStrength!.value = (small ? 0.75 : 0.95) * facing * (1 - eased.white);
    if (shafts.uniforms.uStrength!.value > 0.001) renderLight();
    bloom.strength = 0.6 + eased.flare * 1.6;
    renderer.toneMappingExposure = 1 + eased.flare * 1.6;
    grade.uniforms.uWhite!.value = eased.white;
    grade.uniforms.uTime!.value = t;

    composer.render(dt);
    if (first) {
      first = false;
      onFirstFrame?.();
    }
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!active) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    fit((now - last) / 1000);
    last = now;

    // Ease the camera toward where the page wants it; Lenis already smooths the scroll.
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 7);
    for (const key of Object.keys(view) as (keyof View)[]) eased[key] += (view[key] - eased[key]) * k;
    pointer.ex += (pointer.x - pointer.ex) * (1 - Math.exp(-dt * 2.5));
    pointer.ey += (pointer.y - pointer.ey) * (1 - Math.exp(-dt * 2.5));
    draw(now / 1000, dt, reducedMotion ? 0 : 1 - eased.flare);
  }

  resize();
  applyLight(0);
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  if (!ultra) raf = requestAnimationFrame(frame);

  return {
    view,
    setLight(name, seconds = 1.2) {
      target = LIGHTS[name];
      lightSpeed = 1 / Math.max(0.05, seconds);
    },
    setActive(next) {
      if (next && !active) last = performance.now();
      active = next;
    },
    setPointer(x, y) {
      pointer.x = x;
      pointer.y = y;
    },
    snap() {
      Object.assign(eased, view);
    },
    still(v, time, name) {
      Object.assign(view, v);
      Object.assign(eased, v);
      target = LIGHTS[name];
      light.color.copy(target.color);
      light.level = target.level;
      light.lamps.forEach((lamp, i) => Object.assign(lamp, target.lamps[i]));
      draw(time, 1 / 60, 0);
    },
    async prepare(beat) {
      // The stones and the floor compile off the main thread where the browser can; the
      // post-processing passes compile on the one warm frame after.
      await beat();
      await renderer.compileAsync(scene, camera);
      await beat();
      const t = performance.now() / 1000;
      Object.assign(eased, view);
      draw(t, 1 / 60, 0);
      last = performance.now();
    },
    setDay(next) {
      const { r, g, b } = next.getRGB({ r: 1, g: 1, b: 1 }, THREE.SRGBColorSpace);
      (grade.uniforms.uDay!.value as THREE.Vector3).set(r, g, b);
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
    },
  };
}
