// Bundles the kit and the Anthropic SDK into one ES module for pages without a
// bundler, such as the example. The SDK is Apache-2.0, so its licence ships
// beside the bundle.
import { copyFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/browser";
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: { "claude-byok": "src/index.ts" },
  outdir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "eof",
  banner: {
    js: "/* claude-byok-kit (MIT). Bundles @anthropic-ai/sdk (Apache-2.0, Copyright Anthropic): see claude-byok.js.LICENSE-anthropic-sdk.txt */",
  },
});

copyFileSync("node_modules/@anthropic-ai/sdk/LICENSE", `${outdir}/claude-byok.js.LICENSE-anthropic-sdk.txt`);
