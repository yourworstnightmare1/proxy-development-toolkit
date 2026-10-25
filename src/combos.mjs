const TRANSPORTS = [
  { id: "epoxy-tls", label: "epoxy-tls" },
  { id: "wisp-js", label: "wisp-js" },
  { id: "libcurl-transport", label: "libcurl-transport" },
  { id: "bare-transport", label: "bare-transport" },
  { id: "bare-mux", label: "bare-mux (legacy)" },
];

const DEFAULT_COMBO = () => ({
  id: `combo-${Date.now().toString(36)}`,
  label: "",
  enabled: true,
  proxyKind: "scramjet",
  transport: "epoxy-tls",
});

let combos = [];
let menuBound = false;

export function getTestCombos() {
  return combos.map((item) => ({ ...item }));
}

export function enabledTestCombos() {
  return getTestCombos().filter((item) => item.enabled);
}

export function loadCombosFromSettings(settings = {}) {
  combos = Array.isArray(settings.testCombos)
    ? settings.testCombos.map((item) => ({
      id: item.id || DEFAULT_COMBO().id,
      label: item.label || "",
      enabled: Boolean(item.enabled),
      proxyKind: item.proxyKind === "ultraviolet" ? "ultraviolet" : "scramjet",
      transport: TRANSPORTS.some((t) => t.id === item.transport) ? item.transport : "epoxy-tls",
    }))
    : [];
  renderCombosList();
  window.dispatchEvent(new CustomEvent("pdtk-combos-changed"));
}

export function combosSettingsPatch() {
  return { testCombos: getTestCombos() };
}

async function persistCombos() {
  try {
    const state = await window.pdtk.getSettings();
    await window.pdtk.saveSettings({
      ...(state?.settings || {}),
      ...combosSettingsPatch(),
    });
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("pdtk-combos-changed"));
}

function comboLabel(item) {
  if (item.label.trim()) return item.label.trim();
  const proxy = item.proxyKind === "ultraviolet" ? "UV" : "SJ";
  const transport = item.transport.replace(/-transport$/i, "").replace(/-tls$/i, "");
  return `${proxy} · ${transport}`;
}

export function formatComboChip(item) {
  return comboLabel(item);
}

function transportOptionsHtml(selected) {
  return TRANSPORTS.map((t) => (
    `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${t.label}</option>`
  )).join("");
}

function renderCombosList() {
  const list = document.getElementById("test-combos-list");
  if (!list) return;
  if (!combos.length) {
    list.innerHTML = `<p class="hint test-combos-empty">No combos yet. Add one below, or leave empty to use the main proxy/transport selectors.</p>`;
    return;
  }
  list.innerHTML = combos.map((item, index) => `
    <div class="test-combo-row" data-combo-id="${item.id}">
      <label class="test-combo-enable" title="Include when starting a session">
        <input type="checkbox" data-combo-field="enabled" ${item.enabled ? "checked" : ""} />
      </label>
      <input class="test-combo-label" type="text" data-combo-field="label" value="${item.label.replace(/"/g, "&quot;")}" placeholder="${comboLabel({ ...item, label: "" })}" spellcheck="false" />
      <select data-combo-field="proxyKind">
        <option value="scramjet" ${item.proxyKind !== "ultraviolet" ? "selected" : ""}>Scramjet</option>
        <option value="ultraviolet" ${item.proxyKind === "ultraviolet" ? "selected" : ""}>Ultraviolet</option>
      </select>
      <select data-combo-field="transport">${transportOptionsHtml(item.transport)}</select>
      <button type="button" class="test-combo-remove" data-combo-remove="${item.id}" title="Remove">×</button>
    </div>
  `).join("");

  list.querySelectorAll(".test-combo-row").forEach((row) => {
    const id = row.dataset.comboId;
    const item = combos.find((c) => c.id === id);
    if (!item) return;
    row.querySelectorAll("[data-combo-field]").forEach((field) => {
      const key = field.dataset.comboField;
      const handler = () => {
        if (key === "enabled") item.enabled = Boolean(field.checked);
        else if (key === "label") item.label = field.value;
        else if (key === "proxyKind") item.proxyKind = field.value === "ultraviolet" ? "ultraviolet" : "scramjet";
        else if (key === "transport") item.transport = field.value;
        if (key === "proxyKind" || key === "transport") {
          const labelInput = row.querySelector(".test-combo-label");
          if (labelInput && !item.label.trim()) labelInput.placeholder = comboLabel({ ...item, label: "" });
        }
        void persistCombos();
      };
      field.addEventListener("change", handler);
      if (field.tagName === "INPUT" && field.type === "text") field.addEventListener("input", handler);
    });
  });
}

function openCombosMenu(anchor) {
  const menu = document.getElementById("test-combos-menu");
  if (!menu) return;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 420)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  menu.classList.remove("hidden");
  renderCombosList();
}

function closeCombosMenu() {
  document.getElementById("test-combos-menu")?.classList.add("hidden");
}

export function initCombos() {
  if (menuBound) return;
  menuBound = true;

  document.querySelectorAll(".test-combos-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menu = document.getElementById("test-combos-menu");
      if (menu && !menu.classList.contains("hidden") && menu.dataset.anchor === button.id) {
        closeCombosMenu();
        return;
      }
      if (menu) menu.dataset.anchor = button.id || "";
      openCombosMenu(button);
    });
  });

  document.getElementById("test-combos-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => closeCombosMenu());

  document.getElementById("test-combos-add")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const transport = document.getElementById("transport")?.value || "epoxy-tls";
    const proxyKind = document.getElementById("proxy-kind")?.value === "ultraviolet" ? "ultraviolet" : "scramjet";
    combos.push({
      ...DEFAULT_COMBO(),
      proxyKind,
      transport: TRANSPORTS.some((t) => t.id === transport) ? transport : "epoxy-tls",
    });
    renderCombosList();
    void persistCombos();
  });

  document.getElementById("test-combos-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-combo-remove]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const id = button.getAttribute("data-combo-remove");
    combos = combos.filter((item) => item.id !== id);
    renderCombosList();
    void persistCombos();
  });

  renderCombosList();
}
