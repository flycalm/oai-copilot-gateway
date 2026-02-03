import { build } from "esbuild";

await build({
  entryPoints: ["node/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  outfile: "dist/server.mjs",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

