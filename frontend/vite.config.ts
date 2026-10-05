// Plugins
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Utilities
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    outDir: "target/dist",
    emptyOutDir: true
  },
  plugins: [vue(), tailwindcss()],
  define: { "process.env": {} },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    },
    extensions: [".js", ".json", ".jsx", ".mjs", ".ts", ".tsx", ".vue"]
  },
  server: {
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:8080"
    }
  }
});
