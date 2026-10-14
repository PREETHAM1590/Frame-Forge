import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwind(),
    {
      name: "development-csp",
      transformIndexHtml(html, context) {
        return context.server
          ? html.replace(
              "script-src 'self'",
              "script-src 'self' 'unsafe-inline'",
            )
          : html;
      },
    },
  ],
  build: {
    // The CSP is font-src 'self': a font inlined as a data: URI is blocked, so fonts always ship as files.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
  test: {
    maxWorkers: 2,
    testTimeout: 15000,
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    coverage: { provider: "v8" },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/windows/**",
        "**/.tools/**",
        "**/release/**",
        "**/dist-electron/**",
        "**/artifacts/**",
        "**/test-results/**",
      ],
    },
  },
});
