import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API is the Go serving binary (see ../server). Proxying in dev keeps the
// client's fetch paths identical to production, where the same binary serves
// both the artifacts and the built frontend out of web/dist.
//
// Both the port and the proxy target come from the environment, because one
// checkout is no longer the only place this runs: each git worktree gets its
// own session, its own dev server and its own API, so neither can be a fixed
// number. `scripts/dev.sh` sets both. The fallbacks are what a bare
// `npm run dev` alongside `scripts/serve.sh` has always used.
// The only node global this project uses. `@types/node` is deliberately not a
// dependency: one tsconfig covers both this file and src/, and src/ is
// browser-only, so installing it would make node's globals visible to the app
// as well.
declare const process: { env: Record<string, string | undefined> };

const port = Number(process.env.PORT ?? 5173);
const apiTarget = process.env.CONCESTOR_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    // Fail rather than drift to the next free port. Whoever opened the
    // preview is looking at `port`; moving silently means they are looking at
    // another worktree's app, or at nothing.
    strictPort: true,
    proxy: { "/v1": { target: apiTarget, changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true },
});
