import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      "@scene/contract": "/src/__stub__/contract.ts",
      "@scene/domain": "/src/__stub__/domain.ts",
    },
  },
});