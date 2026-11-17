#!/usr/bin/env node
/**
 * scripts/serve.mjs
 * 責務: 開発用の静的サーバ + esbuild watch。dist/index.html を配信する(プレビュー用に 0.0.0.0 で待受)
 */
import { build, context } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 5173);
const HOST = "0.0.0.0";

async function bundle() {
  const result = await build({
    entryPoints: [path.join(root, "src/main.ts")],
    bundle: true,
    format: "esm",
    target: ["chrome100", "firefox100", "safari15"],
    sourcemap: "inline",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const js = result.outputFiles[0].text;
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const inlined = html.replace(
    '<script type="module" src="./src/main.ts"></script>',
    `<script type="module">\n${js}\n</script>`
  );
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist/index.html"), inlined, "utf8");
  return inlined;
}

let cached = "";

const server = http.createServer(async (req, res) => {
  if (!cached) {
    try {
      cached = await bundle();
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(e));
      return;
    }
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(cached);
});

await bundle();
server.listen(PORT, HOST, () => {
  console.log(`dev server: http://${HOST}:${PORT}`);
});

// ファイル監視(ビルドしなおす)
const chokidarLike = async () => {
  const { watch } = await import("node:fs");
  let timer = null;
  watch(path.join(root, "src"), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        cached = await bundle();
        console.log("rebuilt");
      } catch (e) {
        console.error("build error:", String(e).slice(0, 400));
      }
    }, 220);
  });
  void context;
};
await chokidarLike();
