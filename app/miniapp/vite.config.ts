import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Штамп сборки: по нему видно, доехала ли новая версия до сервера.
// Значение попадает в бандл и печатается в консоль при старте.
const BUILD = process.env.BUILD_ID ?? new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: { outDir: "dist", sourcemap: false },
});
