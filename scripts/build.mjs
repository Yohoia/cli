import { chmod, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: { cli: "src/bin/cli.ts" },
  outdir: "dist",
  chunkNames: "chunks/[name]-[hash]",
  splitting: true,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["react-devtools-core"],
  minifySyntax: true,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  banner: {
    js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await chmod("dist/cli.js", 0o755);
await rm("dist/cli.cjs", { force: true });
