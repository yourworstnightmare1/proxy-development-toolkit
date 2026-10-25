const ERUDA_URL = "/vendor/eruda/eruda.js";

// Eruda only computes its default entry-button spot once at init, and the proxied
// frame is often still being laid out then, so keep it pinned bottom-right on resize.
const ERUDA_BOOT = `
try {
  eruda.init();
  const pin = () => {
    if (!window.eruda || !innerWidth || !innerHeight) return;
    try { eruda.position({ x: innerWidth - 50, y: innerHeight - 50 }); } catch (error) {}
  };
  requestAnimationFrame(pin);
  setTimeout(pin, 500);
  addEventListener("resize", pin);
} catch (error) {
  console.warn("Eruda failed to start", error);
}`;

// Captured from this realm so the proxy's patched DOM methods inside the frame
// cannot rewrite Eruda's own source on the way in.
const createElement = Document.prototype.createElement;
const appendChild = Node.prototype.appendChild;
const removeNode = Element.prototype.remove;
const setText = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").set;

let source = null;

function loadSource() {
  if (!source) {
    source = fetch(ERUDA_URL).then((response) => {
      if (!response.ok) throw new Error(`Could not load Eruda (HTTP ${response.status}).`);
      return response.text();
    });
    source.catch(() => { source = null; });
  }
  return source;
}

function frameDocument(win) {
  try {
    const doc = win?.document;
    if (!doc || win.location.href === "about:blank") return null;
    return doc;
  } catch {
    return null;
  }
}

export async function injectEruda(win) {
  const doc = frameDocument(win);
  if (!doc || win.eruda) return false;
  const code = await loadSource();
  if (frameDocument(win) !== doc || win.eruda) return false;
  const script = createElement.call(doc, "script");
  setText.call(script, `${code}\n;${ERUDA_BOOT}`);
  appendChild.call(doc.head || doc.documentElement, script);
  removeNode.call(script);
  return true;
}

export function removeEruda(win) {
  try {
    if (!win?.eruda) return;
    win.eruda.destroy();
    win.eruda = undefined;
  } catch { /* cross-origin or already gone */ }
}

export function syncEruda(win, enabled) {
  if (enabled) return injectEruda(win).catch((error) => console.warn(error.message || error));
  removeEruda(win);
  return Promise.resolve(false);
}
