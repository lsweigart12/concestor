import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API is the Go serving binary (see ../server). Proxying in dev keeps the
// client's fetch paths identical to production, where the same binary serves
// both the artifacts and the built frontend out of web/dist.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/v1": { target: "http://127.0.0.1:8080", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
