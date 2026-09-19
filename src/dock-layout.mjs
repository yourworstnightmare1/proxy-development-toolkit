const GRIP = 32;

function area(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersects(a, b) {
  return a.x < b.x + b.width - 8
    && a.x + a.width > b.x + 8
    && a.y < b.y + b.height - 8
    && a.y + a.height > b.y + 8;
}

export const INFO_MIN_WIDTH = 220;
export const INFO_MIN_HEIGHT = 160;
export const INSPECT_MIN_WIDTH = 320;
export const INSPECT_MIN_HEIGHT = 180;
export const INSPECT_HANDLE = 6;
export const INSPECT_CORNER = 12;
const INFO_PAGE_KEEP = 240;

export function clampInfoSpan(value, min, viewport) {
  const span = Math.max(1, viewport);
  const limit = Math.min(span, Math.max(min, span - INFO_PAGE_KEEP));
  const floor = Math.min(min, span);
  return Math.round(Math.min(limit, Math.max(floor, Number(value) || floor)));
}

function usesWidth(slot) {
  return slot !== "top" && slot !== "bottom";
}

function usesHeight(slot) {
  return slot === "top" || slot === "bottom" || slot === "nw" || slot === "ne" || slot === "sw" || slot === "se";
}

function fitPanelSize(slot, viewport, custom, minWidth, minHeight) {
  if (!custom) return custom;
  const next = { ...custom };
  if (Number.isFinite(next.width) && usesWidth(slot)) {
    next.width = clampInfoSpan(next.width, minWidth, viewport.width);
  }
  if (Number.isFinite(next.height) && usesHeight(slot)) {
    next.height = clampInfoSpan(next.height, minHeight, viewport.height);
  }
  return next;
}

export function fitInfoSize(slot, viewport, custom) {
  return fitPanelSize(slot, viewport, custom, INFO_MIN_WIDTH, INFO_MIN_HEIGHT);
}

export function fitInspectSize(slot, viewport, custom) {
  return fitPanelSize(slot, viewport, custom, INSPECT_MIN_WIDTH, INSPECT_MIN_HEIGHT);
}

export function facingEdge(slot) {
  switch (slot) {
    case "right": return "left";
    case "top": return "bottom";
    case "bottom": return "top";
    case "nw": return "se";
    case "ne": return "sw";
    case "sw": return "ne";
    case "se": return "nw";
    default: return "right";
  }
}

export function insetInspectView(slot, view) {
  const edge = facingEdge(slot);
  const hit = edge.length === 2 ? INSPECT_CORNER : INSPECT_HANDLE;
  const next = { ...view };
  if (edge === "left" || edge === "nw" || edge === "sw") {
    next.x += hit;
    next.width -= hit;
  } else if (edge === "right" || edge === "ne" || edge === "se") {
    next.width -= hit;
  }
  if (edge === "top" || edge === "nw" || edge === "ne") {
    next.y += hit;
    next.height -= hit;
  } else if (edge === "bottom" || edge === "sw" || edge === "se") {
    next.height -= hit;
  }
  next.width = Math.max(40, Math.round(next.width));
  next.height = Math.max(40, Math.round(next.height));
  next.x = Math.round(next.x);
  next.y = Math.round(next.y);
  return next;
}

function defaultRect(slot, size) {
  const { width, height } = size;
  const side = Math.min(720, Math.max(480, Math.round(width * 0.46)));
  const fitted = Math.min(side, Math.max(280, width - 240));
  const band = Math.min(360, Math.max(220, Math.round(height * 0.38)));
  const cw = Math.min(fitted, Math.max(280, Math.round(width * 0.46)));
  const ch = Math.min(band, Math.max(200, Math.round(height * 0.5)));
  switch (slot) {
    case "right": return { x: Math.max(0, width - fitted), y: 0, width: Math.min(fitted, width), height };
    case "top": return { x: 0, y: 0, width, height: Math.min(band, height) };
    case "bottom": return { x: 0, y: Math.max(0, height - band), width, height: Math.min(band, height) };
    case "nw": return { x: 0, y: 0, width: cw, height: ch };
    case "ne": return { x: Math.max(0, width - cw), y: 0, width: Math.min(cw, width), height: ch };
    case "sw": return { x: 0, y: Math.max(0, height - ch), width: cw, height: Math.min(ch, height) };
    case "se": return { x: Math.max(0, width - cw), y: Math.max(0, height - ch), width: Math.min(cw, width), height: Math.min(ch, height) };
    default: return { x: 0, y: 0, width: Math.min(fitted, width), height };
  }
}

function placeAnchored(slot, size, width, height) {
  const vw = size.width;
  const vh = size.height;
  const w = Math.min(width, vw);
  const h = Math.min(height, vh);
  const x = slot === "right" || slot === "ne" || slot === "se" ? Math.max(0, vw - w) : 0;
  const y = slot === "bottom" || slot === "sw" || slot === "se" ? Math.max(0, vh - h) : 0;
  return { x, y, width: w, height: h };
}

function rectFor(slot, size, custom, minWidth = INFO_MIN_WIDTH, minHeight = INFO_MIN_HEIGHT) {
  const base = defaultRect(slot, size);
  const customWidth = custom && Number.isFinite(custom.width) ? custom.width : null;
  const customHeight = custom && Number.isFinite(custom.height) ? custom.height : null;
  if (customWidth == null && customHeight == null) return base;
  let width = base.width;
  let height = base.height;
  if (customWidth != null && usesWidth(slot)) width = clampInfoSpan(customWidth, minWidth, size.width);
  if (customHeight != null && usesHeight(slot)) height = clampInfoSpan(customHeight, minHeight, size.height);
  if (!usesWidth(slot)) width = size.width;
  if (!usesHeight(slot)) height = size.height;
  return placeAnchored(slot, size, width, height);
}

function shrinkAway(panel, obstacle) {
  const options = [
    { x: panel.x, y: obstacle.y + obstacle.height, width: panel.width, height: panel.y + panel.height - (obstacle.y + obstacle.height) },
    { x: panel.x, y: panel.y, width: panel.width, height: obstacle.y - panel.y },
    { x: obstacle.x + obstacle.width, y: panel.y, width: panel.x + panel.width - (obstacle.x + obstacle.width), height: panel.height },
    { x: panel.x, y: panel.y, width: obstacle.x - panel.x, height: panel.height },
  ].filter((rect) => rect.width >= 200 && rect.height >= 140);
  if (!options.length) return null;
  options.sort((a, b) => area(b) - area(a));
  return options[0];
}

const OPPOSITE = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
  nw: "se",
  ne: "sw",
  sw: "ne",
  se: "nw",
};

function insetsFrom(rects, size) {
  const insets = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const rect of rects) {
    if (!rect) continue;
    if (rect.x <= 1 && rect.height >= size.height * 0.85) insets.left = Math.max(insets.left, rect.width);
    if (rect.x + rect.width >= size.width - 1 && rect.height >= size.height * 0.85) {
      insets.right = Math.max(insets.right, size.width - rect.x);
    }
    if (rect.y <= 1 && rect.width >= size.width * 0.85) insets.top = Math.max(insets.top, rect.height);
    if (rect.y + rect.height >= size.height - 1 && rect.width >= size.width * 0.85) {
      insets.bottom = Math.max(insets.bottom, size.height - rect.y);
    }
  }
  return insets;
}

export function slotFromPoint(x, y, width, height) {
  const corner = 120;
  const nearLeft = x <= corner;
  const nearRight = x >= width - corner;
  const nearTop = y <= corner;
  const nearBottom = y >= height - corner;
  if (nearLeft && nearTop) return "nw";
  if (nearRight && nearTop) return "ne";
  if (nearLeft && nearBottom) return "sw";
  if (nearRight && nearBottom) return "se";
  if (x <= 72) return "left";
  if (x >= width - 72) return "right";
  if (y <= 72) return "top";
  if (y >= height - 72) return "bottom";
  const edges = [
    ["left", x],
    ["right", width - x],
    ["top", y],
    ["bottom", height - y],
  ];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0][0];
}

export function splitGrip(rect) {
  return {
    view: {
      x: rect.x,
      y: rect.y + GRIP,
      width: rect.width,
      height: Math.max(40, rect.height - GRIP),
    },
    grip: { x: rect.x, y: rect.y, width: rect.width, height: GRIP },
  };
}

export function layoutPanels({ infoSlot, inspectSlot, size, infoCollapsed, inspectOpen = true, prefer, infoSize, inspectSize }) {
  let inspect = inspectOpen
    ? rectFor(inspectSlot, size, inspectSize, INSPECT_MIN_WIDTH, INSPECT_MIN_HEIGHT)
    : null;
  let info = infoCollapsed ? null : rectFor(infoSlot, size, infoSize);
  if (info && inspect && intersects(info, inspect)) {
    if (prefer === "info") {
      inspect = shrinkAway(inspect, info) || rectFor(OPPOSITE[inspectSlot] || "right", size, inspectSize, INSPECT_MIN_WIDTH, INSPECT_MIN_HEIGHT);
    } else {
      info = shrinkAway(info, inspect) || rectFor(OPPOSITE[infoSlot] || "left", size, infoSize);
    }
  }
  return {
    info,
    inspect,
    inspectParts: inspect ? splitGrip(inspect) : null,
    insets: insetsFrom([info, inspect], size),
  };
}
