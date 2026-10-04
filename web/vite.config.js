import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Serves /api/scrape from server/handler.ts during `npm run dev`, mirroring the Vercel function.
const scrapeApi = {
  name: "scrape-api",
  configureServer(server) {
    server.middlewares.use("/api/scrape", async (req, res) => {
      req.url = `/api/scrape${req.url}`;
      const { default: handler } = await server.ssrLoadModule("/server/handler.ts");
      handler(req, res);
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), scrapeApi],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
