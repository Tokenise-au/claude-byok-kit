// Bundles the OAuth proposal demo: the stand-in server for Node and the demo
// site's script for the browser.
import { build } from "esbuild";

await build({
  entryPoints: { "stand-in": "oauth-proposal/stand-in/main.ts" },
  outdir: "dist/oauth",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "external",
});

await build({
  entryPoints: { site: "oauth-proposal/site/app.ts" },
  outdir: "dist/oauth",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
});
