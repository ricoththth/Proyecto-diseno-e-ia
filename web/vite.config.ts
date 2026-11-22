import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base relativa: funciona en GitHub Pages, Vercel o cualquier hosting estático.
export default defineConfig({ base: "./", plugins: [react(), tailwindcss()] });
