import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  server: { host: "127.0.0.1" },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    headers: {
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://archive.org https://*.archive.org; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
});
