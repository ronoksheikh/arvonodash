import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  // Dev only: *.localtest.me resolves to 127.0.0.1, so the e2e tests can try the tracking-domain routing.
  server: { allowedHosts: [".localtest.me"] },
});
