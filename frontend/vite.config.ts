import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Vite 8 loads the config natively, where import.meta.dirname is available and
// __dirname is not.
const root = path.resolve(import.meta.dirname);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      // The one implementation of canonical JSON, the capture manifest and
      // SHA-256, shared with the phone app and the API (docs/DECISIONS.md D-07).
      "@nyaysetu/integrity": path.resolve(root, "..", "packages", "integrity", "src", "index.ts"),
    },
  },
  server: {
    port: 5173,
    // The shared package lives outside this folder.
    fs: { allow: [path.resolve(root, "..")] },
    // Proxying /api in development means the browser sees one origin, so
    // SameSite=Strict cookies work without any CORS relaxation at all.
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  preview: { port: 4173 },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        /**
         * The landing page pulls a video and several font families, so keeping
         * vendor code in its own chunks means a portal's first paint does not
         * wait on the whole bundle.
         *
         * A function rather than an object: Vite 8 bundles with rolldown, which
         * only accepts the function form.
         */
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return "react";
          }
          if (id.includes("node_modules/lucide-react")) return "icons";
          return undefined;
        },
      },
    },
  },
});
