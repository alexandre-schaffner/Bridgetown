// The air around the arch: mist that drifts and takes the colour of the light, motes rising
// through the beam, a far haze, and the shafts the light throws through the opening. All
// of it moves on the GPU from one time uniform, which stands still under Reduce Motion.

import * as THREE from "three";

/** Value-noise fbm, shared by the mist and the haze; `octaves` trades detail for speed. */
const noise = (octaves: number) => /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < ${octaves}; i++) { v += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
    return v;
  }
`;

export interface Atmosphere {
  group: THREE.Group;
  /** Time, the light's colour and level, and where the camera is (for fading what it walks through). */
  update(time: number, color: THREE.Color, level: number, camera: THREE.Camera): void;
}

export function createAtmosphere({ floor, small, ultra = false }: { floor: number; small: boolean; ultra?: boolean }): Atmosphere {
  const group = new THREE.Group();
  const NOISE = noise(ultra ? 6 : 4);
  const shared = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color() },
    uLevel: { value: 1 },
    uCamera: { value: new THREE.Vector3() },
    uFloor: { value: floor },
    // More cards when ultra, each a little thinner, so the fog is finer but no denser.
    uDensity: { value: ultra ? 0.6 : 1 },
  };

  // MARK: Mist

  // Cards of fog standing across the view, thickest at the floor; each glows where it is
  // near the light behind the arch. None crosses the stones, so no edge shows where they meet.
  const mistMaterial = new THREE.ShaderMaterial({
    uniforms: shared,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLevel, uFloor, uDensity;
      uniform vec3 uColor, uCamera;
      varying vec3 vWorld;
      varying vec2 vUv;
      ${NOISE}
      void main() {
        float h = vWorld.y - uFloor;
        vec2 p = vec2(vWorld.x * 0.32 + vWorld.z * 0.21, h * 0.55);
        // Two drifts folded into one lookup: the field moves, and its detail moves faster.
        vec2 drift = vec2(uTime * 0.035, -uTime * 0.012);
        float n = fbm(p + drift + 0.35 * vec2(sin(uTime * 0.11 + p.y), cos(uTime * 0.09 + p.x)));
        n = smoothstep(0.3, 0.85, n);
        float ground = exp(-h * 1.5);
        float sides = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
        // Nearer the light, brighter and its colour; far off, a cool grey breath.
        vec3 toLight = vWorld - vec3(0.0, uFloor + 0.6, -2.6);
        float lit = exp(-dot(toLight.xz, toLight.xz) * 0.06) * (0.6 + 0.4 * exp(-h * 0.8));
        float near = smoothstep(0.6, 3.2, distance(vWorld, uCamera));
        vec3 col = mix(vec3(0.5, 0.58, 0.7) * 0.012, uColor * 0.36, lit * lit) * uLevel;
        gl_FragColor = vec4(col * n * ground * sides * near * uDensity, 1.0);
      }
    `,
  });
  const cards = ultra
    ? [-6.5, -5.2, -4, -2.9, -1.6, 1.3, 2.2, 3.1, 4.2]
    : small
      ? [-4.6, -1.8, 2]
      : [-6, -3.6, -1.6, 1.5, 3.4];
  for (const z of cards) {
    const card = new THREE.Mesh(new THREE.PlaneGeometry(26, 3.2), mistMaterial);
    card.position.set((z * 1.7) % 3, floor + 1.45, z);
    group.add(card);
  }

  // MARK: Haze

  // Far behind: slow cloud lit from below by the same light, so the dark has depth.
  const haze = new THREE.Mesh(
    new THREE.PlaneGeometry(70, 34),
    new THREE.ShaderMaterial({
      uniforms: shared,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime, uLevel;
        uniform vec3 uColor;
        varying vec2 vUv;
        ${NOISE}
        void main() {
          vec2 p = (vUv - 0.5) * vec2(5.0, 2.4);
          float a = uTime * 0.01;
          p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
          float n = fbm(p + vec2(0.0, uTime * 0.008));
          n = pow(n, 2.4);
          float glow = exp(-pow(length((vUv - vec2(0.5, 0.36)) * vec2(1.4, 2.2)), 2.0) * 3.0);
          vec3 col = mix(vec3(0.3, 0.42, 0.62) * 0.05, uColor * 0.4, glow) * n * (0.15 + glow) * uLevel;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    }),
  );
  haze.position.set(0, floor + 7, -16);
  group.add(haze);

  // MARK: Motes

  // Specks rising and turning in the air, each its own size and twinkle, brightest in the beam.
  const count = ultra ? 1800 : small ? 450 : 1100;
  const base = new Float32Array(count * 3);
  const seed = new Float32Array(count * 2);
  let s = 0x2545f491;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    // Concentrated around the opening and the light behind it.
    const spread = rand() < 0.65 ? 2.2 : 7;
    base[i * 3] = (rand() - 0.5) * spread * 2;
    base[i * 3 + 1] = rand() * 6.5;
    base[i * 3 + 2] = -5 + rand() * 9;
    seed[i * 2] = rand();
    seed[i * 2 + 1] = rand();
  }
  const motesGeo = new THREE.BufferGeometry();
  motesGeo.setAttribute("position", new THREE.BufferAttribute(base, 3));
  motesGeo.setAttribute("seed", new THREE.BufferAttribute(seed, 2));
  const motes = new THREE.Points(
    motesGeo,
    new THREE.ShaderMaterial({
      uniforms: { ...shared, uScale: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime, uFloor, uScale;
        attribute vec2 seed;
        varying float vGlow;
        varying float vTwinkle;
        void main() {
          vec3 p = position;
          float speed = 0.05 + seed.x * 0.12;
          p.y = uFloor + mod(p.y + uTime * speed, 6.5);
          float swirl = uTime * (0.15 + seed.y * 0.25) + seed.x * 6.28;
          p.x += sin(swirl) * (0.25 + seed.y * 0.5);
          p.z += cos(swirl * 0.8) * 0.3;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // In the beam: near the axis of the opening, behind and just in front of it.
          float beam = exp(-p.x * p.x * 0.35) * smoothstep(-6.0, -1.0, p.z) * smoothstep(3.5, 0.5, p.z);
          vGlow = 0.18 + beam * 1.4;
          vTwinkle = 0.55 + 0.45 * sin(uTime * (1.2 + seed.y * 2.5) + seed.x * 40.0);
          // Fade at the top of their climb and right at the floor.
          vGlow *= smoothstep(0.0, 0.4, p.y - uFloor) * smoothstep(6.5, 5.0, p.y - uFloor);
          gl_PointSize = (1.2 + seed.y * seed.y * 4.5) * uScale * (6.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uLevel;
        varying float vGlow;
        varying float vTwinkle;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          a *= a;
          vec3 col = mix(vec3(0.85, 0.9, 1.0), uColor, 0.6) * vGlow * vTwinkle * (0.25 + uLevel);
          gl_FragColor = vec4(col * a, 1.0);
        }
      `,
    }),
  );
  motes.frustumCulled = false;
  group.add(motes);

  return {
    group,
    update(time, color, level, camera) {
      shared.uTime.value = time;
      shared.uColor.value.copy(color);
      shared.uLevel.value = level;
      shared.uCamera.value.copy(camera.position);
      const dpr = Math.min(window.devicePixelRatio, 2);
      (motes.material as THREE.ShaderMaterial).uniforms.uScale!.value = dpr * (window.innerHeight / 900);
    },
  };
}

// MARK: Shafts

/**
 * Light scattering: the light sources alone are drawn into `tLight` at half size, with the
 * arch as a black silhouette in front of them; each pixel then gathers that light along the
 * line to the source. The beams pour through the opening and fan out round the stones, and
 * nothing else in the frame can throw one.
 */
export const ShaftsShader = {
  uniforms: {
    tDiffuse: { value: null },
    tLight: { value: null as THREE.Texture | null },
    uSource: { value: new THREE.Vector2(0.5, 0.4) },
    uStrength: { value: 0.6 },
    uSamples: { value: 56 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tLight;
    uniform vec2 uSource;
    uniform float uStrength;
    uniform int uSamples;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uStrength <= 0.001) { gl_FragColor = base; return; }
      vec2 delta = (uSource - vUv) / float(uSamples) * 0.95;
      vec2 uv = vUv + delta * hash(vUv * 1000.0);
      float decay = 1.0;
      vec3 sum = vec3(0.0);
      for (int i = 0; i < 80; i++) {
        if (i >= uSamples) break;
        uv += delta;
        sum += texture2D(tLight, uv).rgb * decay;
        decay *= 0.958;
      }
      gl_FragColor = vec4(base.rgb + sum / float(uSamples) * uStrength, base.a);
    }
  `,
};
