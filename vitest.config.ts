import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests don't start the Cloudflare dev runtime.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
