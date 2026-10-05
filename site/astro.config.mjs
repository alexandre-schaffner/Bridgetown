import { defineConfig } from "astro/config";

/**
 * The rigs the films and the hero frames are made with (src/dev/): pages in `astro dev`, and
 * nowhere in the build, so none of their code or styles ship.
 */
const devRigs = {
  name: "dev-rigs",
  hooks: {
    "astro:config:setup": ({ command, injectRoute }) => {
      if (command !== "dev") return;
      for (const rig of ["film", "launch", "render"]) {
        injectRoute({ pattern: `/${rig}`, entrypoint: `./src/dev/${rig}.astro` });
      }
    },
  },
};

export default defineConfig({
  devToolbar: { enabled: false },
  integrations: [devRigs],
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
