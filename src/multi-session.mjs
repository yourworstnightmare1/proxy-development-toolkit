import { formatComboChip } from "./combos.mjs";

export function createMultiController({
  frameWrap,
  proxyFrame,
  comboFramesEl,
  tabStrip,
  tabList,
  setStatus,
  liveStatus,
  screenPrefs,
  erudaEnabled = () => false,
  onActiveChanged,
}) {
  const runtime = {
    combos: [], // { id, label, proxy, transport, port, origin, poppedOut }
    activeId: "",
    ready: new Map(),
  };

  function comboById(id) {
    return runtime.combos.find((item) => item.id === id);
  }

  function activeCombo() {
    return comboById(runtime.activeId) || runtime.combos[0] || null;
  }

  function iframeFor(id) {
    return comboFramesEl?.querySelector(`iframe[data-combo-id="${CSS.escape(id)}"]`);
  }

  function postToCombo(id, message) {
    const combo = comboById(id);
    if (!combo) return;
    if (combo.poppedOut) {
      void window.pdtk.postComboWindow?.({ comboId: id, message });
      return;
    }
    const node = iframeFor(id);
    try {
      node?.contentWindow?.postMessage(message, combo.origin || "*");
    } catch { /* ignore */ }
  }

  function postToActive(message) {
    const active = activeCombo();
    if (active) postToCombo(active.id, message);
  }

  function postToAll(message) {
    for (const combo of runtime.combos) postToCombo(combo.id, message);
  }

  function syncVisibility() {
    if (!comboFramesEl) return;
    for (const combo of runtime.combos) {
      const node = iframeFor(combo.id);
      if (!node) continue;
      const hide = combo.poppedOut || combo.id !== runtime.activeId;
      node.classList.toggle("hidden", hide);
    }
  }

  function renderComboTabs() {
    if (!tabList) return;
    tabList.innerHTML = "";
    for (const combo of runtime.combos) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tab-chip${combo.id === runtime.activeId ? " active" : ""}`;
      button.dataset.comboId = combo.id;
      if (combo.error) button.classList.add("error");
      button.title = combo.error
        ? `${combo.label} failed: ${combo.error}`
        : combo.poppedOut ? `${combo.label} (popped out)` : combo.label;
      const label = document.createElement("span");
      label.textContent = combo.error ? `⚠ ${combo.label}` : combo.poppedOut ? `↗ ${combo.label}` : combo.label;
      button.appendChild(label);

      const pop = document.createElement("span");
      pop.className = "tab-popout";
      pop.textContent = combo.poppedOut ? "↙" : "↗";
      pop.title = combo.poppedOut ? "Focus window" : "Pop out";
      pop.addEventListener("click", (event) => {
        event.stopPropagation();
        void togglePopout(combo.id);
      });
      button.appendChild(pop);

      if (runtime.combos.length > 1) {
        const close = document.createElement("span");
        close.className = "tab-close";
        close.textContent = "×";
        close.title = "Close combo";
        close.addEventListener("click", (event) => {
          event.stopPropagation();
          void removeCombo(combo.id);
        });
        button.appendChild(close);
      }

      button.addEventListener("click", () => focusCombo(combo.id));
      tabList.appendChild(button);
    }
    tabStrip?.classList.toggle("hidden", runtime.combos.length === 0);
    syncLiveComboSelect();
  }

  function syncLiveComboSelect() {
    const label = document.getElementById("live-combo-label");
    const select = document.getElementById("live-combo");
    const popBtn = document.getElementById("combo-popout");
    const multi = runtime.combos.length > 0;
    label?.classList.toggle("hidden", !multi);
    popBtn?.classList.toggle("hidden", !multi);
    if (!select) return;
    select.innerHTML = runtime.combos.map((combo) => (
      `<option value="${combo.id}" ${combo.id === runtime.activeId ? "selected" : ""}>${combo.label}${combo.poppedOut ? " (window)" : ""}</option>`
    )).join("");
  }

  function focusCombo(id) {
    const combo = comboById(id);
    if (!combo) return false;
    runtime.activeId = id;
    if (combo.error) setStatus(liveStatus, `${combo.label} failed: ${combo.error}`, true);
    if (combo.poppedOut) {
      void window.pdtk.focusComboWindow({ comboId: id });
    }
    syncVisibility();
    renderComboTabs();
    onActiveChanged?.(combo);
    return true;
  }

  async function bootComboIframe(combo) {
    let iframe = iframeFor(combo.id);
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.dataset.comboId = combo.id;
      iframe.title = combo.label;
      comboFramesEl.appendChild(iframe);
    }
    runtime.ready.set(combo.id, false);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out loading ${combo.label}.`)), 15000);
      iframe.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      iframe.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Failed to load ${combo.label}.`));
      };
      iframe.src = `${combo.origin}/harness/pane.html`;
    });
    const readyPromise = waitReady(combo.id);
    iframe.contentWindow.postMessage({
      type: "pdtk-boot",
      session: {
        ...combo.bootSession,
        pane: combo.id,
        comboId: combo.id,
        screen: screenPrefs(),
        eruda: erudaEnabled(),
      },
    }, combo.origin);
    await readyPromise;
  }

  function waitReady(id, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      if (runtime.ready.get(id)) {
        resolve();
        return;
      }
      const finish = (error) => {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error(`Timed out starting combo ${id}.`)), timeoutMs);
      function onMessage(event) {
        const data = event.data;
        if (!data || (data.type !== "pdtk-ready" && data.type !== "pdtk-error")) return;
        if (data.pane !== id && data.comboId !== id) return;
        if (data.type === "pdtk-error") {
          finish(new Error(data.error || `Combo ${id} failed to start.`));
          return;
        }
        runtime.ready.set(id, true);
        finish();
      }
      window.addEventListener("message", onMessage);
    });
  }

  async function start(session) {
    clearDom();
    runtime.combos = (session.combos || []).map((item) => ({
      ...item,
      label: item.label || formatComboChip(item),
      poppedOut: false,
      error: "",
      pageTitle: "",
      bootSession: {
        destination: session.destination,
        localSite: session.localSite,
        proxy: item.proxy,
        transport: item.transport,
        wispUrl: session.wispUrl,
        bareUrl: session.bareUrl,
        pane: item.id,
        comboId: item.id,
      },
    }));
    runtime.activeId = runtime.combos[0]?.id || "";
    proxyFrame?.classList.add("hidden");
    comboFramesEl?.classList.remove("hidden");
    frameWrap?.classList.remove("hidden");
    renderComboTabs();
    syncVisibility();
    setStatus(liveStatus, "Starting test combos…");
    const results = await Promise.allSettled(runtime.combos.map((combo) => bootComboIframe(combo)));
    const failed = [];
    results.forEach((result, index) => {
      const combo = runtime.combos[index];
      if (result.status === "rejected") {
        combo.error = result.reason?.message || String(result.reason);
        failed.push(`${combo.label}: ${combo.error}`);
      }
    });
    if (failed.length === runtime.combos.length) {
      throw new Error(`Every combo failed to start. ${failed.join(" | ")}`);
    }
    if (runtime.combos[0]?.error) {
      runtime.activeId = runtime.combos.find((combo) => !combo.error)?.id || runtime.activeId;
    }
    syncVisibility();
    renderComboTabs();
    onActiveChanged?.(activeCombo());
    const running = runtime.combos.length - failed.length;
    if (failed.length) {
      setStatus(liveStatus, `Running ${running} of ${runtime.combos.length} combos. Failed: ${failed.join(" | ")}`, true);
    } else {
      setStatus(liveStatus, `Running ${running} combo${running === 1 ? "" : "s"}.`);
    }
    return { running, failed };
  }

  function setPageTitle(id, title) {
    const combo = comboById(id);
    if (!combo) return false;
    const next = String(title || "").trim();
    if (combo.pageTitle === next) return false;
    combo.pageTitle = next;
    return true;
  }

  function clearDom() {
    if (comboFramesEl) comboFramesEl.innerHTML = "";
    runtime.ready.clear();
  }

  async function end() {
    const popped = runtime.combos.filter((combo) => combo.poppedOut);
    for (const combo of runtime.combos) combo.poppedOut = false;
    for (const combo of popped) {
      await window.pdtk.closeComboWindow({ comboId: combo.id });
    }
    clearDom();
    runtime.combos = [];
    runtime.activeId = "";
    comboFramesEl?.classList.add("hidden");
    proxyFrame?.classList.remove("hidden");
    tabStrip?.classList.add("hidden");
    document.getElementById("live-combo-label")?.classList.add("hidden");
    document.getElementById("combo-popout")?.classList.add("hidden");
  }

  async function removeCombo(id) {
    const combo = comboById(id);
    if (!combo) return;
    const wasPopped = combo.poppedOut;
    combo.poppedOut = false;
    iframeFor(id)?.remove();
    runtime.combos = runtime.combos.filter((item) => item.id !== id);
    runtime.ready.delete(id);
    if (wasPopped) await window.pdtk.closeComboWindow({ comboId: id });
    if (!runtime.combos.length) {
      await end();
      onActiveChanged?.(null);
      return;
    }
    if (runtime.activeId === id) runtime.activeId = runtime.combos[0].id;
    syncVisibility();
    renderComboTabs();
    onActiveChanged?.(activeCombo());
  }

  async function togglePopout(id) {
    const combo = comboById(id);
    if (!combo) return;
    if (combo.poppedOut) {
      await window.pdtk.focusComboWindow({ comboId: id });
      return;
    }
    const iframe = iframeFor(id);
    combo.poppedOut = true;
    if (iframe) iframe.classList.add("hidden");
    const result = await window.pdtk.openComboWindow({
      comboId: id,
      origin: combo.origin,
      title: `PDTK · ${combo.label}`,
      session: {
        ...combo.bootSession,
        destination: combo.bootSession.destination,
        screen: screenPrefs(),
        eruda: erudaEnabled(),
      },
    });
    if (!result?.ok) {
      combo.poppedOut = false;
      setStatus(liveStatus, result?.error || "Could not pop out combo.", true);
      syncVisibility();
      renderComboTabs();
      return;
    }
    if (iframe) {
      iframe.src = "about:blank";
    }
    renderComboTabs();
    onActiveChanged?.(activeCombo());
  }

  async function dockBack(id) {
    const combo = comboById(id);
    if (!combo || !combo.poppedOut) return;
    combo.poppedOut = false;
    try {
      await bootComboIframe(combo);
      combo.error = "";
    } catch (error) {
      combo.error = error.message || String(error);
      setStatus(liveStatus, `${combo.label} failed: ${combo.error}`, true);
    }
    syncVisibility();
    renderComboTabs();
    onActiveChanged?.(activeCombo());
  }

  function markReady(paneOrId) {
    runtime.ready.set(paneOrId, true);
  }

  return {
    runtime,
    start,
    end,
    focusCombo,
    activeCombo,
    postToActive,
    postToAll,
    postToCombo,
    removeCombo,
    togglePopout,
    dockBack,
    markReady,
    setPageTitle,
    renderComboTabs,
    syncLiveComboSelect,
  };
}
