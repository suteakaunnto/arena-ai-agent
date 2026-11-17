#!/usr/bin/env node
/**
 * scripts/build.mjs
 * 責務: TypeScript を esbuild でバンドルし、index.html にインライン化して dist/index.html を出力する
 * 使い方: node scripts/build.mjs [--dev]
 */
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");

async function main() {
  const t0 = Date.now();
  await mkdir(path.join(root, "dist"), { recursive: true });

  const result = await build({
    entryPoints: [path.join(root, "src/main.ts")],
    bundle: true,
    format: "esm",
    target: ["chrome100", "firefox100", "safari15"],
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    write: false,
    legalComments: "none",
    logLevel: "warning",
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  });

  const js = result.outputFiles[0].text;
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const inlined = html
    .replace('<script type="module" src="./src/main.ts"></script>', `<script type="module">\n${js}\n</script>`)
    .replace("<title>", "<meta name=\"generator\" content=\"alavida single-file build\" />\n    <title>");

  await writeFile(path.join(root, "dist/index.html"), inlined, "utf8");
  const kb = (Buffer.byteLength(inlined) / 1024).toFixed(0);
  console.log(`✓ dist/index.html  ${kb} KB  (${Date.now() - t0} ms)`);

  // 行数集計
  const { execSync } = await import("node:child_process");
  try {
    const out = execSync(
      `find src -name '*.ts' | xargs wc -l | tail -1`,
      { cwd: root, encoding: "utf8" }
    ).trim();
    console.log(`  自作 TypeScript 行数: ${out}`);
  } catch {
    /* noop */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
