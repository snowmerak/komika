import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(__dirname, "..");
const srcFile = join(frontendRoot, "src", "viewer.ts");
const require = createRequire(import.meta.url);

function resolveTsc() {
  try {
    return require.resolve("typescript/bin/tsc");
  } catch {
    return join(frontendRoot, "node_modules", "typescript", "bin", "tsc");
  }
}

const outDir = mkdtempSync(join(tmpdir(), "komika-viewer-"));

try {
  const tsc = resolveTsc();
  const args = [
    srcFile,
    "--target",
    "ES2020",
    "--module",
    "ES2020",
    "--moduleResolution",
    "node",
    "--lib",
    "DOM,ES2020",
    "--strict",
    "--skipLibCheck",
    "--outDir",
    outDir,
  ];
  const result = spawnSync(process.execPath, [tsc, ...args], {
    encoding: "utf8",
    cwd: frontendRoot,
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`tsc failed with status ${result.status}`);
  }
  const outFile = join(outDir, "viewer.js");
  if (!existsSync(outFile)) {
    throw new Error(`compiled output missing: ${outFile}`);
  }
  // Ensure Node treats compiled output as ESM (temp dir has no package.json).
  writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }));
  const mod = await import(pathToFileURL(outFile).href);

  const {
    loadViewPreferences,
    saveViewPreferences,
    clampZoom,
    computeBaseScale,
    clampPan,
    spreadForPage,
    cacheIndices,
    orderPageLoadIndices,
    mediaKindForMime,
    shouldLoadMediaDelivery,
    releaseHtmlMediaElement,
    VIEW_PREFERENCES_KEY,
  } = mod;

  // --- fit / stretch ---
  const stage = { width: 800, height: 600 };
  const large = { width: 1600, height: 900 };
  const small = { width: 200, height: 100 };

  assert.equal(
    computeBaseScale(stage, large, "fitWindow", false),
    Math.min(800 / 1600, 600 / 900)
  );
  assert.equal(computeBaseScale(stage, large, "fitWidth", false), 800 / 1600);
  assert.equal(computeBaseScale(stage, large, "fitHeight", false), 600 / 900);
  assert.equal(computeBaseScale(stage, large, "original", false), 1);
  assert.equal(
    computeBaseScale(stage, large, "doubleLTR", false),
    Math.min(800 / 1600, 600 / 900)
  );
  assert.equal(computeBaseScale(stage, large, "webtoon", false), 800 / 1600);

  // stretchSmall=false caps automatic fit at 1
  assert.equal(computeBaseScale(stage, small, "fitWindow", false), 1);
  assert.equal(computeBaseScale(stage, small, "fitWidth", false), 1);
  // stretchSmall=true allows upscale
  assert.equal(computeBaseScale(stage, small, "fitWindow", true), Math.min(800 / 200, 600 / 100));
  assert.equal(computeBaseScale(stage, small, "fitWidth", true), 800 / 200);
  // original always 1 even with stretch
  assert.equal(computeBaseScale(stage, small, "original", true), 1);

  // --- zoom / pan clamps ---
  assert.equal(clampZoom(10), 25);
  assert.equal(clampZoom(1000), 800);
  assert.equal(clampZoom(150), 150);
  assert.equal(clampZoom(250, 200), 200);
  assert.equal(clampZoom(Number.NaN), 100);

  // Fitting content: pan forced to 0
  assert.deepEqual(
    clampPan({ width: 800, height: 600 }, { width: 400, height: 300 }, 50, -20),
    { x: 0, y: 0 }
  );
  // Overflow: half overflow bounds
  assert.deepEqual(
    clampPan({ width: 100, height: 100 }, { width: 200, height: 300 }, 1000, -1000),
    { x: 50, y: -100 }
  );
  assert.deepEqual(
    clampPan({ width: 100, height: 100 }, { width: 200, height: 300 }, -1000, 1000),
    { x: -50, y: 100 }
  );

  // --- spreads / page normalization ---
  assert.deepEqual(spreadForPage(0, 5, "doubleLTR"), [0, 1]);
  assert.deepEqual(spreadForPage(1, 5, "doubleLTR"), [0, 1]);
  assert.deepEqual(spreadForPage(2, 5, "doubleLTR"), [2, 3]);
  assert.deepEqual(spreadForPage(3, 5, "doubleLTR"), [2, 3]);
  assert.deepEqual(spreadForPage(4, 5, "doubleLTR"), [4]);
  assert.deepEqual(spreadForPage(4, 5, "doubleRTL"), [4]);
  assert.deepEqual(spreadForPage(2, 5, "doubleRTL"), [3, 2]);
  assert.deepEqual(spreadForPage(0, 5, "doubleRTL"), [1, 0]);
  assert.deepEqual(spreadForPage(0, 0, "doubleLTR"), []);
  assert.deepEqual(spreadForPage(99, 5, "doubleLTR"), [4]);

  // --- cache boundaries ---
  assert.deepEqual([...cacheIndices(0, 0, "fitWindow")].sort((a, b) => a - b), []);
  assert.deepEqual([...cacheIndices(2, 5, "fitWindow")].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...cacheIndices(0, 5, "fitWidth")].sort((a, b) => a - b), [0, 1]);
  assert.deepEqual([...cacheIndices(4, 5, "original")].sort((a, b) => a - b), [3, 4]);
  // webtoon active±2
  assert.deepEqual([...cacheIndices(2, 10, "webtoon")].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.deepEqual([...cacheIndices(0, 3, "webtoon")].sort((a, b) => a - b), [0, 1, 2]);
  // double: current + prev/next spreads (lower 2 => spreads 0,2,4)
  assert.deepEqual(
    [...cacheIndices(2, 5, "doubleLTR")].sort((a, b) => a - b),
    [0, 1, 2, 3, 4]
  );
  assert.deepEqual(
    [...cacheIndices(0, 5, "doubleRTL")].sort((a, b) => a - b),
    [0, 1, 2, 3]
  );

  // --- page load ordering ---
  assert.deepEqual(orderPageLoadIndices([1, 2, 3], 2, new Set([2])), [2, 1, 3]);
  assert.deepEqual(
    orderPageLoadIndices([0, 1, 2, 3, 4], 2, new Set([1, 2])),
    [2, 1, 3, 0, 4]
  );
  assert.deepEqual(orderPageLoadIndices([], 2, new Set()), []);
  assert.deepEqual(orderPageLoadIndices([2, 1, 2, 3, 1], 2, new Set([2])), [2, 1, 3]);

  // --- Storage cases ---
  function makeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem(key) {
        return map.has(key) ? map.get(key) : null;
      },
      setItem(key, value) {
        map.set(key, String(value));
      },
      removeItem(key) {
        map.delete(key);
      },
      clear() {
        map.clear();
      },
      key(i) {
        return [...map.keys()][i] ?? null;
      },
      get length() {
        return map.size;
      },
      _map: map,
    };
  }

  // invalid JSON
  {
    const s = makeStorage({ [VIEW_PREFERENCES_KEY]: "{not json" });
    const prefs = loadViewPreferences(s);
    assert.deepEqual(prefs, {
      mode: "fitWindow",
      stretchSmall: false,
      imageRendering: "smooth",
    });
    assert.equal(s.getItem(VIEW_PREFERENCES_KEY), JSON.stringify(prefs));
  }

  // unknown mode
  {
    const s = makeStorage({
      [VIEW_PREFERENCES_KEY]: JSON.stringify({ mode: "nope", stretchSmall: true }),
    });
    const prefs = loadViewPreferences(s);
    assert.deepEqual(prefs, {
      mode: "fitWindow",
      stretchSmall: true,
      imageRendering: "smooth",
    });
  }

  // mixed valid/invalid fields
  {
    const s = makeStorage({
      [VIEW_PREFERENCES_KEY]: JSON.stringify({ mode: "webtoon", stretchSmall: "yes", extra: 1 }),
    });
    const prefs = loadViewPreferences(s);
    assert.deepEqual(prefs, {
      mode: "webtoon",
      stretchSmall: false,
      imageRendering: "smooth",
    });
  }

  // throwing getItem
  {
    const s = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {},
    };
    assert.deepEqual(loadViewPreferences(s), {
      mode: "fitWindow",
      stretchSmall: false,
      imageRendering: "smooth",
    });
  }

  // throwing setItem
  {
    const s = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("quota");
      },
    };
    // should not throw
    saveViewPreferences(s, {
      mode: "fitWidth",
      stretchSmall: true,
      imageRendering: "pixelated",
    });
  }

  // normalized writeback on valid load still rewrites when extra keys present
  {
    const s = makeStorage({
      [VIEW_PREFERENCES_KEY]: JSON.stringify({
        mode: "fitHeight",
        stretchSmall: true,
        imageRendering: "pixelated",
        junk: true,
      }),
    });
    const prefs = loadViewPreferences(s);
    assert.deepEqual(prefs, {
      mode: "fitHeight",
      stretchSmall: true,
      imageRendering: "pixelated",
    });
    assert.equal(s.getItem(VIEW_PREFERENCES_KEY), JSON.stringify(prefs));
  }

  // empty storage returns defaults without write requirement
  {
    const s = makeStorage();
    const prefs = loadViewPreferences(s);
    assert.deepEqual(prefs, {
      mode: "fitWindow",
      stretchSmall: false,
      imageRendering: "smooth",
    });
  }

  // legacy 2-field prefs normalize to smooth imageRendering and rewrite
  {
    const s = makeStorage({
      [VIEW_PREFERENCES_KEY]: JSON.stringify({ mode: "fitWidth", stretchSmall: true }),
    });
    const prefs = loadViewPreferences(s);
    assert.deepEqual(prefs, {
      mode: "fitWidth",
      stretchSmall: true,
      imageRendering: "smooth",
    });
    assert.equal(s.getItem(VIEW_PREFERENCES_KEY), JSON.stringify(prefs));
  }

  // invalid imageRendering falls back to smooth
  {
    const s = makeStorage({
      [VIEW_PREFERENCES_KEY]: JSON.stringify({
        mode: "original",
        stretchSmall: false,
        imageRendering: "crisp",
      }),
    });
    const prefs = loadViewPreferences(s);
    assert.deepEqual(prefs, {
      mode: "original",
      stretchSmall: false,
      imageRendering: "smooth",
    });
  }

  // --- mediaKindForMime ---
  assert.equal(mediaKindForMime("image/gif"), "image");
  assert.equal(mediaKindForMime("image/png"), "image");
  assert.equal(mediaKindForMime("IMAGE/JPEG"), "image");
  assert.equal(mediaKindForMime("video/webm"), "video");
  assert.equal(mediaKindForMime("video/mp4"), "video");
  assert.equal(mediaKindForMime("video/quicktime"), "video");
  assert.equal(mediaKindForMime("audio/mpeg"), "audio");
  assert.equal(mediaKindForMime("audio/mp4"), "audio");
  assert.equal(mediaKindForMime("audio/aac"), "audio");
  assert.equal(mediaKindForMime("audio/ogg"), "audio");
  assert.equal(mediaKindForMime("audio/opus"), "audio");
  assert.equal(mediaKindForMime("audio/wav"), "audio");
  assert.equal(mediaKindForMime("audio/flac"), null);
  assert.equal(mediaKindForMime("video/x-msvideo"), null);
  assert.equal(mediaKindForMime("application/octet-stream"), null);
  assert.equal(mediaKindForMime(""), null);

  // --- shouldLoadMediaDelivery ---
  // small RPC images may prefetch offscreen
  assert.equal(shouldLoadMediaDelivery("rpc", "image", 2, new Set([0])), true);
  // stream images require visibility
  assert.equal(shouldLoadMediaDelivery("stream", "image", 2, new Set([0])), false);
  assert.equal(shouldLoadMediaDelivery("stream", "image", 0, new Set([0])), true);
  // videos require visibility regardless of delivery
  assert.equal(shouldLoadMediaDelivery("rpc", "video", 2, new Set([0])), false);
  assert.equal(shouldLoadMediaDelivery("stream", "video", 2, new Set([0, 1])), false);
  assert.equal(shouldLoadMediaDelivery("rpc", "video", 1, new Set([0, 1])), true);
  assert.equal(shouldLoadMediaDelivery("stream", "video", 1, new Set([0, 1])), true);
  // audio requires visibility regardless of delivery
  assert.equal(shouldLoadMediaDelivery("rpc", "audio", 2, new Set([0])), false);
  assert.equal(shouldLoadMediaDelivery("stream", "audio", 2, new Set([0, 1])), false);
  assert.equal(shouldLoadMediaDelivery("rpc", "audio", 1, new Set([0, 1])), true);
  assert.equal(shouldLoadMediaDelivery("stream", "audio", 1, new Set([0, 1])), true);
  // unknown kind never loads
  assert.equal(shouldLoadMediaDelivery("rpc", null, 0, new Set([0])), false);

  // --- releaseHtmlMediaElement ---
  {
    const calls = [];
    const el = {
      pause: () => calls.push("pause"),
      removeAttribute: (name) => calls.push(`removeAttribute:${name}`),
      load: () => calls.push("load"),
    };
    releaseHtmlMediaElement(el);
    assert.deepEqual(calls, ["pause", "removeAttribute:src", "load"]);
  }
  console.log("test-viewer: ok");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
