import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "localhost",
    proxy: { "/api": "http://127.0.0.1:8787", "/captures": "http://127.0.0.1:8787" },
  },
});
