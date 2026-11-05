import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

function normalizeBasePath(basePath: string | undefined): string {
  const trimmed = (basePath ?? "/").trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    base: normalizeBasePath(env.VITE_BASE_PATH),
    plugins: [react()],
    server: {
      port: 5173,
    },
    worker: {
      format: "es",
    },
    test: {
      environment: "jsdom",
    },
  };
});
