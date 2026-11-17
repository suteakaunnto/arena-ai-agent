/**
 * scripts/domstub.mjs
 * 責務: ブラウザ無しでロジックを検証するための最小 DOM / Canvas モック
 * 使い方: node --import ./scripts/domstub.mjs script.mjs
 */
class MockContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = "#000";
    this.strokeStyle = "#000";
    this.lineWidth = 1;
    this.font = "10px sans-serif";
    this.textAlign = "left";
    this.textBaseline = "alphabetic";
    this.globalAlpha = 1;
    this.lineCap = "butt";
  }
  createLinearGradient() {
    return { addColorStop: () => {} };
  }
  createRadialGradient() {
    return { addColorStop: () => {} };
  }
  createPattern() {
    return {};
  }
  fillRect() {}
  strokeRect() {}
  clearRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  arcTo() {}
  ellipse() {}
  rect() {}
  fill() {}
  stroke() {}
  clip() {}
  save() {}
  restore() {}
  translate() {}
  rotate() {}
  scale() {}
  setTransform() {}
  drawImage() {}
  fillText() {}
  strokeText() {}
  measureText(t) {
    return { width: String(t).length * 6 };
  }
  getImageData(x, y, w, h) {
    return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
  }
  putImageData() {}
  createImageData(w, h) {
    return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
  }
}

class MockCanvas {
  constructor() {
    this.width = 300;
    this.height = 150;
    this.style = {};
    this._ctx = new MockContext2D(this);
  }
  getContext(type) {
    if (type === "2d") return this._ctx;
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
  remove() {}
  appendChild() {}
  replaceWith() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width, height: this.height, right: this.width, bottom: this.height };
  }
}

class MockElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.style = { cssText: "", setProperty() {} };
    this.children = [];
    this.childElementCount = 0;
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this._innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.isContentEditable = false;
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
  }
  appendChild(c) {
    this.children.push(c);
    this.childElementCount = this.children.length;
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    this.childElementCount = this.children.length;
  }
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  getAttribute() {
    return null;
  }
  querySelector() {
    const el = new MockElement("div");
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    return el;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 };
  }
  focus() {}
  replaceWith() {}
  setPointerCapture() {}
  get clientWidth() {
    return 1280;
  }
  get clientHeight() {
    return 720;
  }
}

const storage = new Map();

const doc = {
  head: new MockElement("head"),
  body: new MockElement("body"),
  documentElement: new MockElement("html"),
  createElement(tag) {
    if (String(tag).toLowerCase() === "canvas") return new MockCanvas();
    return new MockElement(tag);
  },
  createElementNS(_ns, tag) {
    return new MockElement(tag);
  },
  getElementById() {
    const el = new MockElement("div");
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720 });
    return el;
  },
  querySelector() {
    return new MockElement("div");
  },
  querySelectorAll() {
    return [];
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  fullscreenElement: null,
};

globalThis.document = doc;
globalThis.window = globalThis;
const nav = globalThis.navigator ?? {};
try {
  Object.defineProperty(nav, "maxTouchPoints", { value: 0, configurable: true });
  Object.defineProperty(nav, "getGamepads", { value: () => [], configurable: true, writable: true });
  Object.defineProperty(nav, "vibrate", { value: () => {}, configurable: true, writable: true });
} catch {
  /* 既に定義済み */
}
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.devicePixelRatio = 1;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
  key: (i) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size;
  },
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.AudioContext = undefined;
globalThis.screen = { orientation: { lock: async () => {} } };
globalThis.customElements = { define() {}, get() {} };
globalThis.HTMLCanvasElement = MockCanvas;
globalThis.Image = class {
  constructor() {
    this.width = 1;
    this.height = 1;
  }
  addEventListener() {}
};
globalThis.CustomEvent = class {
  constructor(type, opts) {
    this.type = type;
    this.detail = opts?.detail;
  }
};
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };

// three が参照する WebGL 関連は個別にモック不要(レンダラーは使わない)
export {};
