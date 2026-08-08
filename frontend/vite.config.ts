import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Two pages, one build: the product app (index.html) and the judge-facing
  // Flare rail-status page (flare.html). Both share api.ts and the CSS.
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        flare: "flare.html",
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
