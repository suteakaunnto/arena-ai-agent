/**
 * main.ts
 * 責務: エントリポイント。エラーハンドリングと Game の起動のみ。
 * 依存: game/Game.ts
 */
import { Game } from "./game/Game.js";
import { debugLog, showDebugLog } from "./game/core/debug.js";

const container = document.getElementById("app");
if (!container) {
  document.body.innerHTML = '<pre style="color:#fff">#app が見つかりません</pre>';
} else {
  const showError = (err: unknown, where: string) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    debugLog(`[ERROR:${where}] ${msg}`);
    const log = showDebugLog(container);
    log.style.display = "block";
    log.textContent = `起動に失敗しました\n${msg}`;
    const box = document.createElement("div");
    box.style.cssText =
      "position:absolute;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(6,10,14,0.94);color:#ffb3a7;font-family:ui-monospace,monospace;font-size:12px;padding:24px;white-space:pre-wrap;overflow:auto;";
    box.textContent = `起動に失敗しました\n\n${msg}\n\nブラウザは WebGL2 に対応していますか?`;
    container.appendChild(box);
  };

  try {
    const game = new Game({ container });
    (window as unknown as { __game: Game }).__game = game;
  } catch (err) {
    showError(err, "boot");
  }

  window.addEventListener("error", (e) => debugLog(`[window.error] ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => debugLog(`[unhandled] ${String(e.reason)}`));
}
