// Packages the Vite build and the /api/scrape function in Vercel's Build Output API v3 layout.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const out = ".vercel/output";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/static`, { recursive: true });
cpSync("dist", `${out}/static`, { recursive: true });

const fn = `${out}/functions/api/scrape.func`;
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: ["server/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: `${fn}/index.mjs`,
  logLevel: "warning",
});
writeFileSync(`${fn}/package.json`, JSON.stringify({ type: "module" }));
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 30 }));
writeFileSync(`${out}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: "/data.json", headers: { "cache-control": "public, max-age=0, must-revalidate" }, continue: true },
    { handle: "filesystem" },
    { src: "/api/scrape", dest: "/api/scrape" },
  ],
}, null, 2));
console.log("Wrote .vercel/output (static + api/scrape)");
