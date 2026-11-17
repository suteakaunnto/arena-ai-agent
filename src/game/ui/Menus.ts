/**
 * ui/Menus.ts
 * 責務: タイトル / ポーズ / 設定 / ヘルプ / リザルトの画面。DOMベースで軽量に。
 * 公開API: MenuSystem
 * 依存: なし(DOMのみ)。設定値は Game から注入する。
 */

/**
 * mm:ss.mmm。ui/Menus.ts は依存を DOM だけに保ちたいので、
 * race/Circuit.ts の formatTime は import せず同等のものをここに置く。
 */
function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

export interface MenuCallbacks {
  onStart: () => void;
  onGarage: () => void;
  onResume: () => void;
  onSettings: () => void;
  onQuit: () => void;
  onQualityChange: (index: number) => void;
  onTimeChange: (hour: number) => void;
  onWeatherChange: (w: "clear" | "cloudy" | "rain" | "storm") => void;
  onCameraChange: (mode: string) => void;
  onToggleDebug: () => void;
  onPhotoMode: () => void;
  onFullscreen: () => void;
  onReset: () => void;
  /** タイムトライアルを開始(コース id)。フリードライブは null */
  onRaceStart: (circuitId: string | null) => void;
  /** コース選択画面を開く */
  onCircuits: () => void;
}

const STYLE = `
.menu-overlay{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 40%,rgba(10,16,22,0.55),rgba(4,7,10,0.9));backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);font-family:'Hiragino Sans','Noto Sans JP',system-ui,sans-serif;color:#e8eef4}
.menu-panel{width:min(760px,92vw);max-height:88vh;overflow:auto;background:linear-gradient(160deg,rgba(22,29,37,0.96),rgba(12,17,22,0.98));border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:clamp(18px,3vw,34px);box-shadow:0 30px 80px rgba(0,0,0,0.6)}
.menu-title{font-size:clamp(22px,3.2vw,34px);font-weight:800;letter-spacing:0.02em;margin:0 0 4px}
.menu-sub{font-size:clamp(11px,1.3vw,13px);color:#8fa3b2;letter-spacing:0.14em;margin-bottom:22px;text-transform:uppercase}
.menu-btn{display:flex;align-items:center;gap:12px;width:100%;padding:13px 18px;margin-bottom:9px;background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.1);border-radius:9px;color:#e8eef4;font-size:clamp(13px,1.5vw,15px);font-weight:600;cursor:pointer;transition:background .14s,border-color .14s,transform .1s;text-align:left;font-family:inherit}
.menu-btn:hover,.menu-btn:focus-visible{background:rgba(255,138,61,0.14);border-color:rgba(255,138,61,0.55);outline:none}
.menu-btn:active{transform:scale(0.99)}
.menu-btn .k{font-size:10px;letter-spacing:0.18em;color:#ff8a3d;font-weight:800;min-width:1.4em}
.menu-btn .d{font-size:11px;color:#8fa3b2;font-weight:400;margin-left:auto;text-align:right}
.menu-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 4px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:clamp(12px,1.4vw,14px)}
.menu-row select,.menu-row input[type=range]{background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.14);color:#e8eef4;border-radius:6px;padding:6px 9px;font-family:inherit;font-size:12px;min-width:140px}
.menu-row input[type=range]{padding:0;height:22px}
.menu-hint{font-size:11px;color:#7d8b98;line-height:1.6;margin-top:16px}
.menu-close{position:absolute;top:16px;right:20px;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.05);color:#cbd5e1;cursor:pointer;font-size:16px}
.menu-badge{display:inline-block;font-size:10px;letter-spacing:0.16em;padding:3px 8px;border-radius:4px;background:rgba(255,138,61,0.16);color:#ffb066;font-weight:800;margin-left:8px;vertical-align:middle}
`;

export class MenuSystem {
  readonly root: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private callbacks: MenuCallbacks;
  private current: string | null = null;
  private panel: HTMLDivElement;

  constructor(parent: HTMLElement, callbacks: MenuCallbacks) {
    this.callbacks = callbacks;
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = STYLE;
    document.head.appendChild(this.styleEl);

    this.root = document.createElement("div");
    this.root.style.display = "none";
    parent.appendChild(this.root);

    this.panel = document.createElement("div");
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  get currentScreen(): string | null {
    return this.current;
  }

  close(): void {
    this.current = null;
    this.root.style.display = "none";
    this.root.innerHTML = "";
  }

  /** タイトル画面 */
  showTitle(progress: { cars: number; roads: number; world: string }): void {
    this.current = "title";
    this.root.style.display = "block";
    this.root.innerHTML = `
      <div class="menu-overlay">
        <div class="menu-panel" style="max-width:640px;text-align:left;position:relative">
          <div style="font-size:10px;letter-spacing:0.42em;color:#ff8a3d;font-weight:800;margin-bottom:10px">COSTA SOL · OPEN ROAD</div>
          <h1 class="menu-title" style="font-size:clamp(30px,5.4vw,54px);line-height:1.02;margin-bottom:8px">ALAVIDA</h1>
          <div class="menu-sub">12km × 12km / 手続き生成のみ / 単一HTML</div>
          <div style="display:flex;gap:18px;flex-wrap:wrap;margin:18px 0 24px;font-size:12px;color:#9fb0be">
            <span><b style="color:#fff;font-size:16px">${progress.cars}</b> 台のオリジナル車</span>
            <span><b style="color:#fff;font-size:16px">${progress.roads}</b> 本の道路</span>
            <span><b style="color:#fff;font-size:16px">${progress.world}</b></span>
          </div>
          <button class="menu-btn" data-act="start"><span class="k">▶</span>ドライブを開始<span class="d">Enter / A</span></button>
          <button class="menu-btn" data-act="circuits"><span class="k">⏱</span>タイムトライアル<span class="d">T</span></button>
          <button class="menu-btn" data-act="garage"><span class="k">◈</span>ガレージ(車を選ぶ)<span class="d">G</span></button>
          <button class="menu-btn" data-act="settings"><span class="k">⚙</span>設定<span class="d">Esc</span></button>
          <button class="menu-btn" data-act="help"><span class="k">?</span>操作説明<span class="d">H</span></button>
          <p class="menu-hint">キーボード / スマホのタッチ / Xbox コントローラー / Switch Pro コントローラーに対応。接続すると自動で切り替わります。</p>
        </div>
      </div>
    `;
    this.wire();
  }

  /** ポーズ */
  showPause(stats: { speed: number; distance: number; time: string; car: string }): void {
    this.current = "pause";
    this.root.style.display = "block";
    this.root.innerHTML = `
      <div class="menu-overlay">
        <div class="menu-panel" style="max-width:560px;position:relative">
          <button class="menu-close" data-act="resume">✕</button>
          <h2 class="menu-title">ポーズ</h2>
          <div class="menu-sub">${stats.car}</div>
          <div style="display:flex;gap:22px;margin-bottom:20px;font-size:12px;color:#9fb0be;flex-wrap:wrap">
            <span>走行距離 <b style="color:#fff">${stats.distance.toFixed(2)} km</b></span>
            <span>最高速 <b style="color:#fff">${Math.round(stats.speed)} km/h</b></span>
            <span>時刻 <b style="color:#fff">${stats.time}</b></span>
          </div>
          <button class="menu-btn" data-act="resume"><span class="k">▶</span>再開<span class="d">Esc</span></button>
          <button class="menu-btn" data-act="settings"><span class="k">⚙</span>設定<span class="d"></span></button>
          <button class="menu-btn" data-act="camera"><span class="k">◉</span>カメラを切り替え<span class="d">C</span></button>
          <button class="menu-btn" data-act="photo"><span class="k">◐</span>フォトモード<span class="d">F</span></button>
          <button class="menu-btn" data-act="fullscreen"><span class="k">⛶</span>全画面<span class="d"></span></button>
          <button class="menu-btn" data-act="reset"><span class="k">↺</span>車をコースへ戻す<span class="d">R</span></button>
          <button class="menu-btn" data-act="quit"><span class="k">⏻</span>タイトルへ戻る<span class="d"></span></button>
        </div>
      </div>
    `;
    this.wire();
  }

  /** 設定 */
  showSettings(current: { quality: number; time: number; weather: string; camera: string; debug: boolean }): void {
    this.current = "settings";
    this.root.style.display = "block";
    this.root.innerHTML = `
      <div class="menu-overlay">
        <div class="menu-panel" style="position:relative">
          <button class="menu-close" data-act="back">✕</button>
          <h2 class="menu-title">設定</h2>
          <div class="menu-sub">Graphics / Atmosphere / Camera</div>
          <div class="menu-row"><span>グラフィック品質</span>
            <select data-set="quality">
              ${["低 (スマホ)", "標準", "高", "最高"].map((n, i) => `<option value="${i}" ${i === current.quality ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
          <div class="menu-row"><span>時刻</span>
            <input type="range" min="0" max="24" step="0.1" value="${current.time}" data-set="time" />
          </div>
          <div class="menu-row"><span>天候</span>
            <select data-set="weather">
              ${[
                ["clear", "晴れ"],
                ["cloudy", "曇り"],
                ["rain", "雨"],
                ["storm", "嵐"],
              ]
                .map(([v, n]) => `<option value="${v}" ${v === current.weather ? "selected" : ""}>${n}</option>`)
                .join("")}
            </select>
          </div>
          <div class="menu-row"><span>カメラ</span>
            <select data-set="camera">
              ${[
                ["chase", "チェイス"],
                ["hood", "ボンネット"],
                ["cockpit", "コックピット"],
                ["cinematic", "シネマ"],
              ]
                .map(([v, n]) => `<option value="${v}" ${v === current.camera ? "selected" : ""}>${n}</option>`)
                .join("")}
            </select>
          </div>
          <div class="menu-row"><span>デバッグ表示</span>
            <button class="menu-btn" data-act="debug" style="width:auto;margin:0;padding:7px 14px"><span class="d" style="margin:0">${current.debug ? "ON" : "OFF"}</span></button>
          </div>
          <p class="menu-hint">キー割当の変更は将来のフェーズで追加予定です。現在は既定の割当(設計書の表)で動作します。</p>
        </div>
      </div>
    `;
    this.wire();
    const time = this.root.querySelector('[data-set="time"]') as HTMLInputElement | null;
    time?.addEventListener("input", () => this.callbacks.onTimeChange(parseFloat(time.value)));
    const quality = this.root.querySelector('[data-set="quality"]') as HTMLSelectElement | null;
    quality?.addEventListener("change", () => this.callbacks.onQualityChange(parseInt(quality.value, 10)));
    const weather = this.root.querySelector('[data-set="weather"]') as HTMLSelectElement | null;
    weather?.addEventListener("change", () =>
      this.callbacks.onWeatherChange(weather.value as "clear" | "cloudy" | "rain" | "storm")
    );
    const camera = this.root.querySelector('[data-set="camera"]') as HTMLSelectElement | null;
    camera?.addEventListener("change", () => this.callbacks.onCameraChange(camera.value));
  }

  /** 操作説明 */
  showHelp(): void {
    this.current = "help";
    this.root.style.display = "block";
    const rows: Array<[string, string, string, string]> = [
      ["アクセル", "W / ↑", "RT", "右ペダル"],
      ["ブレーキ / 後退", "S / ↓", "LT", "左ペダル"],
      ["ステア", "A D / ← →", "左スティック", "ホイール / 傾き"],
      ["ハンドブレーキ", "Space", "A (下ボタン)", "HB ボタン"],
      ["ギア アップ / ダウン", "E / Q", "RB / LB", "▲ / ▼"],
      ["視点切替", "C", "Y (上ボタン)", "CAM"],
      ["後方確認", "Z", "R3", "REAR"],
      ["リワインド", "Backspace", "X (左ボタン)", "巻戻"],
      ["ライト", "L", "十字↑", "ライト"],
      ["マップ", "M", "Back", "MAP"],
      ["ポーズ", "Esc / P", "Start", "ポーズ"],
      ["フォトモード", "F", "十字↓", "メニュー内"],
      ["タイムトライアル", "T", "-", "タイトル/ポーズ"],
      ["リセット", "R", "LB+RB", "—"],
      ["デバッグ HUD", "F3", "—", "—"],
    ];
    this.root.innerHTML = `
      <div class="menu-overlay">
        <div class="menu-panel" style="position:relative">
          <button class="menu-close" data-act="back">✕</button>
          <h2 class="menu-title">操作説明</h2>
          <div class="menu-sub">Keyboard / Gamepad / Touch</div>
          <table style="width:100%;border-collapse:collapse;font-size:clamp(11px,1.3vw,13px)">
            <thead><tr style="color:#8fa3b2;font-size:10px;letter-spacing:0.14em;text-align:left">
              <th style="padding:6px 4px">操作</th><th style="padding:6px 4px">キーボード</th><th style="padding:6px 4px">コントローラー</th><th style="padding:6px 4px">スマホ</th>
            </tr></thead>
            <tbody>
              ${rows
                .map(
                  ([a, k, g, t]) =>
                    `<tr style="border-top:1px solid rgba(255,255,255,0.06)">
                      <td style="padding:7px 4px;font-weight:600">${a}</td>
                      <td style="padding:7px 4px;color:#ffb066;font-family:ui-monospace,monospace">${k}</td>
                      <td style="padding:7px 4px;color:#cbd5e1">${g}</td>
                      <td style="padding:7px 4px;color:#cbd5e1">${t}</td>
                    </tr>`
                )
                .join("")}
            </tbody>
          </table>
          <p class="menu-hint">ボタンは「位置」基準の割当です(下ボタン = Xbox の A / Switch Pro の B)。コントローラーの種類は自動判定し、画面表示も切り替わります。</p>
        </div>
      </div>
    `;
    this.wire();
  }

  /** リザルト(ラップ等) */
  /**
   * コース選択画面。
   *  @param circuits 有効なコース(名称・長さ・難易度・ベストラップ)
   */
  showCircuits(
    circuits: Array<{
      id: string;
      name: string;
      description: string;
      lengthKm: number;
      difficulty: number;
      best: number;
    }>
  ): void {
    this.current = "circuits";
    this.root.style.display = "block";
    const rows = circuits
      .map((c) => {
        const stars = "●".repeat(c.difficulty) + "○".repeat(Math.max(0, 5 - c.difficulty));
        const best = isFinite(c.best) ? fmtTime(c.best) : "--:--.---";
        return `
          <button class="menu-btn" data-act="race" data-circuit="${c.id}" style="text-align:left;align-items:flex-start">
            <span class="k" style="margin-top:2px">▶</span>
            <span style="flex:1;display:flex;flex-direction:column;gap:3px">
              <span style="font-weight:800">${c.name}</span>
              <span style="font-size:11px;color:#9fb0be;font-weight:400;line-height:1.45">${c.description}</span>
              <span style="font-size:11px;color:#7ad8ff;font-variant-numeric:tabular-nums;font-weight:600">
                ${c.lengthKm.toFixed(1)} km ・ <span style="color:#ffb066">${stars}</span> ・ BEST ${best}
              </span>
            </span>
          </button>`;
      })
      .join("");
    this.root.innerHTML = `
      <div class="menu-overlay">
        <div class="menu-panel" style="max-width:600px;text-align:left">
          <div class="menu-close" data-act="back">✕</div>
          <h2 class="menu-title" style="margin-bottom:4px">タイムトライアル</h2>
          <div class="menu-sub">2 周のベストタイムを競う / ゴーストは無し</div>
          <div style="display:flex;flex-direction:column;gap:9px;margin-top:16px">
            ${rows}
            <button class="menu-btn" data-act="free" style="margin-top:6px"><span class="k">∞</span>フリードライブ(コース無し)<span class="d">Esc</span></button>
          </div>
        </div>
      </div>
    `;
    this.wire();
  }

  showResults(data: { title: string; lines: Array<[string, string]>; onRestart: () => void }): void {
    this.current = "results";
    this.root.style.display = "block";
    this.root.innerHTML = `
      <div class="menu-overlay">
        <div class="menu-panel" style="max-width:520px">
          <h2 class="menu-title">${data.title}</h2>
          <div class="menu-sub">Result</div>
          ${data.lines
            .map(
              ([k, v]) =>
                `<div class="menu-row"><span>${k}</span><b style="font-family:ui-monospace,monospace;color:#ffb066">${v}</b></div>`
            )
            .join("")}
          <div style="margin-top:20px">
            <button class="menu-btn" data-act="start"><span class="k">▶</span>もう一度走る</button>
            <button class="menu-btn" data-act="quit"><span class="k">⏻</span>タイトルへ</button>
          </div>
        </div>
      </div>
    `;
    this.wire(data.onRestart);
  }

  private restartCb: (() => void) | null = null;

  private wire(restartCb?: () => void): void {
    this.restartCb = restartCb ?? null;
    this.root.querySelectorAll("[data-act]").forEach((el) => {
      el.addEventListener("click", () => {
        const act = (el as HTMLElement).dataset.act;
        switch (act) {
          case "start":
            if (this.restartCb) this.restartCb();
            else this.callbacks.onStart();
            break;
          case "garage":
            this.callbacks.onGarage();
            break;
          case "resume":
            this.callbacks.onResume();
            break;
          case "settings":
            this.callbacks.onSettings();
            break;
          case "quit":
            this.callbacks.onQuit();
            break;
          case "camera":
            this.callbacks.onCameraChange("__cycle__");
            break;
          case "photo":
            this.callbacks.onPhotoMode();
            break;
          case "fullscreen":
            this.callbacks.onFullscreen();
            break;
          case "reset":
            this.callbacks.onReset();
            break;
          case "debug":
            this.callbacks.onToggleDebug();
            break;
          case "help":
            this.showHelp();
            break;
          case "circuits":
            this.callbacks.onCircuits();
            break;
          case "race":
            this.callbacks.onRaceStart((el as HTMLElement).dataset.circuit ?? null);
            break;
          case "free":
            this.callbacks.onRaceStart(null);
            break;
          case "back":
            this.close();
            break;
        }
      });
    });
  }

  dispose(): void {
    this.styleEl.remove();
    this.root.remove();
  }
}
