const DONE_LINGER_MS = 4000;
const ERROR_LINGER_MS = 10000;

const items = new Map();
let panel = null;
let started = false;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatEta(seconds) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s left`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s left`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m left`;
}

function formatElapsed(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${String(total % 60).padStart(2, "0")}s elapsed` : `${total}s elapsed`;
}

function ensurePanel() {
  if (panel?.isConnected) return panel;
  panel = document.createElement("div");
  panel.id = "download-progress";
  panel.setAttribute("aria-live", "polite");
  document.body.appendChild(panel);
  return panel;
}

function createItem(id, label) {
  const el = document.createElement("div");
  el.className = "dl-item";
  el.innerHTML = `
    <div class="dl-head">
      <span class="dl-label"></span>
      <button type="button" class="dl-close" aria-label="Dismiss" title="Dismiss">×</button>
    </div>
    <div class="dl-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="dl-fill"></div></div>
    <div class="dl-meta"></div>`;
  el.querySelector(".dl-label").textContent = label || "Downloading";
  el.querySelector(".dl-close").addEventListener("click", () => removeItem(id));
  ensurePanel().appendChild(el);
  const item = { el, timer: 0 };
  items.set(id, item);
  return item;
}

function removeItem(id) {
  const item = items.get(id);
  if (!item) return;
  clearTimeout(item.timer);
  item.el.remove();
  items.delete(id);
  if (!items.size) panel?.remove();
}

function render(data) {
  const item = items.get(data.id) || createItem(data.id, data.label);
  const { el } = item;
  const bar = el.querySelector(".dl-bar");
  const fill = el.querySelector(".dl-fill");
  const meta = el.querySelector(".dl-meta");
  const known = typeof data.percent === "number";

  el.classList.toggle("error", Boolean(data.error));
  el.classList.toggle("done", Boolean(data.done));
  bar.classList.toggle("indeterminate", !known && !data.done && !data.error);
  if (known) {
    fill.style.width = `${data.percent.toFixed(1)}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(data.percent)));
  } else {
    fill.style.width = data.done ? "100%" : "";
    bar.removeAttribute("aria-valuenow");
  }

  if (data.error) {
    meta.textContent = `Failed: ${data.error}`;
  } else if (data.done) {
    meta.textContent = data.stage ? `${data.stage} · ${formatElapsed(data.elapsedSeconds)}` : `Done · ${formatBytes(data.received)}`;
  } else if (data.stage) {
    const parts = [`Step ${data.step} of ${data.steps}: ${data.stage}`];
    if (data.received > 0) {
      parts.push(data.total ? `${formatBytes(data.received)} of ${formatBytes(data.total)}` : formatBytes(data.received));
    }
    parts.push(formatElapsed(data.elapsedSeconds));
    meta.textContent = parts.join(" · ");
  } else {
    const parts = [];
    if (known) parts.push(`${Math.floor(data.percent)}%`);
    parts.push(data.total ? `${formatBytes(data.received)} of ${formatBytes(data.total)}` : formatBytes(data.received));
    if (data.bytesPerSecond > 0) parts.push(`${formatBytes(data.bytesPerSecond)}/s`);
    if (data.total) parts.push(typeof data.etaSeconds === "number" && data.received > 0 ? formatEta(data.etaSeconds) : "Estimating…");
    meta.textContent = parts.join(" · ");
  }

  clearTimeout(item.timer);
  if (data.done || data.error) {
    item.timer = setTimeout(() => removeItem(data.id), data.error ? ERROR_LINGER_MS : DONE_LINGER_MS);
  }
}

export function initDownloadProgress() {
  if (started || !window.pdtk?.onDownloadProgress) return;
  started = true;
  window.pdtk.onDownloadProgress((data) => {
    if (data?.id) render(data);
  });
}
