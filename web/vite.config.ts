import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Local `npm run dev` loads `.env.development` with VITE_API_URL pointing at the
 * hosted Worker. The SPA calls that origin directly (credentials + CORS).
 * Optional proxy remains for same-origin experiments without VITE_API_URL.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_URL || "https://vibehub.devpost67.workers.dev";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: env.VITE_API_URL
        ? undefined
        : {
            "/api": { target: apiTarget, changeOrigin: true, secure: true },
            "/auth": { target: apiTarget, changeOrigin: true, secure: true },
            "/scoping-prompt": { target: apiTarget, changeOrigin: true, secure: true },
            "/workflow": { target: apiTarget, changeOrigin: true, secure: true },
            "/authorize": { target: apiTarget, changeOrigin: true, secure: true },
            "/oauth": { target: apiTarget, changeOrigin: true, secure: true },
            "/mcp": { target: apiTarget, changeOrigin: true, secure: true },
            "/.well-known": { target: apiTarget, changeOrigin: true, secure: true },
          },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
