"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const { once } = require("events");

const REPORT_INTERVAL_MS = 150;
const SPEED_WINDOW_MS = 250;

function createTracker(report, total) {
  const started = Date.now();
  let sampleAt = started;
  let sampleBytes = 0;
  let speed = 0;
  let lastReport = 0;
  let received = 0;

  function emit(extra = {}) {
    const now = Date.now();
    const elapsed = Math.max((now - started) / 1000, 0.001);
    const rate = speed || received / elapsed;
    report({
      received,
      total: total || null,
      percent: total ? Math.min(100, (received / total) * 100) : null,
      bytesPerSecond: rate,
      etaSeconds: total && rate > 0 ? Math.max(0, (total - received) / rate) : null,
      ...extra,
    });
  }

  return {
    update(bytes) {
      received = bytes;
      const now = Date.now();
      const window = now - sampleAt;
      if (window >= SPEED_WINDOW_MS) {
        const instant = ((received - sampleBytes) * 1000) / window;
        speed = speed ? speed * 0.7 + instant * 0.3 : instant;
        sampleAt = now;
        sampleBytes = received;
      }
      if (now - lastReport < REPORT_INTERVAL_MS) return;
      lastReport = now;
      emit();
    },
    start() {
      emit();
    },
    finish() {
      if (total) received = Math.max(received, total);
      emit({ done: true, percent: 100, etaSeconds: 0 });
    },
    fail(error) {
      emit({ error: error.message || String(error) });
    },
  };
}

// Reads a fetch Response body chunk by chunk, reporting progress along the way.
async function streamResponse(response, { onProgress, onChunk, max, tooLarge = "Download is too large." } = {}) {
  const total = Number(response.headers.get("content-length") || 0) || 0;
  if (max && total > max) throw new Error(tooLarge);
  const tracker = createTracker(onProgress || (() => {}), total);
  tracker.start();
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (max && received > max) {
        await reader.cancel().catch(() => {});
        throw new Error(tooLarge);
      }
      await onChunk(value);
      tracker.update(received);
    }
  } catch (error) {
    tracker.fail(error);
    throw error;
  }
  tracker.finish();
  return received;
}

async function downloadToBuffer(url, { headers, onProgress, max, tooLarge } = {}) {
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const chunks = [];
  await streamResponse(response, {
    onProgress,
    max,
    tooLarge,
    onChunk: (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
  });
  return Buffer.concat(chunks);
}

async function downloadToFile(url, file, { headers, onProgress } = {}) {
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const partial = `${file}.part`;
  const out = fs.createWriteStream(partial);
  try {
    await streamResponse(response, {
      onProgress,
      onChunk: async (chunk) => {
        if (!out.write(Buffer.from(chunk))) await once(out, "drain");
      },
    });
    out.end();
    await once(out, "finish");
    await fsp.rm(file, { force: true });
    await fsp.rename(partial, file);
  } catch (error) {
    out.destroy();
    await fsp.rm(partial, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

module.exports = { streamResponse, downloadToBuffer, downloadToFile };
