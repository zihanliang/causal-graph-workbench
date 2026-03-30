import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
function normalizeBasePath(basePath) {
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
            proxy: {
                "/api": {
                    target: "http://127.0.0.1:8000",
                    changeOrigin: true,
                },
            },
        },
        test: {
            environment: "jsdom",
        },
    };
});
