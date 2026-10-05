import { defineConfig } from "astro/config";

export default defineConfig({
  devToolbar: { enabled: false },
  vite: {
    // three.js is one ~740 kB chunk on its own, loaded after the page is interactive.
    build: { chunkSizeWarningLimit: 800 },
    // Declared up front so the dev server doesn't re-optimize (and reload) on first visit.
    optimizeDeps: {
      include: [
        "three",
        "three/addons/postprocessing/EffectComposer.js",
        "three/addons/postprocessing/RenderPass.js",
        "three/addons/postprocessing/UnrealBloomPass.js",
        "three/addons/postprocessing/ShaderPass.js",
        "three/addons/postprocessing/OutputPass.js",
        "three/addons/objects/Reflector.js",
        "three/addons/environments/RoomEnvironment.js",
        "gsap",
        "gsap/ScrollTrigger",
        "lenis",
      ],
    },
  },
});
