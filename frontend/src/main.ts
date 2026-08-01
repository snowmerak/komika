import "merak-protocol-design-system/style.css";
import "./style.css";
import { ComicService } from "../bindings/komika";
import type { Comic, DesktopIntegrationStatus, LibrarySettings, LibraryState, RecentComic } from "../bindings/komika";
import { Events, Window as WailsWindow } from "@wailsio/runtime";
import { renderMerakMarkdown } from "merak-protocol-design-system/markdown";
import {
  cacheIndices,
  clampPan,
  clampZoom,
  computeBaseScale,
  loadViewPreferences,
  mediaKindForMime,
  mediaPlaybackFallbackMessage,
  nextPageLoadQueueIndex,
  orderPageLoadIndices,
  saveViewPreferences,
  releaseHtmlMediaElement,
  shouldKeepWebtoonDomMedia,
  shouldLoadMediaDelivery,
  shouldRetainCachedMedia,
  spreadForPage,
  type ImageRendering,
  type ManualTransform,
  type MediaKind,
  type Size,
  type ViewMode,
  type ViewPreferences,
  isMeaningfulVideoProgress,
  isPageWithinRadius,
  accumulateVideoProgress,
  decideStallWatchdog,
  shouldAutoResumeVideo,
  isUserIntentionalPause,
  shouldClickToPlayVideo,
  shouldHardKickPlaybackOnDiagnosticsClose,
  shouldRemountCachedMedia,
  shouldReviveVideoAfterEnded,
  beginEndedRevive,
  applyVideoPlaybackChrome,
  captureVideoPlaybackChrome,
  shouldSoftLoopAfterEnded,
} from "./viewer";
import { combinedFallbackMessage, transcodeWithWasm, WASM_TRANSCODE_MAX_BYTES } from "./media_wasm";
import {
  clampTileDest,
  drawImageRegion,
  HQ_OVERSCAN_CSS,
  pickXbrzFactor,
  shouldUpscaleHQ,
  type CanvasScaleRendering,
} from "./upscale";
import { renderUpscaleInWorker } from "./upscale_worker_client";
import { attachPdfPage, clearPdfDocCache } from "./pdf_render";

type ReadingDirection = "rtl" | "ltr";
type HistoryAction = "disableSaving" | "removeSelected" | "clearAll";

interface AppState {
  library: LibraryState | null;
  comic: Comic | null;
  pageIndex: number;
  readingDirection: ReadingDirection;
  loading: boolean;
  error: string | null;
  viewPreferences: ViewPreferences;
  manualTransform: ManualTransform;
  webtoonPageRatios: Map<number, number>;
  webtoonActiveIndex: number;
  historySettingsOpen: boolean;
  selectedRecentPaths: Set<string>;
  pendingHistoryAction: HistoryAction | null;
  toolbarCollapsed: boolean;
  desktopIntegration: DesktopIntegrationStatus | null;
}

const DIRECTION_KEY = "komika.readingDirection";
const TOOLBAR_COLLAPSED_KEY = "komika.readerToolbarCollapsed";
const DEFAULT_LIBRARY: LibraryState = {
  recents: [],
  settings: { saveRecents: true, retentionDays: 0 },
};

const state: AppState = {
  library: null,
  comic: null,
  pageIndex: 0,
  readingDirection: (() => {
    try {
      const raw = localStorage.getItem(DIRECTION_KEY);
      return raw === "ltr" ? "ltr" : "rtl";
    } catch {
      return "rtl";
    }
  })(),
  loading: false,
  error: null,
  viewPreferences: loadViewPreferences(localStorage),
  manualTransform: { zoomPercent: 100, panX: 0, panY: 0 },
  webtoonPageRatios: new Map(),
  webtoonActiveIndex: 0,
  historySettingsOpen: false,
  selectedRecentPaths: new Set(),
  pendingHistoryAction: null,
  desktopIntegration: null,
  toolbarCollapsed: (() => {
    try {
      return localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  })(),
};

interface CachedMedia {
  mime: string;
  kind: MediaKind;
  url: string;
  delivery: "blob" | "stream";
  /** Original source size when known (from PageDescriptor / payload). */
  sizeBytes?: number;
  streamToken?: string;
  documentPage?: number;
  documentKey?: string;
}

const MAX_CONCURRENT_PAGE_LOADS = 2;
const HQ_PAINT_DEBOUNCE_MS = 120;
const HQ_PRELOAD_RADIUS = 2;
const pageCache = new Map<number, CachedMedia>();
const pageLoads = new Map<number, Promise<CachedMedia | undefined>>();
const pageLoadDeferreds = new Map<number, Deferred<CachedMedia | undefined>>();
const pageLoadErrors = new Map<number, unknown>();
// Shared PDF document load state: one fetch + owner per documentKey.
interface PdfDocState {
  owner?: CachedMedia;
  fetch?: Promise<CachedMedia>;
  waiters: number;
  pageRefs: number;
}
const pdfDocs = new Map<string, PdfDocState>();

function releasePdfDocResources(owner: CachedMedia): void {
  if (owner.delivery === "blob") {
    URL.revokeObjectURL(owner.url);
    return;
  }
  if (owner.streamToken) {
    void ComicService.ReleasePageStream(owner.streamToken).catch(() => {});
  }
}

function maybeDisposePdfDoc(key: string): void {
  const state = pdfDocs.get(key);
  if (!state) return;
  if (state.waiters > 0 || state.pageRefs > 0 || state.fetch) return;
  if (state.owner) releasePdfDocResources(state.owner);
  pdfDocs.delete(key);
}


type PageLoadPriority = "visible" | "background";

interface PageLoadJob {
  index: number;
  generation: number;
  priority: PageLoadPriority;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const pageLoadQueue: PageLoadJob[] = [];
const pageLoadRunning = new Set<number>();
let renderGeneration = 0;
let readerCleanup: (() => void) | null = null;

function activeHQPageIndex(): number {
  return state.viewPreferences.mode === "webtoon"
    ? state.webtoonActiveIndex
    : state.pageIndex;
}

function shouldUseHQForPage(media: CachedMedia, pageIndex: number): boolean {
  if (media.kind !== "image") return false;
  const mime = media.mime.toLowerCase();
  if (mime === "image/gif" || mime.startsWith("image/gif")) return false;
  const rendering = state.viewPreferences.imageRendering;
  if (rendering !== "highQuality" && rendering !== "noHalo" && rendering !== "xbrz") {
    return false;
  }
  return isPageWithinRadius(pageIndex, activeHQPageIndex(), HQ_PRELOAD_RADIUS);
}

function mediaRenderKey(media: CachedMedia, pageIndex: number): string {
  if (media.kind !== "image") return media.url;
  const tier = shouldUseHQForPage(media, pageIndex) ? "hq" : "smooth";
  return `${media.url}|${state.viewPreferences.imageRendering}|${tier}`;
}

let pendingProgressIndex: number | null = null;
let progressWrite: Promise<void> | null = null;
let lastPersistedProgress: number | null = null;

const appRoot = document.getElementById("app")!;
const toastRegion = document.getElementById("toast-region")!;

const MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: "fitWindow", label: "Fit window" },
  { value: "fitWidth", label: "Fit width" },
  { value: "fitHeight", label: "Fit height" },
  { value: "original", label: "Original 100%" },
  { value: "doubleLTR", label: "Double page LTR" },
  { value: "doubleRTL", label: "Double page RTL" },
  { value: "webtoon", label: "Webtoon" },
];

function saveDirection(dir: ReadingDirection): void {
  try {
    localStorage.setItem(DIRECTION_KEY, dir);
  } catch {
    // ignore
  }
  state.readingDirection = dir;
}

function persistToolbarCollapsed(): void {
  try {
    localStorage.setItem(TOOLBAR_COLLAPSED_KEY, state.toolbarCollapsed ? "1" : "0");
  } catch {
    // ignore
  }
}

function setToolbarCollapsed(collapsed: boolean): void {
  if (state.toolbarCollapsed === collapsed) return;
  state.toolbarCollapsed = collapsed;
  persistToolbarCollapsed();

  const reader = appRoot.querySelector(".reader");
  if (!(reader instanceof HTMLElement)) return;

  reader.classList.toggle("reader--toolbar-collapsed", collapsed);
  const toggle = reader.querySelector(".reader__toolbar-float");
  if (toggle instanceof HTMLElement) {
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? "Expand toolbar" : "Collapse toolbar");
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function showToast(message: string, variant: "error" | "info" | "success" = "error"): void {
  state.error = message;
  toastRegion.replaceChildren();
  const alert = document.createElement("div");
  alert.className = `mp-alert mp-alert--${variant} mp-alert--floating mp-alert--compact`;
  const icon = document.createElement("div");
  icon.className = "mp-alert__icon";
  icon.textContent = variant === "error" ? "!" : "i";
  const content = document.createElement("div");
  content.className = "mp-alert__content";
  const title = document.createElement("div");
  title.className = "mp-alert__title";
  title.textContent = variant === "error" ? "Error" : "Status";
  const body = document.createElement("div");
  body.className = "mp-alert__message";
  body.textContent = message;
  content.append(title, body);
  alert.append(icon, content);
  toastRegion.append(alert);
  window.setTimeout(() => {
    if (toastRegion.contains(alert)) alert.remove();
  }, 4500);
}

function clearToast(): void {
  state.error = null;
  toastRegion.replaceChildren();
}

function svgIcon(paths: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  svg.innerHTML = paths;
  return svg;
}

function makeButton(
  label: string,
  variant: string,
  onClick: () => void,
  opts?: { iconOnly?: boolean; aria?: string; disabled?: boolean }
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `mp-button ${variant}`;
  if (opts?.aria) btn.setAttribute("aria-label", opts.aria);
  if (opts?.disabled) btn.disabled = true;
  if (!opts?.iconOnly) btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function resetManualTransform(): void {
  state.manualTransform = { zoomPercent: 100, panX: 0, panY: 0 };
}

function isDoubleMode(mode: ViewMode): mode is "doubleLTR" | "doubleRTL" {
  return mode === "doubleLTR" || mode === "doubleRTL";
}

function normalizePageIndex(index: number, pageCount: number, mode: ViewMode): number {
  if (pageCount <= 0) return 0;
  const clamped = Math.max(0, Math.min(pageCount - 1, index));
  if (isDoubleMode(mode)) return Math.floor(clamped / 2) * 2;
  return clamped;
}

function persistViewPreferences(): void {
  saveViewPreferences(localStorage, state.viewPreferences);
}

function setViewMode(mode: ViewMode): void {
  const prev = state.viewPreferences.mode;
  if (prev === mode) return;
  const enteringWebtoon = mode === "webtoon";
  const leavingWebtoon = prev === "webtoon";
  state.viewPreferences = { ...state.viewPreferences, mode };
  persistViewPreferences();
  if (mode === "doubleLTR") saveDirection("ltr");
  if (mode === "doubleRTL") saveDirection("rtl");
  if (enteringWebtoon || leavingWebtoon) {
    resetManualTransform();
  } else {
    resetManualTransform();
  }
  if (state.comic) {
    state.pageIndex = normalizePageIndex(state.pageIndex, state.comic.pageCount, mode);
    if (mode === "webtoon") state.webtoonActiveIndex = state.pageIndex;
  }
  renderGeneration += 1;
  clearQueuedPageLoads();
  pageLoads.clear();
  render();
}

function setStretchSmall(value: boolean): void {
  state.viewPreferences = { ...state.viewPreferences, stretchSmall: value };
  persistViewPreferences();
  render();
}

function setImageRendering(value: ImageRendering): void {
  if (state.viewPreferences.imageRendering === value) return;
  state.viewPreferences = { ...state.viewPreferences, imageRendering: value };
  persistViewPreferences();
  render();
}

function sourceTypeBadge(sourceType: string): string {
  if (sourceType === "folder") return "Folder";
  if (sourceType === "media") return "Media";
  return "Archive";
}

function isInteractiveToolbarTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("button, input, select, label, form, a, textarea"));
}

function librarySettings(): LibrarySettings {
  return state.library?.settings ?? DEFAULT_LIBRARY.settings;
}

function applyLibrarySnapshot(st: LibraryState | null | undefined): void {
  if (!st) {
    state.library = { ...DEFAULT_LIBRARY, recents: [] };
    state.selectedRecentPaths.clear();
    return;
  }
  state.library = {
    recents: st.recents ?? [],
    settings: st.settings ?? DEFAULT_LIBRARY.settings,
  };
  const alive = new Set((state.library.recents ?? []).map((r) => r.path));
  for (const p of [...state.selectedRecentPaths]) {
    if (!alive.has(p)) state.selectedRecentPaths.delete(p);
  }
}

function queueProgress(index: number): void {
  pendingProgressIndex = index;
  void flushProgress();
}

async function flushProgress(): Promise<void> {
  if (progressWrite) {
    await progressWrite;
  }
  while (pendingProgressIndex !== null) {
    const index = pendingProgressIndex;
    pendingProgressIndex = null;
    if (lastPersistedProgress === index) continue;
    progressWrite = (async () => {
      try {
        await ComicService.SetProgress(index);
        lastPersistedProgress = index;
      } catch (err) {
        showToast(errMessage(err));
      }
    })();
    await progressWrite;
    progressWrite = null;
  }
}

function revokeCached(media: CachedMedia | undefined): void {
  if (!media) return;

  if (media.kind === "pdf" && media.documentKey) {
    const key = media.documentKey;
    const state = pdfDocs.get(key);
    if (state && state.pageRefs > 0) {
      state.pageRefs -= 1;
      maybeDisposePdfDoc(key);
    }
    return;
  }

  if (media.delivery === "blob") {
    let shared = false;
    for (const other of pageCache.values()) {
      if (other !== media && other.url === media.url) {
        shared = true;
        break;
      }
    }
    if (!shared) URL.revokeObjectURL(media.url);
    return;
  }
  if (media.streamToken) {
    void ComicService.ReleasePageStream(media.streamToken).catch(() => {
      // openPath may already have invalidated the token
    });
  }
}

function clearQueuedPageLoads(): void {
  for (const job of pageLoadQueue) {
    const deferred = pageLoadDeferreds.get(job.index);
    if (!deferred || pageLoads.get(job.index) !== deferred.promise) continue;
    deferred.resolve(undefined);
    pageLoadDeferreds.delete(job.index);
    pageLoads.delete(job.index);
  }
  pageLoadQueue.length = 0;
  pageLoadErrors.clear();
}

function clearPageCache(): void {
  const seenStreamTokens = new Set<string>();
  const seenBlobUrls = new Set<string>();
  for (const media of pageCache.values()) {
    if (media.kind === "pdf") continue;
    if (media.delivery === "stream" && media.streamToken) {
      if (seenStreamTokens.has(media.streamToken)) continue;
      seenStreamTokens.add(media.streamToken);
      void ComicService.ReleasePageStream(media.streamToken).catch(() => {});
      continue;
    }
    if (media.delivery === "blob") {
      if (seenBlobUrls.has(media.url)) continue;
      seenBlobUrls.add(media.url);
      URL.revokeObjectURL(media.url);
    }
  }
  for (const state of pdfDocs.values()) {
    if (state.owner) releasePdfDocResources(state.owner);
  }
  pdfDocs.clear();
  pageCache.clear();
  clearQueuedPageLoads();
  pageLoads.clear();
  clearPdfDocCache();
}

function decodePayloadData(data: string | null | undefined): Uint8Array {
  if (data == null || data === "") {
    throw new Error("empty page payload data");
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function makeUnavailableMediaCard(
  message: string,
  mediaUrl?: string,
  diagnostics?: string | null
): HTMLElement {
  const card = document.createElement("div");
  card.className = "reader__media reader__media--error";
  card.setAttribute("role", "img");
  if (mediaUrl) card.dataset.mediaUrl = mediaUrl;

  const msg = document.createElement("div");
  msg.className = "reader__media-error-msg";
  msg.textContent = message;
  card.append(msg);

  const detailText = typeof diagnostics === "string" ? diagnostics.trim() : "";
  if (detailText) {
    const details = document.createElement("details");
    details.className = "reader__media-diagnostics";
    const summary = document.createElement("summary");
    summary.textContent = "Technical details";
    const pre = document.createElement("pre");
    pre.className = "reader__media-diagnostics-body";
    pre.textContent = detailText;
    details.append(summary, pre);
    card.append(details);
  }
  return card;
}

/** Stable multi-line dump for video/audio failure accordion. */
function formatMediaDiagnostics(lines: ReadonlyArray<string>): string {
  return lines.filter((l) => l.length > 0).join("\n");
}


/** Prefer codec-parameter probes; bare video/mp4 often returns "maybe" without H.264. */
function hostLikelySupportsAV(kind: "video" | "audio", mime: string): boolean {
  const lower = (mime || "").toLowerCase();
  const el = document.createElement(kind);
  const probes: string[] = [lower];
  if (kind === "video") {
    if (lower === "video/mp4" || lower === "video/quicktime") {
      probes.push(
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        'video/mp4; codecs="avc1.4D401E, mp4a.40.2"',
        'video/mp4; codecs="avc1.64001F, mp4a.40.2"'
      );
    } else if (lower === "video/webm") {
      probes.push('video/webm; codecs="vp8, vorbis"', 'video/webm; codecs="vp9, opus"');
    }
  } else {
    if (lower === "audio/mp4" || lower === "audio/aac") {
      probes.push('audio/mp4; codecs="mp4a.40.2"', 'audio/aac');
    } else if (lower === "audio/mpeg") {
      probes.push("audio/mpeg");
    }
  }
  // Support if any probe is "probably" or at least one non-empty and not all empty for bare type only.
  let any = false;
  let probably = false;
  for (const p of probes) {
    const r = el.canPlayType(p);
    if (r === "probably") probably = true;
    if (r !== "") any = true;
  }
  if (probably) return true;
  // Bare container "maybe" without codec-specific support => treat as unsupported.
  if (probes.length > 1) {
    const codecHits = probes.slice(1).some((p) => el.canPlayType(p) !== "");
    return codecHits;
  }
  return any;
}

function makeLoadingMediaCard(message: string, mediaUrl?: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "reader__media reader__media--loading";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.textContent = message;
  if (mediaUrl) card.dataset.mediaUrl = mediaUrl;
  return card;
}

function attachMediaElement(
  host: HTMLElement,
  media: CachedMedia,
  className: string,
  alt: string,
  pageIndex: number,
  onSized: (size: Size) => void
): { el: HTMLElement; cleanup: () => void } {
  host.replaceChildren();
  if (media.kind === "image") {
    const rendering = state.viewPreferences.imageRendering;
    const mimeLower = media.mime.toLowerCase();
    const isGif = mimeLower === "image/gif" || mimeLower.startsWith("image/gif");
    const CANVAS_SCALE_RENDERINGS: ReadonlySet<ImageRendering> = new Set([
      "highQuality",
      "noHalo",
      "xbrz",
    ]);
    const useCanvasScale =
      CANVAS_SCALE_RENDERINGS.has(rendering) &&
      !isGif &&
      shouldUseHQForPage(media, pageIndex);
    const scaleRendering = rendering as CanvasScaleRendering;

    if (!useCanvasScale) {
      const img = document.createElement("img");
      const pixelated = rendering === "pixelated";
      img.className = `${className} reader__media reader__media--image${
        pixelated ? " reader__media--pixelated" : ""
      }`;
      img.alt = alt;
      img.draggable = false;
      img.dataset.mediaUrl = media.url;
      const onLoad = (): void => {
        onSized({ width: img.naturalWidth, height: img.naturalHeight });
      };
      const onError = (): void => {
        const card = makeUnavailableMediaCard("This media is unavailable.", media.url);
        card.className = `${className} ${card.className}`;
        host.replaceChildren(card);
        onSized({ width: 16, height: 9 });
      };
      img.addEventListener("load", onLoad);
      img.addEventListener("error", onError);
      img.src = media.url;
      if (img.complete && img.naturalWidth > 0) onLoad();
      host.append(img);
      return {
        el: img,
        cleanup: () => {
          img.removeEventListener("load", onLoad);
          img.removeEventListener("error", onError);
        },
      };
    }

    // Paint Smooth immediately, then replace settled HQ tiles from Go or a Web Worker.
    host.classList.add("reader__media-host--hq");

    const canvas = document.createElement("canvas");
    canvas.className = `${className} reader__media reader__media--image reader__media--hq`;
    canvas.dataset.mediaUrl = media.url;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", alt);
    canvas.style.visibility = "hidden";

    const img = document.createElement("img");
    img.decoding = "async";
    img.alt = "";
    img.draggable = false;

    let naturalW = 0;
    let naturalH = 0;
    let drawSource: CanvasImageSource | null = null;
    let bitmap: ImageBitmap | null = null;
    let hqTimer: number | null = null;
    let hqRunning = false;
    let hqPending = false;
    let hqVersion = 0;
    let disposed = false;
    let panning = false;

    interface HqTile {
      cssX: number;
      cssY: number;
      cssW: number;
      cssH: number;
      src: { x: number; y: number; w: number; h: number };
      destW: number;
      destH: number;
    }

    const computeVisibleTile = (): HqTile | null => {
      if (naturalW < 1 || naturalH < 1) return null;
      const stageEl = host.closest(".reader__stage") as HTMLElement | null;
      const hostRect = host.getBoundingClientRect();
      if (hostRect.width <= 0 || hostRect.height <= 0) return null;

      const stageRect = stageEl
        ? stageEl.getBoundingClientRect()
        : hostRect;

      let ix0 = Math.max(hostRect.left, stageRect.left);
      let iy0 = Math.max(hostRect.top, stageRect.top);
      let ix1 = Math.min(hostRect.right, stageRect.right);
      let iy1 = Math.min(hostRect.bottom, stageRect.bottom);
      if (ix1 <= ix0 || iy1 <= iy0) {
        canvas.style.visibility = "hidden";
        return null;
      }

      ix0 = Math.max(hostRect.left, ix0 - HQ_OVERSCAN_CSS);
      iy0 = Math.max(hostRect.top, iy0 - HQ_OVERSCAN_CSS);
      ix1 = Math.min(hostRect.right, ix1 + HQ_OVERSCAN_CSS);
      iy1 = Math.min(hostRect.bottom, iy1 + HQ_OVERSCAN_CSS);

      const cssX = ix0 - hostRect.left;
      const cssY = iy0 - hostRect.top;
      const cssW = ix1 - ix0;
      const cssH = iy1 - iy0;
      if (cssW < 1 || cssH < 1) {
        canvas.style.visibility = "hidden";
        return null;
      }

      const scaleToNaturalX = naturalW / hostRect.width;
      const scaleToNaturalY = naturalH / hostRect.height;
      let sx = cssX * scaleToNaturalX;
      let sy = cssY * scaleToNaturalY;
      let sw = cssW * scaleToNaturalX;
      let sh = cssH * scaleToNaturalY;

      if (sx < 0) {
        sw += sx;
        sx = 0;
      }
      if (sy < 0) {
        sh += sy;
        sy = 0;
      }
      if (sx + sw > naturalW) sw = naturalW - sx;
      if (sy + sh > naturalH) sh = naturalH - sy;
      if (sw < 1 || sh < 1) {
        canvas.style.visibility = "hidden";
        return null;
      }

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const destW0 = Math.round(cssW * dpr);
      const destH0 = Math.round(cssH * dpr);
      const { w: destW, h: destH } = clampTileDest(destW0, destH0);

      return {
        cssX,
        cssY,
        cssW,
        cssH,
        src: { x: sx, y: sy, w: sw, h: sh },
        destW,
        destH,
      };
    };

    const requestPaintCheap = (): void => {
      if (disposed || !drawSource) return;
      const tile = computeVisibleTile();
      if (!tile) return;
      canvas.style.left = `${tile.cssX}px`;
      canvas.style.top = `${tile.cssY}px`;
      canvas.style.width = `${tile.cssW}px`;
      canvas.style.height = `${tile.cssH}px`;
      if (canvas.width !== tile.destW) canvas.width = tile.destW;
      if (canvas.height !== tile.destH) canvas.height = tile.destH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      try {
        drawImageRegion(ctx, drawSource, tile.src, tile.destW, tile.destH);
        canvas.style.visibility = "visible";
      } catch {
        // keep last frame
      }
    };

    const loadHostUpscale = async (tile: HqTile): Promise<ImageBitmap> => {
      const stream = await ComicService.GetUpscaledStream({
        pageIndex,
        rendering: scaleRendering,
        sourceX: tile.src.x,
        sourceY: tile.src.y,
        sourceWidth: tile.src.w,
        sourceHeight: tile.src.h,
        destWidth: tile.destW,
        destHeight: tile.destH,
      });
      if (!stream?.url || !stream.token) throw new Error("empty upscale stream");
      try {
        const response = await fetch(stream.url);
        if (!response.ok) throw new Error(`upscale fetch failed (${response.status})`);
        return await createImageBitmap(await response.blob());
      } finally {
        void ComicService.ReleasePageStream(stream.token).catch(() => {});
      }
    };

    const loadWorkerUpscale = (tile: HqTile): Promise<ImageBitmap> =>
      renderUpscaleInWorker({
        url: media.url,
        rendering: scaleRendering,
        region: tile.src,
        destWidth: tile.destW,
        destHeight: tile.destH,
      });

    const loadHQBitmap = async (tile: HqTile): Promise<ImageBitmap> => {
      if (scaleRendering !== "highQuality") return loadWorkerUpscale(tile);
      try {
        return await loadHostUpscale(tile);
      } catch {
        return loadWorkerUpscale(tile);
      }
    };

    const runPaintHQ = async (version: number): Promise<void> => {
      if (disposed || !drawSource) {
        hqRunning = false;
        return;
      }
      const tile = computeVisibleTile();
      if (!tile) {
        hqRunning = false;
        if (hqPending) {
          hqPending = false;
          schedulePaintHQ();
        }
        return;
      }
      const scaleX = tile.destW / tile.src.w;
      const scaleY = tile.destH / tile.src.h;
      if (!shouldUpscaleHQ(scaleX, scaleY)) {
        hqRunning = false;
        if (hqPending) {
          hqPending = false;
          schedulePaintHQ();
        }
        return;
      }
      if (scaleRendering === "xbrz" && pickXbrzFactor(scaleX, scaleY) == null) {
        hqRunning = false;
        if (hqPending) {
          hqPending = false;
          schedulePaintHQ();
        }
        return;
      }

      // Ensure canvas positioned/sized (cheap may have done this).
      canvas.style.left = `${tile.cssX}px`;
      canvas.style.top = `${tile.cssY}px`;
      canvas.style.width = `${tile.cssW}px`;
      canvas.style.height = `${tile.cssH}px`;
      if (canvas.width !== tile.destW) canvas.width = tile.destW;
      if (canvas.height !== tile.destH) canvas.height = tile.destH;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        hqRunning = false;
        return;
      }

      let result: ImageBitmap | null = null;
      try {
        result = await loadHQBitmap(tile);
        if (disposed || version !== hqVersion) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(result, 0, 0, tile.destW, tile.destH);
        canvas.style.visibility = "visible";
      } catch {
        if (!disposed && version === hqVersion && drawSource) {
          try {
            drawImageRegion(ctx, drawSource, tile.src, tile.destW, tile.destH);
            canvas.style.visibility = "visible";
          } catch {
            // keep last frame
          }
        }
      } finally {
        result?.close();
        hqRunning = false;
        if (hqPending && !disposed) {
          hqPending = false;
          schedulePaintHQ();
        }
      }
    };

    const schedulePaintHQ = (): void => {
      if (disposed) return;
      hqVersion += 1;
      const version = hqVersion;
      if (hqTimer != null) {
        clearTimeout(hqTimer);
        hqTimer = null;
      }
      hqTimer = setTimeout(() => {
        hqTimer = null;
        if (disposed) return;
        if (hqRunning) {
          hqPending = true;
          return;
        }
        hqRunning = true;
        // Yield so cheap paints stay responsive during settle.
        queueMicrotask(() => {
          void runPaintHQ(version);
        });
      }, HQ_PAINT_DEBOUNCE_MS);
    };

    const scheduleFromStage = (): void => {
      requestPaintCheap();
      schedulePaintHQ();
    };

    const onStageWheel = (): void => {
      requestPaintCheap();
      schedulePaintHQ();
    };

    const onStagePointerMove = (ev: PointerEvent): void => {
      if (ev.buttons === 0 && !panning) return;
      panning = ev.buttons !== 0;
      requestPaintCheap();
      schedulePaintHQ();
    };

    const onStagePointerUp = (): void => {
      panning = false;
      requestPaintCheap();
      schedulePaintHQ();
    };

    const onStageScroll = (): void => {
      requestPaintCheap();
      schedulePaintHQ();
    };

    const stageEl = host.closest(".reader__stage") as HTMLElement | null;

    const hostRO = new ResizeObserver(() => {
      scheduleFromStage();
    });
    hostRO.observe(host);
    let stageRO: ResizeObserver | null = null;
    if (stageEl) {
      stageRO = new ResizeObserver(() => {
        scheduleFromStage();
      });
      stageRO.observe(stageEl);
      stageEl.addEventListener("scroll", onStageScroll, { passive: true });
      stageEl.addEventListener("wheel", onStageWheel, { passive: true });
      stageEl.addEventListener("pointermove", onStagePointerMove, { passive: true });
      stageEl.addEventListener("pointerup", onStagePointerUp, { passive: true });
      stageEl.addEventListener("pointercancel", onStagePointerUp, { passive: true });
    }

    let sourceInitStarted = false;

    const captureSourcePixels = async (): Promise<void> => {
      if (disposed || sourceInitStarted) return;
      naturalW = img.naturalWidth;
      naturalH = img.naturalHeight;
      if (naturalW < 1 || naturalH < 1) return;
      sourceInitStarted = true;

      onSized({ width: naturalW, height: naturalH });
      drawSource = img;
      requestPaintCheap();

      try {
        if (typeof createImageBitmap === "function") {
          const nextBitmap = await createImageBitmap(img);
          if (disposed) {
            nextBitmap.close();
            return;
          }
          if (bitmap) bitmap.close();
          bitmap = nextBitmap;
          drawSource = bitmap;
        }
      } catch {
        // keep HTMLImageElement as drawSource
      }

      if (disposed) return;
      requestPaintCheap();
      schedulePaintHQ();
    };

    const onLoad = (): void => {
      void captureSourcePixels();
    };
    const onError = (): void => {
      if (disposed) return;
      host.classList.remove("reader__media-host--hq");
      const card = makeUnavailableMediaCard("This media is unavailable.", media.url);
      card.className = `${className} ${card.className}`;
      host.replaceChildren(card);
      onSized({ width: 16, height: 9 });
    };

    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    img.src = media.url;
    if (img.complete && img.naturalWidth > 0) onLoad();

    host.append(canvas);
    return {
      el: canvas,
      cleanup: () => {
        disposed = true;
        if (hqTimer != null) {
          clearTimeout(hqTimer);
          hqTimer = null;
        }
        hostRO.disconnect();
        stageRO?.disconnect();
        if (stageEl) {
          stageEl.removeEventListener("scroll", onStageScroll);
          stageEl.removeEventListener("wheel", onStageWheel);
          stageEl.removeEventListener("pointermove", onStagePointerMove);
          stageEl.removeEventListener("pointerup", onStagePointerUp);
          stageEl.removeEventListener("pointercancel", onStagePointerUp);
        }
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
        img.src = "";
        if (bitmap) {
          bitmap.close();
          bitmap = null;
        }
        drawSource = null;
        host.classList.remove("reader__media-host--hq");
      },
    };
  }
  if (media.kind === "markdown") {
    const shell = document.createElement("div");
    shell.className = `${className} reader__media reader__media--markdown`;
    shell.dataset.mediaUrl = media.url;
    const article = document.createElement("article");
    article.className = "reader__markdown-body";
    article.textContent = "Loading…";
    shell.append(article);
    host.append(shell);
    onSized({ width: 800, height: 1200 });

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(media.url, { signal: controller.signal });
        if (!res.ok) throw new Error(`markdown fetch failed: ${res.status}`);
        const text = await res.text();
        if (controller.signal.aborted) return;
        article.innerHTML = renderMerakMarkdown(text);
        onSized({ width: 800, height: Math.max(1200, article.scrollHeight) });
      } catch (err) {
        if (controller.signal.aborted) return;
        const card = makeUnavailableMediaCard("This media is unavailable.", media.url);
        card.className = `${className} ${card.className}`;
        host.replaceChildren(card);
        onSized({ width: 16, height: 9 });
      }
    })();

    return {
      el: shell,
      cleanup: () => {
        controller.abort();
      },
    };
  }

  if (media.kind === "pdf") {
    const pageNum = media.documentPage && media.documentPage > 0 ? media.documentPage : 1;
    const cacheKey = media.documentKey ?? media.url;
    const placeholder = document.createElement("div");
    placeholder.className = `${className} reader__media reader__media--pdf-loading`;
    placeholder.dataset.mediaUrl = media.url;
    placeholder.textContent = "Loading PDF…";
    host.append(placeholder);
    onSized({ width: 612, height: 792 });

    let disposed = false;
    let pdfCleanup: (() => void) | null = null;
    void (async () => {
      try {
        const attached = await attachPdfPage(host, {
          url: media.url,
          cacheKey,
          pageNum,
          className,
          mediaUrl: media.url,
          onSized,
        });
        if (disposed) {
          attached.cleanup();
          return;
        }
        // Replace loading placeholder with canvas (attachPdfPage appends canvas).
        placeholder.remove();
        pdfCleanup = attached.cleanup;
      } catch {
        if (disposed) return;
        const card = makeUnavailableMediaCard("This media is unavailable.", media.url);
        card.className = `${className} ${card.className}`;
        host.replaceChildren(card);
        onSized({ width: 16, height: 9 });
      }
    })();

    return {
      el: placeholder,
      cleanup: () => {
        disposed = true;
        pdfCleanup?.();
      },
    };
  }

  if (media.kind === "audio") {
    const shell = document.createElement("div");
    shell.className = `${className} reader__media reader__media--audio-shell`;
    shell.dataset.mediaUrl = media.url;

    const audio = document.createElement("audio");
    audio.className = "reader__media--audio";
    audio.controls = true;
    audio.loop = true;
    audio.preload = "metadata";
    audio.setAttribute("aria-label", alt);

    let disposed = false;
    let fallbackAttempted = false;
    let fallingBack = false;
    let fallbackAbort: AbortController | null = null;
    let ownedWasmBlobUrl: string | null = null;

    const showAudioError = (message: string): void => {
      if (disposed) return;
      const card = makeUnavailableMediaCard(message, media.url);
      card.className = `${className} ${card.className}`;
      host.replaceChildren(card);
      onSized({ width: 16, height: 9 });
    };

    const onMeta = (): void => {
      onSized({ width: 16, height: 9 });
    };

    const revokeOwnedWasm = (): void => {
      if (ownedWasmBlobUrl) {
        URL.revokeObjectURL(ownedWasmBlobUrl);
        ownedWasmBlobUrl = null;
      }
    };

    const applyAudioSource = (
      url: string,
      mime: string,
      delivery: "blob" | "stream",
      token?: string
    ): void => {
      if (media.delivery === "blob" && media.url.startsWith("blob:") && media.url !== ownedWasmBlobUrl) {
        URL.revokeObjectURL(media.url);
      } else if (media.streamToken) {
        void ComicService.ReleasePageStream(media.streamToken).catch(() => {});
      }
      revokeOwnedWasm();
      if (delivery === "blob" && url.startsWith("blob:")) {
        ownedWasmBlobUrl = url;
      }
      media.url = url;
      media.mime = mime;
      media.delivery = delivery;
      media.streamToken = token;
      shell.dataset.mediaUrl = media.url;
      audio.src = media.url;
      audio.load();
      // Loading card may have replaced host children; remount the player shell.
      if (shell.parentElement !== host) {
        host.replaceChildren(shell);
      }
      onSized({ width: 16, height: 9 });
    };

    const tryWasmAudioFallback = async (priorErr: unknown): Promise<void> => {
      fallbackAbort?.abort();
      fallbackAbort = new AbortController();
      showAudioLoading("Decoding audio in-app…");
      try {
        const result = await transcodeWithWasm(media.url, media.mime, "audio", fallbackAbort.signal);
        if (disposed) return;
        applyAudioSource(URL.createObjectURL(result.blob), result.mime, "blob");
      } catch (wasmErr) {
        if (disposed) return;
        if (wasmErr instanceof DOMException && wasmErr.name === "AbortError") return;
        showAudioError(combinedFallbackMessage(priorErr, wasmErr, "audio"));
      }
    };

    const showAudioLoading = (message: string): void => {
      if (disposed) return;
      const card = makeLoadingMediaCard(message, media.url);
      card.className = `${className} ${card.className}`;
      host.replaceChildren(card);
      onSized({ width: 16, height: 9 });
    };

    const tryTranscodeFallback = (): void => {
      if (disposed || fallingBack || fallbackAttempted) return;
      fallingBack = true;
      fallbackAttempted = true;
      showAudioLoading("Preparing compatible audio…");
      const finish = (): void => {
        fallingBack = false;
      };
      if (pageIndex < 0) {
        showAudioError("Missing page index for transcoder fallback.");
        finish();
        return;
      }
      const knownSize = typeof media.sizeBytes === "number" && media.sizeBytes > 0 ? media.sizeBytes : Infinity;
      const allowWasm =
        media.delivery !== "stream" && knownSize <= WASM_TRANSCODE_MAX_BYTES;
      void ComicService.GetTranscodedStream(pageIndex)
        .then(async (stream) => {
          if (disposed) {
            if (stream?.token) void ComicService.ReleasePageStream(stream.token).catch(() => {});
            return;
          }
          if (!stream?.url || !stream.token) {
            if (allowWasm) await tryWasmAudioFallback(new Error("empty transcoder response"));
            else showAudioError("Transcoder returned an empty stream. Is ffmpeg installed?");
            return;
          }
          console.info("[komika] host audio transcode ready", stream);
          applyAudioSource(stream.url, stream.mime || "audio/ogg", "stream", stream.token);
        })
        .catch(async (err) => {
          if (disposed) return;
          console.warn("[komika] host audio transcode failed", err);
          if (allowWasm) await tryWasmAudioFallback(err);
          else showAudioError(mediaPlaybackFallbackMessage(err, "audio"));
        })
        .finally(finish);
    };

    const onError = (): void => {
      if (disposed || fallingBack) return;
      if (!fallbackAttempted) {
        tryTranscodeFallback();
        return;
      }
      showAudioError("This media is unavailable.");
    };

    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("error", onError);

    if (!hostLikelySupportsAV("audio", media.mime)) {
      tryTranscodeFallback();
    } else {
      audio.src = media.url;
    }

    shell.append(audio);
    host.append(shell);
    onSized({ width: 16, height: 9 });
    return {
      el: shell,
      cleanup: () => {
        disposed = true;
        fallbackAbort?.abort();
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("error", onError);
        releaseHtmlMediaElement(audio);
        // pageCache owns media.url; only revoke a wasm blob we created if still local-owned
        // and not adopted into the cache entry path used elsewhere.
        if (ownedWasmBlobUrl && media.url !== ownedWasmBlobUrl) {
          URL.revokeObjectURL(ownedWasmBlobUrl);
        }
        ownedWasmBlobUrl = null;
      },
    };
  }

  // Native loop=true rewinds some phone MP4s mid-file on WebKitGTK (~8s→0).
  // Soft-loop via ended→fresh element revive instead.
  const softLoop = true;
  const createVideoEl = (chrome?: { muted: boolean; volume: number; playbackRate: number }): HTMLVideoElement => {
    const el = document.createElement("video");
    el.className = `${className} reader__media reader__media--video`;
    el.controls = true;
    el.loop = false;
    el.playsInline = true;
    el.preload = "auto";
    el.setAttribute("playsinline", "");
    el.setAttribute("aria-label", alt);
    el.dataset.mediaUrl = media.url;
    if (chrome) {
      applyVideoPlaybackChrome(el, chrome);
    } else {
      // Autoplay policy: start muted until user unmutes.
      el.muted = true;
    }
    return el;
  };
  let video = createVideoEl();

  let disposed = false;
  let fallbackAttempted = false;
  let fallingBack = false;
  let fallbackStage: "none" | "remux" | "reencode" | "done" = "none";
  let fallbackAbort: AbortController | null = null;
  let ownedWasmBlobUrl: string | null = null;
  let metaTimer: number | null = null;
  /** True only after the user intentionally pauses (controls / Space / K). */
  let userPaused = false;
  /** Latched when 'ended' fires; cleared after a successful revive-from-start. */
  let reachedEnded = false;
  /** Prevent play+click double-remount after ended. */
  let revivingFromEnded = false;
  let videoListenAbort = new AbortController();
  let resumeTimer: number | null = null;
  /** performance.now() of last user media-control gesture on the video. */
  let lastMediaGestureAt: number | null = null;
  /** paused state sampled on pointerdown/keydown before the control toggles. */
  let wasPausedBeforeGesture = false;
  /** True once native (or fallback) media has produced usable forward progress. */
  let hadMeaningfulPlayback = false;
  let progressLastTime = Number.NaN;
  let progressAccum = 0;
  let stallTimer: number | null = null;
  let waitingSince: number | null = null;
  const diagLines: string[] = [];
  const diagT0 = performance.now();
  let diagPanel: HTMLElement | null = null;

  const diag = (msg: string): void => {
    const ms = Math.round(performance.now() - diagT0);
    const line = `${ms}ms ${msg}`;
    diagLines.push(line);
    if (diagLines.length > 80) diagLines.splice(0, diagLines.length - 80);
    const body = diagPanel?.querySelector(".reader__media-diagnostics-body");
    if (body) body.textContent = formatMediaDiagnostics(diagLines);
  };

  const clearMetaTimer = (): void => {
    if (metaTimer != null) {
      window.clearTimeout(metaTimer);
      metaTimer = null;
    }
  };

  const clearStallTimer = (): void => {
    if (stallTimer != null) {
      window.clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const clearResumeTimer = (): void => {
    if (resumeTimer != null) {
      window.clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  };

  const noteMediaGesture = (): void => {
    wasPausedBeforeGesture = video.paused;
    lastMediaGestureAt = performance.now();
  };

  const scheduleAutoResume = (why: string): void => {
    if (
      !shouldAutoResumeVideo({
        disposed,
        fallingBack,
        userPaused,
        isPaused: true,
        ended: video.ended,
        visibilityState: document.visibilityState,
      })
    ) {
      return;
    }
    clearResumeTimer();
    // Defer so we don't fight the same event turn that paused (controls / WebKit glitch).
    resumeTimer = window.setTimeout(() => {
      resumeTimer = null;
      if (
        !shouldAutoResumeVideo({
          disposed,
          fallingBack,
          userPaused,
          isPaused: video.paused,
          ended: video.ended,
          visibilityState: document.visibilityState,
        })
      ) {
        return;
      }
      diag(`auto-resume (${why})`);
      void video.play().catch((e) => diag(`auto-resume play() reject: ${e}`));
    }, 40);
  };

  /**
   * After ended, WebKit often ignores play(). Build a fresh <video>, rebind listeners,
   * keep the same stream URL/token (do not ReleasePageStream), start from t=0.
   */
  const reviveVideoFromStart = (why: string): void => {
    if (disposed || fallingBack) return;
    if (!beginEndedRevive(revivingFromEnded)) {
      diag(`revive skipped (in-flight) why=${why}`);
      return;
    }
    const url = media.url;
    if (!url) return;
    revivingFromEnded = true;
    diag(`revive-element (${why}) ct=${video.currentTime.toFixed(2)} softLoop=${softLoop}`);
    userPaused = false;
    reachedEnded = false;
    clearResumeTimer();
    clearStallTimer();
    clearMetaTimer();
    progressLastTime = Number.NaN;
    progressAccum = 0;
    waitingSince = null;
    lastMediaGestureAt = null;
    wasPausedBeforeGesture = false;

    const prev = video;
    const chrome = captureVideoPlaybackChrome(prev);
    // Drop listeners on the dead element first.
    videoListenAbort.abort();
    try {
      prev.pause();
    } catch {
      /* ignore */
    }
    try {
      prev.removeAttribute("src");
      prev.load();
    } catch {
      /* ignore */
    }
    prev.remove();

    video = createVideoEl(chrome);
    video.dataset.mediaUrl = url;
    videoListenAbort = new AbortController();
    bindVideoListeners();
    if (diagPanel && diagPanel.parentElement === host) {
      host.insertBefore(video, diagPanel);
    } else {
      host.append(video);
      mountDiagnosticsPanel();
    }
    video.src = url;
    const wantUnmuted = !video.muted;
    void video.play().catch((e) => {
      diag(`revive-element play() reject: ${e}`);
      // Autoplay may block unmuted revive; start muted so frames move, user can unmute.
      if (wantUnmuted && !disposed) {
        video.muted = true;
        void video.play()
          .then(() => diag("revive-element muted fallback play ok"))
          .catch((e2) => diag(`revive-element muted fallback reject: ${e2}`));
      }
    });
    window.setTimeout(() => {
      revivingFromEnded = false;
      if (disposed || fallingBack || userPaused) return;
      if (video.ended || (video.paused && video.currentTime < 0.05)) {
        diag("revive-element follow-up play");
        try {
          video.currentTime = 0;
        } catch {
          /* ignore */
        }
        void video.play().catch(() => {});
      }
    }, 100);
  };

  /**
   * Collapse diagnostics and hard-kick the media element.
   * WebKit often leaves controls in "playing" while frames are frozen; .paused
   * stays false so play()-only no-ops. A pause→play cycle matches the two
   * control clicks users need manually.
   */
  const afterDiagnosticsClosed = (): void => {
    if (
      !shouldHardKickPlaybackOnDiagnosticsClose({
        disposed,
        fallingBack,
        ended: video.ended,
      })
    ) {
      return;
    }
    userPaused = false;
    clearResumeTimer();
    const keepAt = video.currentTime;
    diag(
      `diagnostics-closed kick paused=${video.paused} ended=${video.ended} ct=${keepAt.toFixed(2)} rs=${video.readyState}`
    );
    try {
      video.pause();
    } catch {
      /* ignore */
    }
    // Next task: play after pause so WebKit applies both state transitions.
    // Restore currentTime if the engine rewound on pause/play.
    window.setTimeout(() => {
      if (disposed || fallingBack || video.ended || userPaused) return;
      try {
        if (keepAt > 0.05 && Math.abs(video.currentTime - keepAt) > 0.35) {
          video.currentTime = keepAt;
          diag(`diagnostics-closed restore ct=${keepAt.toFixed(2)}`);
        }
      } catch {
        /* ignore */
      }
      void video.play().catch((e) => diag(`diagnostics-closed play() reject: ${e}`));
    }, 0);
  };

  const removeDiagnosticsPanel = (): void => {
    diagPanel?.remove();
    diagPanel = null;
    host.classList.remove("reader__media-host--diagnostics");
  };

  const mountDiagnosticsPanel = (): void => {
    if (!diagPanel) return;
    host.classList.add("reader__media-host--diagnostics");
    // Below the video — never over native controls (WebKit click-through).
    if (diagPanel.parentElement !== host || host.lastChild !== diagPanel) {
      host.append(diagPanel);
    }
  };

  /** summary open/close without letting the gesture hit <video> (WebKit composite). */
  const wireDiagnosticsSummary = (details: HTMLDetailsElement, summary: HTMLElement): void => {
    const stop = (e: Event): void => {
      e.stopPropagation();
    };
    for (const type of ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click", "dblclick"] as const) {
      details.addEventListener(type, stop);
    }
    summary.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      try {
        summary.setPointerCapture(e.pointerId);
      } catch {
        /* capture optional */
      }
    });
    summary.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      try {
        if (summary.hasPointerCapture(e.pointerId)) {
          summary.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }
    });
    summary.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const willOpen = !details.open;
      details.open = willOpen;
      if (!willOpen) {
        // Best UX: panel closed → ensure playback continues.
        afterDiagnosticsClosed();
      }
    });
  };

  const ensureDiagnosticsPanel = (open: boolean): void => {
    if (disposed) return;
    if (!diagPanel) {
      const wrap = document.createElement("div");
      wrap.className = "reader__media-diagnostics-wrap";
      const details = document.createElement("details");
      details.className = "reader__media-diagnostics";
      details.open = open;
      const summary = document.createElement("summary");
      summary.textContent = "Playback diagnostics";
      const pre = document.createElement("pre");
      pre.className = "reader__media-diagnostics-body";
      pre.textContent = formatMediaDiagnostics(diagLines);
      details.append(summary, pre);
      wireDiagnosticsSummary(details, summary);
      wrap.append(details);
      // Guard the wrap itself as well.
      for (const type of ["pointerdown", "pointerup", "click"] as const) {
        wrap.addEventListener(type, (e) => e.stopPropagation());
      }
      diagPanel = wrap;
    } else {
      const d = diagPanel.querySelector("details");
      // Only force-open on request; never force-close (user may be reading).
      if (d && open) d.open = true;
      const body = diagPanel.querySelector(".reader__media-diagnostics-body");
      if (body) body.textContent = formatMediaDiagnostics(diagLines);
    }
    mountDiagnosticsPanel();
  };

  const resetProgressTracking = (): void => {
    hadMeaningfulPlayback = false;
    progressLastTime = Number.NaN;
    progressAccum = 0;
    waitingSince = null;
  };

  const markMeaningfulPlayback = (reason: string): void => {
    if (hadMeaningfulPlayback) return;
    hadMeaningfulPlayback = true;
    waitingSince = null;
    clearStallTimer();
    diag(`ok meaningful playback (${reason}) progressed=${progressAccum.toFixed(2)}s`);
    // Keep accordion mounted so the user can re-open logs; just collapse it.
    if (diagPanel) {
      const d = diagPanel.querySelector("details");
      if (d) d.open = false;
    }
    if (video.paused && !video.ended && !userPaused) {
      scheduleAutoResume("meaningful-playback");
    }
  };

  const showVideoError = (message: string): void => {
    if (disposed) return;
    clearMetaTimer();
    clearStallTimer();
    diag(`error-ui: ${message}`);
    const card = makeUnavailableMediaCard(message, media.url, formatMediaDiagnostics(diagLines));
    card.className = `${className} ${card.className}`;
    host.replaceChildren(card);
    diagPanel = null;
    onSized({ width: 16, height: 9 });
  };

  /** Black controls / silent decode stall: climb remux → reencode. */
  const forceStallFallback = (why: string): void => {
    const decision = decideStallWatchdog({
      disposed,
      fallingBack,
      hadMeaningfulPlayback,
      videoWidth: video.videoWidth,
      progressAccum,
      fallbackStage,
    });
    const resumeAt = video.currentTime > 0 ? video.currentTime : 0;
    diag(
      `stall-fallback: ${why} decision=${decision.action} stage=${fallbackStage} ct=${resumeAt.toFixed(2)} progressed=${progressAccum.toFixed(2)}`
    );
    if (decision.action === "noop") return;
    if (decision.action === "mark-ok") {
      markMeaningfulPlayback(why);
      return;
    }
    if (decision.openDiagnostics) ensureDiagnosticsPanel(true);
    if (decision.action === "remux") {
      tryTranscodeFallback({ stage: "remux", resumeAt });
      return;
    }
    if (decision.action === "reencode") {
      tryTranscodeFallback({ stage: "reencode", resumeAt });
      return;
    }
    showVideoError(decision.message);
  };

  const armStallWatchdog = (): void => {
    clearStallTimer();
    // Only for the initial native source before we know playback works.
    if (hadMeaningfulPlayback || fallbackStage !== "none") return;
    // 3.5s without meaningful forward progress → diagnostics + remux/reencode.
    stallTimer = window.setTimeout(() => {
      if (hadMeaningfulPlayback || fallbackStage !== "none" || fallingBack) return;
      diag(
        `stall-watchdog ct=${video.currentTime.toFixed(2)} w=${video.videoWidth}x${video.videoHeight} rs=${video.readyState} progressed=${progressAccum.toFixed(2)} err=${video.error?.code ?? "null"} stage=${fallbackStage}`
      );
      forceStallFallback("no forward progress within 3.5s");
    }, 3500);
  };

  const onMeta = (): void => {
    // Do NOT clear stall watchdog here — metadata without progress is the failure mode.
    diag(
      `loadedmetadata w=${video.videoWidth}x${video.videoHeight} rs=${video.readyState} ns=${video.networkState} dur=${Number.isFinite(video.duration) ? video.duration.toFixed(2) : "?"}`
    );
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      onSized({ width: video.videoWidth, height: video.videoHeight });
    }
    ensureDiagnosticsPanel(true);
  };

  const onPlaying = (): void => {
    diag(`playing ct=${video.currentTime.toFixed(2)} w=${video.videoWidth}x${video.videoHeight} rs=${video.readyState}`);
    ensureDiagnosticsPanel(!hadMeaningfulPlayback);
  };

  const onTimeUpdate = (): void => {
    const next = accumulateVideoProgress(progressLastTime, video.currentTime, progressAccum);
    progressLastTime = next.lastTime;
    progressAccum = next.progressed;
    if (isMeaningfulVideoProgress(video.videoWidth, progressAccum)) {
      markMeaningfulPlayback(
        `timeupdate ct=${video.currentTime.toFixed(2)} w=${video.videoWidth}x${video.videoHeight} progressed=${progressAccum.toFixed(2)}`
      );
      return;
    }
  };

  const onDiagEvent = (name: string): void => {
    if (disposed) return;
    const er = video.error;
    diag(
      `${name} ct=${video.currentTime.toFixed(2)} w=${video.videoWidth}x${video.videoHeight} rs=${video.readyState} ns=${video.networkState} progressed=${progressAccum.toFixed(2)} err=${er?.code ?? "null"}`
    );
    if (name === "waiting" || name === "stalled") {
      if (waitingSince == null) waitingSince = performance.now();
      // After healthy playback, brief buffering is normal — log only.
      // Never clear hadMeaningfulPlayback / remux mid-play (that restarts from 0).
      if (hadMeaningfulPlayback || fallbackStage !== "none") {
        return;
      }
      ensureDiagnosticsPanel(true);
      const waited = waitingSince != null ? performance.now() - waitingSince : 0;
      if (waited > 2500 && !fallingBack) {
        forceStallFallback(`${name} for ${(waited / 1000).toFixed(1)}s`);
      }
    } else if (name === "canplay" || name === "canplaythrough" || name === "playing") {
      waitingSince = null;
    } else if (name === "emptied" || name === "suspend") {
      if (!hadMeaningfulPlayback) ensureDiagnosticsPanel(true);
    }
  };

  const revokeOwnedWasm = (): void => {
    if (ownedWasmBlobUrl) {
      URL.revokeObjectURL(ownedWasmBlobUrl);
      ownedWasmBlobUrl = null;
    }
  };

  const applyVideoSource = (
    url: string,
    mime: string,
    delivery: "blob" | "stream",
    token?: string
  ): void => {
    if (media.delivery === "blob" && media.url.startsWith("blob:") && media.url !== ownedWasmBlobUrl) {
      URL.revokeObjectURL(media.url);
    } else if (media.streamToken) {
      void ComicService.ReleasePageStream(media.streamToken).catch(() => {});
    }
    revokeOwnedWasm();
    if (delivery === "blob" && url.startsWith("blob:")) {
      ownedWasmBlobUrl = url;
    }
    media.url = url;
    media.mime = mime;
    media.delivery = delivery;
    media.streamToken = token;
    video.dataset.mediaUrl = media.url;
    // New source — wait for its own playback evidence.
    resetProgressTracking();
    userPaused = false;
    reachedEnded = false;
    revivingFromEnded = false;
    lastMediaGestureAt = null;
    wasPausedBeforeGesture = false;
    clearResumeTimer();
    diag(`applySource delivery=${delivery} mime=${mime} url=${url.slice(0, 96)}`);
    video.src = media.url;
    video.load();
    if (video.parentElement !== host) {
      host.replaceChildren(video);
      mountDiagnosticsPanel();
    }
    void video.play().catch((e) => diag(`play() reject: ${e}`));
    ensureDiagnosticsPanel(true);
    armStallWatchdog();
  };

  const tryWasmVideoFallback = async (priorErr: unknown): Promise<void> => {
    fallbackAbort?.abort();
    fallbackAbort = new AbortController();
    showVideoLoading("Decoding video in-app (this can take a while for large files)…");
    try {
      const result = await transcodeWithWasm(media.url, media.mime, "video", fallbackAbort.signal);
      if (disposed) return;
      applyVideoSource(URL.createObjectURL(result.blob), result.mime, "blob");
    } catch (wasmErr) {
      if (disposed) return;
      if (wasmErr instanceof DOMException && wasmErr.name === "AbortError") return;
      showVideoError(combinedFallbackMessage(priorErr, wasmErr, "video"));
    }
  };

  const showVideoLoading = (message: string): void => {
    if (disposed) return;
    const card = makeLoadingMediaCard(message, media.url);
    card.className = `${className} ${card.className}`;
    // Preserve live diagnostics so stall vs "converting" is visible.
    host.replaceChildren(card);
    if (diagPanel) {
      diagPanel.remove();
      host.append(diagPanel);
      host.classList.add("reader__media-host--diagnostics");
      const body = diagPanel.querySelector(".reader__media-diagnostics-body");
      if (body) body.textContent = formatMediaDiagnostics(diagLines);
      const d = diagPanel.querySelector("details");
      if (d) d.open = true;
    }
    onSized({ width: 16, height: 9 });
  };

  const seekWhenReady = (startAt: number): void => {
    if (!(startAt > 0) || !Number.isFinite(startAt)) return;
    let attempts = 0;
    const doSeek = (): void => {
      attempts += 1;
      try {
        const dur = video.duration;
        const target =
          Number.isFinite(dur) && startAt >= dur ? Math.max(0, dur - 0.05) : startAt;
        video.currentTime = target;
        diag(`seekWhenReady → ${target.toFixed(2)} (attempt ${attempts})`);
        // Some WebKit builds ignore the first seek; retry once after a tick.
        if (attempts < 3) {
          window.setTimeout(() => {
            if (disposed) return;
            if (Math.abs(video.currentTime - target) > 0.5) {
              try {
                video.currentTime = target;
              } catch {
                /* ignore */
              }
            }
          }, 50 * attempts);
        }
      } catch {
        /* ignore seek failures */
      }
      void video.play().catch(() => {});
    };
    if (video.readyState >= 1) {
      doSeek();
      return;
    }
    video.addEventListener("loadedmetadata", doSeek, { once: true });
  };

  const applyHostStream = (
    stream: { url?: string | null; token?: string | null; mime?: string | null },
    startAt: number,
    fallbackMime: string
  ): boolean => {
    if (!stream?.url || !stream.token) return false;
    console.info("[komika] host stream ready", stream);
    // Register seek listener before applyVideoSource triggers load().
    if (startAt > 0) {
      seekWhenReady(startAt);
    }
    applyVideoSource(stream.url, stream.mime || fallbackMime, "stream", stream.token);
    return true;
  };

  /**
   * Fallback ladder:
   *  1) lossless clean MP4 remux (drop tmcd/data) — fast
   *  2) WebM re-encode via host ffmpeg
   *  3) optional wasm for tiny clips
   * resumeAt seeks into the new stream after metadata.
   */
  const tryTranscodeFallback = (opts?: { stage?: "remux" | "reencode"; resumeAt?: number }): void => {
    if (disposed || fallingBack) return;
    const resumeAt = opts?.resumeAt && opts.resumeAt > 0 ? opts.resumeAt : 0;
    const want: "remux" | "reencode" = opts?.stage ?? "remux";
    // Don't go backwards on the ladder.
    if (want === "remux" && fallbackStage !== "none") return;
    if (want === "reencode" && (fallbackStage === "reencode" || fallbackStage === "done")) return;

    fallingBack = true;
    clearMetaTimer();
    clearStallTimer();
    const knownSize = typeof media.sizeBytes === "number" && media.sizeBytes > 0 ? media.sizeBytes : Infinity;
    const allowWasm =
      media.delivery !== "stream" &&
      pageIndex >= 0 &&
      knownSize <= WASM_TRANSCODE_MAX_BYTES;

    const finish = (): void => {
      fallingBack = false;
    };
    if (pageIndex < 0) {
      fallbackStage = "done";
      showVideoError("Missing page index for transcoder fallback.");
      finish();
      return;
    }

    const runReencode = async (priorErr: unknown): Promise<void> => {
      fallbackStage = "reencode";
      showVideoLoading("Re-encoding with system ffmpeg (large 1080p clips can take a while)…");
      try {
        const stream = await ComicService.GetTranscodedStream(pageIndex);
        if (disposed) {
          if (stream?.token) void ComicService.ReleasePageStream(stream.token).catch(() => {});
          return;
        }
        if (!applyHostStream(stream ?? {}, resumeAt, "video/webm")) {
          fallbackStage = "done";
          if (allowWasm) await tryWasmVideoFallback(priorErr ?? new Error("empty transcoder response"));
          else showVideoError("Transcoder returned an empty stream. Is ffmpeg installed?");
        }
      } catch (err) {
        if (disposed) return;
        console.warn("[komika] host reencode failed", err);
        fallbackStage = "done";
        if (allowWasm) await tryWasmVideoFallback(err);
        else showVideoError(mediaPlaybackFallbackMessage(err, "video"));
      }
    };

    const run = async (): Promise<void> => {
      if (want === "remux") {
        fallbackStage = "remux";
        showVideoLoading("Cleaning container with system ffmpeg…");
        try {
          const stream = await ComicService.GetRemuxedStream(pageIndex);
          if (disposed) {
            if (stream?.token) void ComicService.ReleasePageStream(stream.token).catch(() => {});
            return;
          }
          if (applyHostStream(stream ?? {}, resumeAt, "video/mp4")) {
            return;
          }
          await runReencode(new Error("empty remux response"));
          return;
        } catch (err) {
          console.warn("[komika] host remux failed, trying reencode", err);
          await runReencode(err);
          return;
        }
      }
      await runReencode(null);
    };

    void run().finally(finish);
  };

  const onError = (): void => {
    if (disposed || fallingBack) return;
    const mediaErr = video.error;
    const code = mediaErr?.code ?? 0;
    // 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
    const detail = {
      code,
      message: mediaErr?.message ?? "",
      networkState: video.networkState,
      readyState: video.readyState,
      currentTime: video.currentTime,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      hadMeaningfulPlayback,
      fallbackStage,
      mime: media.mime,
      delivery: media.delivery,
      src: media.url.slice(0, 120),
    };
    diag(
      `video.error code=${code} msg=${detail.message || "-"} ns=${detail.networkState} rs=${detail.readyState} ct=${detail.currentTime.toFixed(2)} w=${detail.videoWidth}x${detail.videoHeight} stage=${fallbackStage} delivery=${media.delivery}`
    );
    ensureDiagnosticsPanel(true);
    console.warn("[komika] video error", detail);

    if (hadMeaningfulPlayback && code === 2 /* MEDIA_ERR_NETWORK */) {
      showVideoError("Playback interrupted (network/stream error). Try reopening the page.");
      return;
    }

    const resumeAt = video.currentTime > 0 ? video.currentTime : 0;

    // Mid-play or early DECODE/unsupported: climb the fallback ladder.
    if (code === 3 || code === 4 || code === 0) {
      if (fallbackStage === "none") {
        tryTranscodeFallback({ stage: "remux", resumeAt });
        return;
      }
      if (fallbackStage === "remux") {
        tryTranscodeFallback({ stage: "reencode", resumeAt });
        return;
      }
      fallbackStage = "done";
      showVideoError(
        code === 4
          ? "This media format is not supported after fallback."
          : "Decoder failed after fallback. Try another file or install system codecs."
      );
      return;
    }

    if (fallbackStage === "none") {
      tryTranscodeFallback({ stage: "remux", resumeAt: 0 });
      return;
    }
    showVideoError("This media is unavailable.");
  };

  const unmuteOnGesture = (): void => {
    video.muted = false;
  };

  const bindVideoListeners = (): void => {
    const vOpts: AddEventListenerOptions = { signal: videoListenAbort.signal };
    video.addEventListener("loadedmetadata", onMeta, vOpts);
    video.addEventListener("playing", onPlaying, vOpts);
    video.addEventListener("timeupdate", onTimeUpdate, vOpts);
    video.addEventListener("error", onError, vOpts);
    video.addEventListener("waiting", () => onDiagEvent("waiting"), vOpts);
    video.addEventListener("stalled", () => onDiagEvent("stalled"), vOpts);
    video.addEventListener("suspend", () => onDiagEvent("suspend"), vOpts);
    video.addEventListener("emptied", () => onDiagEvent("emptied"), vOpts);
    video.addEventListener("canplay", () => onDiagEvent("canplay"), vOpts);
    video.addEventListener("canplaythrough", () => onDiagEvent("canplaythrough"), vOpts);
    video.addEventListener("pointerdown", unmuteOnGesture, { once: true, signal: videoListenAbort.signal });
    video.addEventListener(
      "pointerdown",
      () => {
        noteMediaGesture();
      },
      vOpts
    );
    video.addEventListener(
      "keydown",
      (e) => {
        const k = e.key;
        if (k === " " || k === "Spacebar" || k === "k" || k === "K" || e.code === "Space" || e.code === "KeyK") {
          noteMediaGesture();
        }
      },
      vOpts
    );
    video.addEventListener(
      "ended",
      () => {
        reachedEnded = true;
        diag(
          `ended ct=${video.currentTime.toFixed(2)} dur=${Number.isFinite(video.duration) ? video.duration.toFixed(2) : "?"} softLoop=${softLoop}`
        );
        if (
          shouldSoftLoopAfterEnded({
            softLoop,
            ended: true,
            disposed,
            fallingBack,
            reviving: revivingFromEnded,
          })
        ) {
          // Soft repeat: new element from t=0 (not native loop).
          userPaused = false;
          reviveVideoFromStart("soft-loop-ended");
          return;
        }
        userPaused = true; // stopped at end; wait for explicit play
      },
      vOpts
    );
    video.addEventListener(
      "pause",
      () => {
        if (disposed || fallingBack || revivingFromEnded) return;
        if (video.ended || reachedEnded) {
          reachedEnded = true;
          diag("pause at ended — no auto-resume");
          return;
        }
        const now = performance.now();
        if (isUserIntentionalPause(lastMediaGestureAt, now)) {
          userPaused = true;
          clearResumeTimer();
          diag("user paused (gesture-linked)");
          return;
        }
        diag(`pause event unintentional ct=${video.currentTime.toFixed(2)} — auto-resume`);
        userPaused = false;
        scheduleAutoResume("pause-event");
      },
      vOpts
    );
    video.addEventListener(
      "play",
      () => {
        if (disposed || fallingBack || revivingFromEnded) return;
        if (reachedEnded || video.ended) {
          reviveVideoFromStart("play-event-after-ended");
          return;
        }
        if (!video.paused) {
          userPaused = false;
          if (video.currentTime > 0.05) reachedEnded = false;
        }
      },
      vOpts
    );
    video.addEventListener(
      "click",
      () => {
        window.setTimeout(() => {
          if (disposed || fallingBack || revivingFromEnded) return;
          if (reachedEnded || video.ended) {
            reviveVideoFromStart("click-after-ended");
            return;
          }
          if (
            !shouldClickToPlayVideo({
              disposed,
              fallingBack,
              ended: video.ended,
              wasPausedBeforeGesture,
              isPausedNow: video.paused,
            })
          ) {
            if (!video.paused) userPaused = false;
            return;
          }
          userPaused = false;
          diag("click-to-play (was paused before gesture)");
          void video.play().catch((e) => diag(`click-to-play reject: ${e}`));
        }, 0);
      },
      vOpts
    );
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") {
          scheduleAutoResume("visibility");
        }
      },
      vOpts
    );
  };

  bindVideoListeners();


  // Bare video/mp4 often returns "maybe" without H.264; that path can stall WebKitGTK.
  const supported = hostLikelySupportsAV("video", media.mime);
  diag(
    `init mime=${media.mime} delivery=${media.delivery} size=${media.sizeBytes ?? "?"} hostLikelySupportsAV=${supported} url=${media.url.slice(0, 96)}`
  );
  if (!supported) {
    diag("host probe unsupported → remux fallback");
    tryTranscodeFallback({ stage: "remux", resumeAt: 0 });
  } else {
    video.src = media.url;
    void video.play().catch((e) => diag(`play() reject: ${e}`));
    ensureDiagnosticsPanel(true);
    armStallWatchdog();
    // No metadata at all (harder stall than black-controls).
    metaTimer = window.setTimeout(() => {
      if (disposed || fallbackStage !== "none" || hadMeaningfulPlayback) return;
      if (video.readyState >= 1) return;
      diag("metadata timeout 2500ms → remux fallback");
      forceStallFallback("no metadata");
    }, 2500);
  }

  host.append(video);
  // Immediate placeholder so the user always sees the accordion under black controls.
  ensureDiagnosticsPanel(true);
  return {
    get el() {
      return video;
    },
    cleanup: () => {
      disposed = true;
      revivingFromEnded = false;
      removeDiagnosticsPanel();
      clearMetaTimer();
      clearStallTimer();
      clearResumeTimer();
      fallbackAbort?.abort();
      videoListenAbort.abort();
      releaseHtmlMediaElement(video);
      if (ownedWasmBlobUrl && media.url !== ownedWasmBlobUrl) {
        URL.revokeObjectURL(ownedWasmBlobUrl);
      }
      ownedWasmBlobUrl = null;
    },
  };
}

function trimCache(
  active: number,
  mode: ViewMode,
  pageCount: number,
  visible: ReadonlySet<number>
): void {
  const keep = cacheIndices(active, pageCount, mode);
  for (const key of [...pageCache.keys()]) {
    const cached = pageCache.get(key);
    if (!cached) continue;
    const shouldKeep = shouldRetainCachedMedia(
      cached.kind,
      cached.delivery,
      key,
      keep,
      visible
    );
    if (!shouldKeep) {
      revokeCached(cached);
      pageCache.delete(key);
    }
  }
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function currentPageLoadActive(): number {
  return state.viewPreferences.mode === "webtoon" ? state.webtoonActiveIndex : state.pageIndex;
}

function sortPageLoadQueue(): void {
  const active = currentPageLoadActive();
  const visible = new Set(
    pageLoadQueue.filter((job) => job.priority === "visible").map((job) => job.index)
  );
  const order = orderPageLoadIndices(
    pageLoadQueue.map((job) => job.index),
    active,
    visible
  );
  const ranks = new Map(order.map((index, rank) => [index, rank]));
  pageLoadQueue.sort((a, b) => ranks.get(a.index)! - ranks.get(b.index)!);
}

function enqueuePageLoads(
  indices: number[],
  generation: number,
  visible: ReadonlySet<number>
): void {
  for (const index of indices) {
    if (pageCache.has(index)) continue;

    const queued = pageLoadQueue.find((job) => job.index === index);
    if (queued) {
      if (visible.has(index) && queued.priority === "background") {
        queued.priority = "visible";
      }
      continue;
    }
    if (pageLoads.has(index)) continue;

    const deferred = makeDeferred<CachedMedia | undefined>();
    // Background failures are intentionally non-blocking.
    void deferred.promise.catch(() => undefined);
    pageLoads.set(index, deferred.promise);
    pageLoadDeferreds.set(index, deferred);
    pageLoadErrors.delete(index);
    pageLoadQueue.push({
      index,
      generation,
      priority: visible.has(index) ? "visible" : "background",
    });
  }
  sortPageLoadQueue();
  pumpPageLoads();
}

function pumpPageLoads(): void {
  while (pageLoadRunning.size < MAX_CONCURRENT_PAGE_LOADS && pageLoadQueue.length > 0) {
    const nextJob = nextPageLoadQueueIndex(
      pageLoadQueue,
      pageLoadRunning.size,
      MAX_CONCURRENT_PAGE_LOADS
    );
    if (nextJob === -1) break;
    const job = pageLoadQueue.splice(nextJob, 1)[0]!;
    const deferred = pageLoadDeferreds.get(job.index);
    if (!deferred || pageLoads.get(job.index) !== deferred.promise) continue;
    if (pageCache.has(job.index)) {
      deferred.resolve(pageCache.get(job.index));
      pageLoadDeferreds.delete(job.index);
      pageLoads.delete(job.index);
      continue;
    }

    pageLoadRunning.add(job.index);
    const load = loadOnePage(job.index);
    void load
      .then(
        (media) => {
          deferred.resolve(media);
        },
        (error) => {
          if (pageLoads.get(job.index) === deferred.promise) {
            pageLoadErrors.set(job.index, error);
          }
          deferred.reject(error);
        }
      )
      .finally(() => {
        pageLoadRunning.delete(job.index);
        if (pageLoads.get(job.index) === deferred.promise) pageLoads.delete(job.index);
        if (pageLoadDeferreds.get(job.index) === deferred) pageLoadDeferreds.delete(job.index);
        pumpPageLoads();
      });
  }
}

function stillWanted(index: number, comic: Comic): boolean {
  if (state.comic !== comic) return false;
  const mode = state.viewPreferences.mode;
  const active = currentPageLoadActive();
  const pages = comic.pages ?? [];
  const desc = pages[index];
  const kind = mediaKindForMime(desc?.mime ?? "");
  if (!kind) return false;
  let retainVisible: ReadonlySet<number>;
  if (mode === "webtoon") {
    retainVisible = new Set([state.webtoonActiveIndex]);
  } else if (isDoubleMode(mode)) {
    retainVisible = new Set(spreadForPage(state.pageIndex, comic.pageCount, mode));
  } else {
    retainVisible = new Set([state.pageIndex]);
  }
  return shouldRetainCachedMedia(
    kind,
    desc?.delivery,
    index,
    cacheIndices(active, comic.pageCount, mode),
    retainVisible
  );
}

async function loadOnePage(index: number): Promise<CachedMedia | undefined> {
  const comic = state.comic;
  if (!comic) return undefined;
  const desc = comic.pages?.[index];
  const kind = mediaKindForMime(desc?.mime ?? "");
  if (!kind) throw new Error(`unsupported media mime: ${desc?.mime ?? ""}`);

  const documentPage = desc?.documentPage && desc.documentPage > 0 ? desc.documentPage : undefined;
  const documentKey = desc?.documentKey || undefined;

  if (kind === "pdf" && documentKey) {
    let docState = pdfDocs.get(documentKey);
    if (!docState) {
      docState = { waiters: 0, pageRefs: 0 };
      pdfDocs.set(documentKey, docState);
    }
    docState.waiters += 1;

    try {
      if (!docState.owner && !docState.fetch) {
        const fetchIndex = index;
        const fetchDesc = desc;
        const fetchKind = kind;
        const fetchPromise = (async (): Promise<CachedMedia> => {
          const delivery = fetchDesc?.delivery === "stream" ? "stream" : "rpc";
          if (delivery === "stream") {
            const stream = await ComicService.GetPageStream(fetchIndex);
            if (!stream?.url || !stream.token) throw new Error("empty page stream");
            return {
              mime: fetchDesc?.mime ?? "",
              kind: fetchKind,
              url: stream.url,
              delivery: "stream",
              sizeBytes: typeof fetchDesc?.sizeBytes === "number" ? fetchDesc.sizeBytes : undefined,
              streamToken: stream.token,
              documentKey,
            };
          }
          const payload = await ComicService.GetPage(fetchIndex);
          if (!payload) throw new Error("empty page payload");
          const payloadKind = mediaKindForMime(payload.mime);
          if (!payloadKind) throw new Error(`unsupported media mime: ${payload.mime}`);
          const bytes = decodePayloadData(payload.data);
          return {
            mime: payload.mime,
            kind: payloadKind,
            url: URL.createObjectURL(new Blob([bytes], { type: payload.mime })),
            delivery: "blob",
            sizeBytes: bytes.byteLength,
            documentKey,
          };
        })();
        docState.fetch = fetchPromise;
        void fetchPromise.then(
          (owner) => {
            const current = pdfDocs.get(documentKey);
            if (!current || current.fetch !== fetchPromise) {
              // clearPageCache / superseded fetch: drop orphaned blob or stream token.
              releasePdfDocResources(owner);
              return;
            }
            current.owner = owner;
            current.fetch = undefined;
          },
          () => {
            const current = pdfDocs.get(documentKey);
            if (!current || current.fetch !== fetchPromise) return;
            current.fetch = undefined;
            maybeDisposePdfDoc(documentKey);
          }
        );
      }

      const owner = docState.owner ?? (docState.fetch ? await docState.fetch : undefined);
      // clearPageCache may have wiped state mid-await; do not resurrect released resources.
      const currentState = pdfDocs.get(documentKey);
      if (!currentState) return undefined;
      docState = currentState;
      const resolvedOwner = docState.owner ?? owner;
      if (!resolvedOwner) throw new Error("pdf document load failed");

      if (!stillWanted(index, comic)) {
        return undefined;
      }

      const media: CachedMedia = {
        mime: resolvedOwner.mime,
        kind: "pdf",
        url: resolvedOwner.url,
        delivery: resolvedOwner.delivery,
        documentPage,
        documentKey,
      };
      const previous = pageCache.get(index);
      if (previous) {
        if (previous.url !== media.url) revokeCached(previous);
        else if (previous.kind === "pdf" && previous.documentKey === documentKey) {
          // Replacing same-doc entry: drop the old pageRef before re-retain.
          docState.pageRefs = Math.max(0, docState.pageRefs - 1);
        }
      }
      pageCache.set(index, media);
      docState.pageRefs += 1;
      pageLoadErrors.delete(index);
      return media;
    } finally {
      const current = pdfDocs.get(documentKey);
      if (current) {
        current.waiters = Math.max(0, current.waiters - 1);
        maybeDisposePdfDoc(documentKey);
      }
    }
  }

  // Video/audio always use Range-capable /media streams (WebKitGTK blob: H.264 bug).
  const forceStream = kind === "video" || kind === "audio";
  const delivery = forceStream || desc?.delivery === "stream" ? "stream" : "rpc";
  let media: CachedMedia;

  if (delivery === "stream") {
    const stream = await ComicService.GetPageStream(index);
    if (!stream?.url || !stream.token) throw new Error("empty page stream");
    media = {
      mime: desc?.mime ?? "",
      kind,
      url: stream.url,
      delivery: "stream",
      sizeBytes: typeof desc?.sizeBytes === "number" ? desc.sizeBytes : undefined,
      streamToken: stream.token,
      documentPage,
      documentKey,
    };
  } else {
    const payload = await ComicService.GetPage(index);
    if (!payload) throw new Error("empty page payload");
    const payloadKind = mediaKindForMime(payload.mime);
    if (!payloadKind) throw new Error(`unsupported media mime: ${payload.mime}`);
    const bytes = decodePayloadData(payload.data);
    media = {
      mime: payload.mime,
      kind: payloadKind,
      url: URL.createObjectURL(new Blob([bytes], { type: payload.mime })),
      delivery: "blob",
      sizeBytes: bytes.byteLength,
      documentPage,
      documentKey,
    };
  }

  if (!stillWanted(index, comic)) {
    revokeCached(media);
    return undefined;
  }
  const previous = pageCache.get(index);
  if (previous && previous.url !== media.url) revokeCached(previous);
  pageCache.set(index, media);
  pageLoadErrors.delete(index);
  return media;
}

async function loadPages(
  indices: number[],
  generation: number,
  visible: ReadonlySet<number>
): Promise<void> {
  if (!state.comic) return;
  const comic = state.comic;
  const pages = comic.pages ?? [];
  const unique = [...new Set(indices)].filter((i) => i >= 0 && i < comic.pageCount);
  const toLoad = unique.filter((index) => {
    const desc = pages[index];
    const kind = mediaKindForMime(desc?.mime ?? "");
    return shouldLoadMediaDelivery(desc?.delivery, kind, index, visible);
  });

  enqueuePageLoads(toLoad, generation, visible);
  const visiblePending = toLoad.filter((index) => visible.has(index) && !pageCache.has(index));
  await Promise.all(visiblePending.map((index) => pageLoads.get(index)?.catch(() => undefined)));

  if (generation !== renderGeneration) return;
  const visibleError = visiblePending
    .filter((index) => !pageCache.has(index))
    .map((index) => pageLoadErrors.get(index))
    .find((error) => error !== undefined);
  if (visibleError !== undefined) throw visibleError;

  const mode = state.viewPreferences.mode;
  const active = currentPageLoadActive();
  let retainVisible: ReadonlySet<number>;
  if (mode === "webtoon") {
    retainVisible = new Set([state.webtoonActiveIndex]);
  } else if (isDoubleMode(mode)) {
    retainVisible = new Set(spreadForPage(state.pageIndex, comic.pageCount, mode));
  } else {
    retainVisible = new Set([state.pageIndex]);
  }
  trimCache(active, mode, comic.pageCount, retainVisible);
}

function runReaderCleanup(): void {
  if (readerCleanup) {
    readerCleanup();
    readerCleanup = null;
  }
}

function render(): void {
  runReaderCleanup();
  appRoot.replaceChildren();
  if (state.comic) {
    appRoot.append(renderReader());
  } else {
    appRoot.append(renderLibrary());
  }
}

function formatLastOpened(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return iso;
  }
}

function renderLibrary(): HTMLElement {
  const view = document.createElement("div");
  view.className = "view library";

  const header = document.createElement("header");
  header.className = "library__header";

  const titleBlock = document.createElement("div");
  titleBlock.className = "library__title-block";
  const eyebrow = document.createElement("div");
  eyebrow.className = "mp-eyebrow";
  eyebrow.textContent = "Local library";
  const title = document.createElement("h1");
  title.className = "library__title";
  title.textContent = "Komika";
  const subtitle = document.createElement("p");
  subtitle.className = "mp-text--secondary";
  subtitle.textContent =
    "Open an archive, media folder, or single image/video/audio. Progress is saved per work.";
  titleBlock.append(eyebrow, title, subtitle);

  const actions = document.createElement("div");
  actions.className = "library__actions mp-button-row";
  actions.append(
    makeButton("Open archive", "mp-button--primary", () => void handleOpenArchive()),
    makeButton("Open folder", "mp-button--secondary", () => void handleOpenFolder()),
    makeButton("Open media", "mp-button--secondary", () => void handleOpenMedia()),
    makeButton(
      state.historySettingsOpen ? "Hide history settings" : "History settings",
      "mp-button--ghost",
      () => {
        state.historySettingsOpen = !state.historySettingsOpen;
        state.pendingHistoryAction = null;
        if (state.historySettingsOpen) {
          void refreshDesktopIntegration().then(() => render());
        }
        render();
      }
    )
  );
  header.append(titleBlock, actions);
  view.append(header);

  if (state.historySettingsOpen) {
    view.append(renderHistorySettings());
    const desktopCard = renderDesktopIntegration();
    if (desktopCard) view.append(desktopCard);
  }

  const settings = librarySettings();
  const recents = state.library?.recents ?? [];

  const historyPanel = document.createElement("section");
  historyPanel.className = "library__history";
  historyPanel.setAttribute("aria-label", "Recent history");

  if (!settings.saveRecents) {
    const notice = document.createElement("div");
    notice.className = "history-notice";
    notice.textContent = "Recent history is not being saved";
    historyPanel.append(notice);
  }

  if (recents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mp-empty-state mp-empty-state--default library__empty";
    empty.setAttribute("role", "status");

    const emptyIcon = document.createElement("span");
    emptyIcon.className = "mp-empty-state__icon";
    emptyIcon.setAttribute("aria-hidden", "true");
    emptyIcon.innerHTML =
      '<svg class="mp-symbol mp-symbol--sm" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M5.5 8.5h13v10h-13z"/><path d="M7.5 8.5V5.8h9v2.7"/><path d="M9.5 12.5h5"/>' +
      "</svg>";

    const emptyTitle = document.createElement("h4");
    emptyTitle.className = "mp-empty-state__title";
    emptyTitle.textContent = "No recent history";

    const emptyBody = document.createElement("p");
    emptyBody.className = "mp-empty-state__body";
    emptyBody.textContent = settings.saveRecents
      ? "Open an archive, folder, or media file to begin reading. Recent history and resume positions appear here."
      : "Saving is disabled. Open an archive, folder, or media file to read without adding to history.";

    const emptyMeta = document.createElement("div");
    emptyMeta.className = "mp-empty-state__meta";
    emptyMeta.textContent = settings.saveRecents ? "history:ready" : "history:disabled";

    const emptyActions = document.createElement("div");
    emptyActions.className = "mp-empty-state__actions";
    emptyActions.append(
      makeButton("Open archive", "mp-button--primary mp-button--sm", () => void handleOpenArchive()),
      makeButton("Open folder", "mp-button--secondary mp-button--sm", () => void handleOpenFolder()),
      makeButton("Open media", "mp-button--secondary mp-button--sm", () => void handleOpenMedia())
    );

    empty.append(emptyIcon, emptyTitle, emptyBody, emptyMeta, emptyActions);
    historyPanel.append(empty);
    view.append(historyPanel);
    return view;
  }

  const section = document.createElement("div");
  section.className = "recent-section";
  const headingRow = document.createElement("div");
  headingRow.className = "recent-section__header";
  const heading = document.createElement("h2");
  heading.className = "mp-section-heading";
  heading.textContent = "Recent history";
  headingRow.append(heading);

  if (settings.saveRecents) {
    const bulk = document.createElement("div");
    bulk.className = "recent-section__bulk mp-button-row";
    bulk.append(
      makeButton(
        "Remove selected",
        "mp-button--secondary mp-button--sm",
        () => {
          if (state.selectedRecentPaths.size === 0) {
            showToast("Select at least one work", "info");
            return;
          }
          state.pendingHistoryAction = "removeSelected";
          render();
        },
        { disabled: state.selectedRecentPaths.size === 0 }
      ),
      makeButton("Clear all", "mp-button--ghost mp-button--sm", () => {
        state.pendingHistoryAction = "clearAll";
        render();
      })
    );
    headingRow.append(bulk);
  }
  section.append(headingRow);

  if (state.pendingHistoryAction === "removeSelected" || state.pendingHistoryAction === "clearAll") {
    section.append(renderHistoryConfirm(state.pendingHistoryAction));
  }

  section.append(renderRecentTable(recents, settings.saveRecents));
  historyPanel.append(section);
  view.append(historyPanel);
  return view;
}

function renderHistorySettings(): HTMLElement {
  const card = document.createElement("article");
  card.className = "mp-card history-settings";
  const settings = librarySettings();

  const header = document.createElement("div");
  header.className = "mp-card__header";
  const title = document.createElement("div");
  title.className = "mp-card__title";
  title.textContent = "History settings";
  header.append(title);
  card.append(header);

  const body = document.createElement("div");
  body.className = "history-settings__body";

  const saveRow = document.createElement("label");
  saveRow.className = "history-settings__row";
  const saveCheck = document.createElement("input");
  saveCheck.type = "checkbox";
  saveCheck.className = "mp-checkbox";
  saveCheck.checked = settings.saveRecents;
  saveCheck.addEventListener("change", () => {
    if (!saveCheck.checked) {
      saveCheck.checked = true;
      state.pendingHistoryAction = "disableSaving";
      render();
      return;
    }
    void handleUpdateSettings({ saveRecents: true, retentionDays: settings.retentionDays });
  });
  const saveText = document.createElement("span");
  saveText.textContent = "Save recent history and progress";
  saveRow.append(saveCheck, saveText);
  body.append(saveRow);

  if (state.pendingHistoryAction === "disableSaving") {
    body.append(renderHistoryConfirm("disableSaving"));
  }

  const ttlRow = document.createElement("label");
  ttlRow.className = "history-settings__row history-settings__ttl";
  const ttlLabel = document.createElement("span");
  ttlLabel.textContent = "Retention";
  const ttlSelect = document.createElement("select");
  ttlSelect.className = "mp-select";
  ttlSelect.disabled = !settings.saveRecents;
  for (const opt of [
    { value: 0, label: "Keep forever" },
    { value: 7, label: "7 days" },
    { value: 30, label: "30 days" },
    { value: 90, label: "90 days" },
  ]) {
    const o = document.createElement("option");
    o.value = String(opt.value);
    o.textContent = opt.label;
    if (opt.value === settings.retentionDays) o.selected = true;
    ttlSelect.append(o);
  }
  ttlSelect.addEventListener("change", () => {
    const days = Number.parseInt(ttlSelect.value, 10);
    void handleUpdateSettings({ saveRecents: settings.saveRecents, retentionDays: days });
  });
  ttlRow.append(ttlLabel, ttlSelect);
  body.append(ttlRow);

  card.append(body);
  return card;
}

function renderDesktopIntegration(): HTMLElement | null {
  const status = state.desktopIntegration;
  if (!status?.supported) return null;

  const card = document.createElement("article");
  card.className = "mp-card history-settings desktop-integration";

  const header = document.createElement("div");
  header.className = "mp-card__header";
  const title = document.createElement("div");
  title.className = "mp-card__title";
  title.textContent = "File manager integration";
  header.append(title);
  card.append(header);

  const body = document.createElement("div");
  body.className = "history-settings__body";

  const desc = document.createElement("p");
  desc.className = "desktop-integration__text";
  if (status.installed) {
    desc.textContent =
      "Komika is registered as an Open With candidate for comic archives, ZIP/RAR/7z, PDF, Markdown, and common media.";
  } else {
    desc.textContent =
      "Register Komika in the file manager for comic archives, ZIP/RAR/7z, PDF, Markdown, and common media (AppImage/binary). Adds Open With candidates; does not force default apps.";
  }
  body.append(desc);

  if (status.installed && status.execPath) {
    const exec = document.createElement("p");
    exec.className = "desktop-integration__meta";
    exec.textContent = `Executable: ${status.execPath}`;
    body.append(exec);
  }

  if (status.detail) {
    const detail = document.createElement("p");
    detail.className = "desktop-integration__detail";
    detail.textContent = status.detail;
    body.append(detail);
  }

  const row = document.createElement("div");
  row.className = "mp-button-row";
  if (status.installed) {
    row.append(
      makeButton("Re-register", "mp-button--secondary mp-button--sm", () => {
        void handleInstallDesktopIntegration();
      }),
      makeButton("Remove", "mp-button--ghost mp-button--sm", () => {
        void handleRemoveDesktopIntegration();
      })
    );
  } else {
    row.append(
      makeButton("Register", "mp-button--primary mp-button--sm", () => {
        void handleInstallDesktopIntegration();
      })
    );
  }
  body.append(row);
  card.append(body);
  return card;
}

async function refreshDesktopIntegration(): Promise<void> {
  try {
    state.desktopIntegration = await ComicService.GetDesktopIntegration();
  } catch {
    state.desktopIntegration = null;
  }
}

async function handleInstallDesktopIntegration(): Promise<void> {
  try {
    state.desktopIntegration = await ComicService.InstallDesktopIntegration();
    showToast(
      state.desktopIntegration.installed ? "File manager integration registered" : "Registration incomplete",
      state.desktopIntegration.installed ? "success" : "info"
    );
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    render();
  }
}

async function handleRemoveDesktopIntegration(): Promise<void> {
  try {
    state.desktopIntegration = await ComicService.RemoveDesktopIntegration();
    showToast("File manager integration removed", "success");
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    render();
  }
}


function renderHistoryConfirm(action: HistoryAction): HTMLElement {
  const box = document.createElement("div");
  box.className = "history-confirm";
  const text = document.createElement("p");
  text.className = "history-confirm__text";
  if (action === "disableSaving") {
    text.textContent = "Saving will stop and all recent history and progress will be deleted.";
  } else if (action === "removeSelected") {
    text.textContent = `Remove ${state.selectedRecentPaths.size} selected work(s)?`;
  } else {
    text.textContent = "Clear all recent history and progress?";
  }
  const row = document.createElement("div");
  row.className = "mp-button-row";
  row.append(
    makeButton("Cancel", "mp-button--secondary mp-button--sm", () => {
      state.pendingHistoryAction = null;
      render();
    }),
    makeButton(
      action === "disableSaving" ? "Disable and clear" : "Confirm",
      "mp-button--primary mp-button--sm",
      () => void confirmHistoryAction(action)
    )
  );
  box.append(text, row);
  return box;
}

async function confirmHistoryAction(action: HistoryAction): Promise<void> {
  const settings = librarySettings();
  try {
    if (action === "disableSaving") {
      const st = await ComicService.UpdateLibrarySettings({
        saveRecents: false,
        retentionDays: settings.retentionDays,
      });
      applyLibrarySnapshot(st);
      state.selectedRecentPaths.clear();
      showToast("Recent saving disabled", "success");
    } else if (action === "removeSelected") {
      const paths = [...state.selectedRecentPaths];
      const st = await ComicService.RemoveRecents(paths);
      applyLibrarySnapshot(st);
      showToast(`Removed ${paths.length} work(s)`, "success");
    } else {
      const st = await ComicService.ClearRecents();
      applyLibrarySnapshot(st);
      state.selectedRecentPaths.clear();
      showToast("All recent history cleared", "success");
    }
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    state.pendingHistoryAction = null;
    render();
  }
}

async function handleUpdateSettings(next: LibrarySettings): Promise<void> {
  const beforeCount = state.library?.recents?.length ?? 0;
  try {
    const st = await ComicService.UpdateLibrarySettings(next);
    applyLibrarySnapshot(st);
    const afterCount = state.library?.recents?.length ?? 0;
    const pruned = Math.max(0, beforeCount - afterCount);
    if (pruned > 0) {
      showToast(`Pruned ${pruned} expired work(s)`, "info");
    } else {
      showToast("History settings updated", "success");
    }
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    render();
  }
}

function renderRecentTable(recents: RecentComic[], saving: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "recent-table-wrap";

  const table = document.createElement("table");
  table.className = "recent-table";
  table.setAttribute("aria-label", "Recent history");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const columns: { key: string; label: string; className?: string }[] = [
    ...(saving ? [{ key: "select", label: "", className: "recent-table__col--select" }] : []),
    { key: "title", label: "Title", className: "recent-table__col--title" },
    { key: "type", label: "Type", className: "recent-table__col--type" },
    { key: "progress", label: "Progress", className: "recent-table__col--progress" },
    { key: "opened", label: "Last opened", className: "recent-table__col--opened" },
    { key: "actions", label: "", className: "recent-table__col--actions" },
  ];
  for (const col of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    if (col.className) th.className = col.className;
    th.textContent = col.label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const recent of recents) {
    tbody.append(renderRecentRow(recent, saving));
  }
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

function renderRecentRow(recent: RecentComic, saving: boolean): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "recent-table__row";
  row.dataset.path = recent.path;

  if (saving) {
    const selectTd = document.createElement("td");
    selectTd.className = "recent-table__col--select";
    const selectLabel = document.createElement("label");
    selectLabel.className = "recent-table__select";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "mp-checkbox";
    cb.checked = state.selectedRecentPaths.has(recent.path);
    cb.setAttribute("aria-label", `Select ${recent.title}`);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedRecentPaths.add(recent.path);
      else state.selectedRecentPaths.delete(recent.path);
      render();
    });
    selectLabel.append(cb);
    selectTd.append(selectLabel);
    row.append(selectTd);
  }

  const titleTd = document.createElement("td");
  titleTd.className = "recent-table__col--title";
  const titleBtn = document.createElement("button");
  titleBtn.type = "button";
  titleBtn.className = "recent-table__title-btn";
  titleBtn.textContent = recent.title;
  titleBtn.title = recent.path;
  titleBtn.addEventListener("click", () => void handleOpenRecent(recent.path));
  titleTd.append(titleBtn);
  row.append(titleTd);

  const typeTd = document.createElement("td");
  typeTd.className = "recent-table__col--type";
  const badge = document.createElement("span");
  badge.className = "mp-badge mp-badge--type mp-badge--sm";
  badge.textContent = sourceTypeBadge(recent.sourceType);
  typeTd.append(badge);
  row.append(typeTd);

  const progressTd = document.createElement("td");
  progressTd.className = "recent-table__col--progress";
  progressTd.textContent = `${recent.currentPage + 1} / ${recent.pageCount}`;
  row.append(progressTd);

  const openedTd = document.createElement("td");
  openedTd.className = "recent-table__col--opened";
  openedTd.textContent = formatLastOpened(recent.lastOpened);
  row.append(openedTd);

  const actionsTd = document.createElement("td");
  actionsTd.className = "recent-table__col--actions";
  const actions = document.createElement("div");
  actions.className = "recent-table__actions mp-button-row";
  actions.append(
    makeButton("Resume", "mp-button--primary mp-button--sm", () => void handleOpenRecent(recent.path))
  );
  if (saving) {
    actions.append(
      makeButton("Remove", "mp-button--ghost mp-button--sm", () => void handleRemoveOne(recent.path))
    );
  }
  actionsTd.append(actions);
  row.append(actionsTd);

  return row;
}

async function handleRemoveOne(path: string): Promise<void> {
  try {
    const st = await ComicService.RemoveRecents([path]);
    applyLibrarySnapshot(st);
    showToast("Removed from recents", "success");
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    render();
  }
}

function pageIndicatorText(comic: Comic): string {
  const mode = state.viewPreferences.mode;
  if (isDoubleMode(mode)) {
    const spread = spreadForPage(state.pageIndex, comic.pageCount, mode);
    if (spread.length === 2) {
      const lo = Math.min(spread[0], spread[1]) + 1;
      const hi = Math.max(spread[0], spread[1]) + 1;
      return `${lo}–${hi} / ${comic.pageCount}`;
    }
    return `${(spread[0] ?? 0) + 1} / ${comic.pageCount}`;
  }
  const active = mode === "webtoon" ? state.webtoonActiveIndex : state.pageIndex;
  return `${active + 1} / ${comic.pageCount}`;
}

function pageInputValue(comic: Comic): string {
  const mode = state.viewPreferences.mode;
  if (isDoubleMode(mode)) {
    return String(normalizePageIndex(state.pageIndex, comic.pageCount, mode) + 1);
  }
  const active = mode === "webtoon" ? state.webtoonActiveIndex : state.pageIndex;
  return String(active + 1);
}

function renderReader(): HTMLElement {
  const comic = state.comic!;
  const mode = state.viewPreferences.mode;
  const view = document.createElement("div");
  view.className = "view reader";
  if (state.toolbarCollapsed) view.classList.add("reader--toolbar-collapsed");

  const toolbar = document.createElement("header");
  toolbar.className = "reader__toolbar";

  const back = makeButton("", "mp-button--ghost mp-button--icon", () => void handleBackToLibrary(), {
    iconOnly: true,
    aria: "Back to library",
  });
  back.append(svgIcon('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'));

  const title = document.createElement("div");
  title.className = "reader__title";
  title.textContent = comic.title;

  const controls = document.createElement("div");
  controls.className = "reader__controls";

  const prev = makeButton("", "mp-button--secondary mp-button--icon", () => void navigate(-1), {
    iconOnly: true,
    aria: "Previous page",
  });
  prev.append(svgIcon('<polyline points="15 18 9 12 15 6"/>'));

  const pageForm = document.createElement("form");
  pageForm.className = "reader__page-form";
  pageForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = pageForm.querySelector("input") as HTMLInputElement;
    const oneBased = Number.parseInt(input.value, 10);
    if (!Number.isFinite(oneBased)) return;
    void goToPage(oneBased - 1);
  });
  const pageInput = document.createElement("input");
  pageInput.className = "mp-input reader__page-input";
  pageInput.type = "number";
  pageInput.min = "1";
  pageInput.max = String(comic.pageCount);
  pageInput.value = pageInputValue(comic);
  pageInput.setAttribute("aria-label", "Page number");
  const pageTotal = document.createElement("span");
  pageTotal.className = "reader__page-indicator";
  pageTotal.textContent = pageIndicatorText(comic);
  if (isDoubleMode(mode)) {
    pageForm.append(pageInput, pageTotal);
  } else {
    const slash = document.createElement("span");
    slash.textContent = `/ ${comic.pageCount}`;
    pageForm.append(pageInput, slash);
  }

  const next = makeButton("", "mp-button--secondary mp-button--icon", () => void navigate(1), {
    iconOnly: true,
    aria: "Next page",
  });
  next.append(svgIcon('<polyline points="9 18 15 12 9 6"/>'));

  const modeSelect = document.createElement("select");
  modeSelect.className = "mp-select reader__mode-select";
  modeSelect.setAttribute("aria-label", "View mode");
  for (const opt of MODE_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === mode) o.selected = true;
    modeSelect.append(o);
  }
  modeSelect.addEventListener("change", () => {
    setViewMode(modeSelect.value as ViewMode);
  });

  const stretchLabel = document.createElement("label");
  stretchLabel.className = "reader__stretch";
  const stretch = document.createElement("input");
  stretch.type = "checkbox";
  stretch.className = "mp-checkbox";
  stretch.checked = state.viewPreferences.stretchSmall;
  stretch.disabled = mode === "original" || mode === "webtoon";
  stretch.addEventListener("change", () => setStretchSmall(stretch.checked));
  const stretchText = document.createElement("span");
  stretchText.textContent = "Stretch small images";
  stretchLabel.append(stretch, stretchText);

  const renderLabel = document.createElement("label");
  renderLabel.className = "reader__stretch";
  const renderText = document.createElement("span");
  renderText.textContent = "Scaling";
  const renderSelect = document.createElement("select");
  renderSelect.className = "mp-select reader__render-select";
  renderSelect.setAttribute("aria-label", "Image scaling");
  for (const opt of [
    { value: "smooth", label: "Smooth" },
    { value: "highQuality", label: "High quality" },
    { value: "noHalo", label: "NoHalo" },
    { value: "xbrz", label: "xBRZ" },
    { value: "pixelated", label: "Pixelated" },
  ] as const) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === state.viewPreferences.imageRendering) o.selected = true;
    renderSelect.append(o);
  }
  renderSelect.addEventListener("change", () => {
    setImageRendering(renderSelect.value as ImageRendering);
  });
  renderLabel.append(renderText, renderSelect);

  const zoomOut = makeButton("", "mp-button--secondary mp-button--icon", () => adjustZoom(-10), {
    iconOnly: true,
    aria: "Zoom out",
  });
  zoomOut.append(svgIcon('<line x1="5" y1="12" x2="19" y2="12"/>'));

  const zoomReset = makeButton(
    `${Math.round(state.manualTransform.zoomPercent)}%`,
    "mp-button--ghost mp-button--sm reader__zoom-label",
    () => {
      resetManualTransform();
      render();
    },
    { aria: "Reset zoom" }
  );

  const zoomIn = makeButton("", "mp-button--secondary mp-button--icon", () => adjustZoom(10), {
    iconOnly: true,
    aria: "Zoom in",
  });
  zoomIn.append(
    svgIcon('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>')
  );

  const dirBtn = makeButton(
    state.readingDirection === "rtl" ? "RTL" : "LTR",
    "mp-button--secondary mp-button--sm",
    () => {
      if (isDoubleMode(mode)) {
        setViewMode(mode === "doubleRTL" ? "doubleLTR" : "doubleRTL");
        return;
      }
      saveDirection(state.readingDirection === "rtl" ? "ltr" : "rtl");
      render();
    },
    { aria: "Toggle reading direction" }
  );

  const progress = document.createElement("div");
  progress.className = "reader__progress";
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-valuemin", "1");
  progress.setAttribute("aria-valuemax", String(comic.pageCount));
  const activeForProgress = mode === "webtoon" ? state.webtoonActiveIndex : state.pageIndex;
  progress.setAttribute("aria-valuenow", String(activeForProgress + 1));
  const bar = document.createElement("div");
  bar.className = "reader__progress-bar";
  bar.style.width = `${comic.pageCount <= 1 ? 100 : ((activeForProgress + 1) / comic.pageCount) * 100}%`;
  progress.append(bar);

  controls.append(
    prev,
    pageForm,
    next,
    modeSelect,
    stretchLabel,
    renderLabel,
    zoomOut,
    zoomReset,
    zoomIn,
    dirBtn,
    progress
  );
  toolbar.append(back, title, controls);
  toolbar.addEventListener("dblclick", (e) => {
    if (isInteractiveToolbarTarget(e.target)) return;
    void WailsWindow.ToggleMaximise();
  });

  const floatToggle = makeButton(
    "",
    "mp-button--secondary mp-button--icon reader__toolbar-float",
    () => setToolbarCollapsed(!state.toolbarCollapsed),
    {
      iconOnly: true,
      aria: state.toolbarCollapsed ? "Expand toolbar" : "Collapse toolbar",
    }
  );
  floatToggle.setAttribute("aria-expanded", String(!state.toolbarCollapsed));
  const collapseIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  collapseIcon.setAttribute("viewBox", "0 0 24 24");
  collapseIcon.setAttribute("aria-hidden", "true");
  collapseIcon.classList.add(
    "mp-symbol",
    "mp-symbol--sm",
    "reader__toolbar-float-icon",
    "reader__toolbar-float-icon--collapse"
  );
  collapseIcon.innerHTML = '<path d="m6.5 14.8 5.5-5.6 5.5 5.6"/>';
  const expandIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  expandIcon.setAttribute("viewBox", "0 0 24 24");
  expandIcon.setAttribute("aria-hidden", "true");
  expandIcon.classList.add(
    "mp-symbol",
    "mp-symbol--sm",
    "reader__toolbar-float-icon",
    "reader__toolbar-float-icon--expand"
  );
  expandIcon.innerHTML = '<path d="m6.5 9.2 5.5 5.6 5.5-5.6"/>';
  floatToggle.append(collapseIcon, expandIcon);

  const stage = document.createElement("div");
  stage.className = "reader__stage";
  if (mode === "webtoon") stage.classList.add("reader__stage--webtoon");

  view.append(toolbar, stage, floatToggle);

  const generation = renderGeneration;
  if (mode === "webtoon") {
    mountWebtoonReader(stage, comic, generation);
  } else if (isDoubleMode(mode)) {
    mountSpreadReader(stage, comic, mode, generation);
  } else {
    mountSingleReader(stage, comic, mode, generation);
  }

  return view;
}

function adjustZoom(delta: number): void {
  const step = Math.abs(delta) === 1 ? delta : delta;
  const max = state.viewPreferences.mode === "webtoon" ? 200 : 800;
  state.manualTransform = {
    ...state.manualTransform,
    zoomPercent: clampZoom(state.manualTransform.zoomPercent + step, max),
  };
  renderGeneration += 1;
  pageLoads.clear();
  render();
}

function contentOverflows(stage: Size, scaled: Size): boolean {
  return scaled.width > stage.width + 0.5 || scaled.height > stage.height + 0.5;
}

function mountSingleReader(
  stage: HTMLElement,
  comic: Comic,
  mode: ViewMode,
  generation: number
): void {
  const content = document.createElement("div");
  content.className = "reader__content reader__content--single";
  const mediaHost = document.createElement("div");
  mediaHost.className = "reader__media-host";
  content.append(mediaHost);
  stage.append(content);

  const leftZone = document.createElement("button");
  leftZone.type = "button";
  leftZone.className = "reader__zone reader__zone--left";
  leftZone.setAttribute(
    "aria-label",
    state.readingDirection === "rtl" ? "Next page" : "Previous page"
  );
  leftZone.addEventListener("click", () =>
    void navigate(state.readingDirection === "rtl" ? 1 : -1)
  );

  const rightZone = document.createElement("button");
  rightZone.type = "button";
  rightZone.className = "reader__zone reader__zone--right";
  rightZone.setAttribute(
    "aria-label",
    state.readingDirection === "rtl" ? "Previous page" : "Next page"
  );
  rightZone.addEventListener("click", () =>
    void navigate(state.readingDirection === "rtl" ? -1 : 1)
  );

  let natural: Size = { width: 0, height: 0 };
  let panning = false;
  let panPointerId: number | null = null;
  let panOrigin = { x: 0, y: 0, panX: 0, panY: 0 };
  let mediaCleanup: (() => void) | null = null;

  const applyTransform = (): void => {
    const stageSize: Size = { width: stage.clientWidth, height: stage.clientHeight };
    if (stageSize.width <= 0 || stageSize.height <= 0 || natural.width <= 0) return;
    const base = computeBaseScale(stageSize, natural, mode, state.viewPreferences.stretchSmall);
    const scale = base * (state.manualTransform.zoomPercent / 100);
    const scaled: Size = { width: natural.width * scale, height: natural.height * scale };
    const pan = clampPan(stageSize, scaled, state.manualTransform.panX, state.manualTransform.panY);
    state.manualTransform.panX = pan.x;
    state.manualTransform.panY = pan.y;

    let baseX = (stageSize.width - scaled.width) / 2;
    let baseY = (stageSize.height - scaled.height) / 2;
    if (mode === "fitWidth" && scaled.height > stageSize.height) {
      baseY = 0;
    }
    content.style.width = `${scaled.width}px`;
    content.style.height = `${scaled.height}px`;
    content.style.transform = `translate(${baseX + pan.x}px, ${baseY + pan.y}px)`;
    const overflows = contentOverflows(stageSize, scaled);
    const showZones = !overflows && !panning;
    leftZone.hidden = !showZones;
    rightZone.hidden = !showZones;
  };
  // Track the CachedMedia object currently attached. loadPages after a cache hit
  // used to call showMedia again with the same object and tear down a live <video>
  // (restart from 0). Fallback mutates url on the same object via applyVideoSource
  // without going through showMedia — identity skip is correct.
  let mountedMedia: CachedMedia | null = null;
  const showMedia = (media: CachedMedia): void => {
    if (!shouldRemountCachedMedia(mountedMedia, media)) return;
    // Tear down previous first. Old cleanup must not clear the new identity.
    const previousCleanup = mediaCleanup;
    mediaCleanup = null;
    previousCleanup?.();
    mountedMedia = media;
    const attached = attachMediaElement(
      mediaHost,
      media,
      "reader__media--single",
      `Page ${state.pageIndex + 1}`,
      state.pageIndex,
      (size) => {
        natural = size;
        applyTransform();
      }
    );
    mediaCleanup = () => {
      if (mountedMedia === media) mountedMedia = null;
      attached.cleanup();
    };
  };

  const ro = new ResizeObserver(() => applyTransform());
  ro.observe(stage);

  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -10 : 10;
      state.manualTransform.zoomPercent = clampZoom(
        state.manualTransform.zoomPercent + (e.shiftKey ? (delta > 0 ? 1 : -1) : delta),
        800
      );
      applyTransform();
      const label = document.querySelector(".reader__zoom-label");
      if (label) label.textContent = `${Math.round(state.manualTransform.zoomPercent)}%`;
      return;
    }
    if (e.shiftKey && Math.abs(e.deltaY) > 0) {
      e.preventDefault();
      state.manualTransform.zoomPercent = clampZoom(
        state.manualTransform.zoomPercent + (e.deltaY > 0 ? -1 : 1),
        800
      );
      applyTransform();
      const label = document.querySelector(".reader__zoom-label");
      if (label) label.textContent = `${Math.round(state.manualTransform.zoomPercent)}%`;
      return;
    }
    const stageSize: Size = { width: stage.clientWidth, height: stage.clientHeight };
    if (natural.width <= 0) return;
    const base = computeBaseScale(stageSize, natural, mode, state.viewPreferences.stretchSmall);
    const scale = base * (state.manualTransform.zoomPercent / 100);
    const scaled: Size = { width: natural.width * scale, height: natural.height * scale };
    if (!contentOverflows(stageSize, scaled)) return;
    e.preventDefault();
    state.manualTransform.panX -= e.deltaX;
    state.manualTransform.panY -= e.deltaY;
    applyTransform();
  };
  stage.addEventListener("wheel", onWheel, { passive: false });

  const onPointerDown = (e: PointerEvent): void => {
    if (!e.altKey || e.button !== 0) return;
    const stageSize: Size = { width: stage.clientWidth, height: stage.clientHeight };
    if (natural.width <= 0) return;
    const base = computeBaseScale(stageSize, natural, mode, state.viewPreferences.stretchSmall);
    const scale = base * (state.manualTransform.zoomPercent / 100);
    const scaled: Size = { width: natural.width * scale, height: natural.height * scale };
    if (!contentOverflows(stageSize, scaled)) return;
    e.preventDefault();
    panning = true;
    panPointerId = e.pointerId;
    panOrigin = {
      x: e.clientX,
      y: e.clientY,
      panX: state.manualTransform.panX,
      panY: state.manualTransform.panY,
    };
    stage.setPointerCapture(e.pointerId);
    applyTransform();
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!panning || e.pointerId !== panPointerId) return;
    state.manualTransform.panX = panOrigin.panX + (e.clientX - panOrigin.x);
    state.manualTransform.panY = panOrigin.panY + (e.clientY - panOrigin.y);
    applyTransform();
  };
  const endPan = (e: PointerEvent): void => {
    if (!panning || e.pointerId !== panPointerId) return;
    panning = false;
    panPointerId = null;
    applyTransform();
  };
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", endPan);
  stage.addEventListener("pointercancel", endPan);

  stage.append(leftZone, rightZone);

  const loading = document.createElement("div");
  loading.className = "reader__loading";
  loading.textContent = "Loading page";
  if (!pageCache.has(state.pageIndex)) stage.append(loading);

  const cached = pageCache.get(state.pageIndex);
  if (cached) showMedia(cached);

  void (async () => {
    try {
      state.loading = !pageCache.has(state.pageIndex);
      await loadPages(
        [...cacheIndices(state.pageIndex, comic.pageCount, mode)],
        generation,
        new Set([state.pageIndex])
      );
      if (generation !== renderGeneration) return;
      const media = pageCache.get(state.pageIndex);
      if (media) showMedia(media);
      loading.remove();
      state.loading = false;
    } catch (err) {
      if (generation !== renderGeneration) return;
      loading.remove();
      state.loading = false;
      showToast(errMessage(err));
    }
  })();

  readerCleanup = () => {
    mediaCleanup?.();
    ro.disconnect();
    stage.removeEventListener("wheel", onWheel);
    stage.removeEventListener("pointerdown", onPointerDown);
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerup", endPan);
    stage.removeEventListener("pointercancel", endPan);
    if (lastPersistedProgress !== state.pageIndex) {
      queueProgress(state.pageIndex);
    }
  };
}

function mountSpreadReader(
  stage: HTMLElement,
  comic: Comic,
  mode: "doubleLTR" | "doubleRTL",
  generation: number
): void {
  const content = document.createElement("div");
  content.className = "reader__content reader__content--spread";
  const hostA = document.createElement("div");
  const hostB = document.createElement("div");
  hostA.className = "reader__media-host reader__media-host--spread";
  hostB.className = "reader__media-host reader__media-host--spread";
  content.append(hostA, hostB);
  stage.append(content);

  const leftZone = document.createElement("button");
  leftZone.type = "button";
  leftZone.className = "reader__zone reader__zone--left";
  leftZone.setAttribute("aria-label", "Previous spread");
  leftZone.addEventListener("click", () => void navigate(-1));
  const rightZone = document.createElement("button");
  rightZone.type = "button";
  rightZone.className = "reader__zone reader__zone--right";
  rightZone.setAttribute("aria-label", "Next spread");
  rightZone.addEventListener("click", () => void navigate(1));

  let naturalPages: Size[] = [];
  let panning = false;
  let panPointerId: number | null = null;
  let panOrigin = { x: 0, y: 0, panX: 0, panY: 0 };
  let cleanupA: (() => void) | null = null;
  let cleanupB: (() => void) | null = null;

  const currentSpread = () => spreadForPage(state.pageIndex, comic.pageCount, mode);

  const applyTransform = (): void => {
    const stageSize: Size = { width: stage.clientWidth, height: stage.clientHeight };
    if (stageSize.width <= 0 || naturalPages.length === 0) return;
    const contentSize: Size = {
      width: naturalPages.reduce((s, p) => s + p.width, 0),
      height: Math.max(...naturalPages.map((p) => p.height)),
    };
    const base = computeBaseScale(stageSize, contentSize, mode, state.viewPreferences.stretchSmall);
    const scale = base * (state.manualTransform.zoomPercent / 100);
    const scaled: Size = { width: contentSize.width * scale, height: contentSize.height * scale };
    const pan = clampPan(stageSize, scaled, state.manualTransform.panX, state.manualTransform.panY);
    state.manualTransform.panX = pan.x;
    state.manualTransform.panY = pan.y;
    const baseX = (stageSize.width - scaled.width) / 2;
    const baseY = (stageSize.height - scaled.height) / 2;
    content.style.width = `${scaled.width}px`;
    content.style.height = `${scaled.height}px`;
    content.style.transform = `translate(${baseX + pan.x}px, ${baseY + pan.y}px)`;

    const hosts = [hostA, hostB];
    naturalPages.forEach((n, i) => {
      const el = hosts[i];
      if (!el) return;
      el.style.width = `${n.width * scale}px`;
      el.style.height = `${n.height * scale}px`;
      el.style.marginTop = `${((contentSize.height - n.height) * scale) / 2}px`;
      el.hidden = false;
    });
    if (naturalPages.length < 2) {
      hostB.hidden = true;
      hostB.replaceChildren();
      cleanupB?.();
      cleanupB = null;
    }

    const overflows = contentOverflows(stageSize, scaled);
    leftZone.hidden = overflows || panning;
    rightZone.hidden = overflows || panning;
  };

  const ro = new ResizeObserver(() => applyTransform());
  ro.observe(stage);

  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      const max = 800;
      if (e.ctrlKey || e.metaKey) {
        state.manualTransform.zoomPercent = clampZoom(
          state.manualTransform.zoomPercent + (e.deltaY > 0 ? -10 : 10),
          max
        );
      } else {
        state.manualTransform.zoomPercent = clampZoom(
          state.manualTransform.zoomPercent + (e.deltaY > 0 ? -1 : 1),
          max
        );
      }
      applyTransform();
      const label = document.querySelector(".reader__zoom-label");
      if (label) label.textContent = `${Math.round(state.manualTransform.zoomPercent)}%`;
      return;
    }
    if (naturalPages.length === 0) return;
    const stageSize: Size = { width: stage.clientWidth, height: stage.clientHeight };
    const contentSize: Size = {
      width: naturalPages.reduce((s, p) => s + p.width, 0),
      height: Math.max(1, ...naturalPages.map((p) => p.height)),
    };
    const base = computeBaseScale(stageSize, contentSize, mode, state.viewPreferences.stretchSmall);
    const scale = base * (state.manualTransform.zoomPercent / 100);
    const scaled: Size = { width: contentSize.width * scale, height: contentSize.height * scale };
    if (!contentOverflows(stageSize, scaled)) return;
    e.preventDefault();
    state.manualTransform.panX -= e.deltaX;
    state.manualTransform.panY -= e.deltaY;
    applyTransform();
  };
  stage.addEventListener("wheel", onWheel, { passive: false });

  const onPointerDown = (e: PointerEvent): void => {
    if (!e.altKey || e.button !== 0) return;
    if (naturalPages.length === 0) return;
    const stageSize: Size = { width: stage.clientWidth, height: stage.clientHeight };
    const contentSize: Size = {
      width: naturalPages.reduce((s, p) => s + p.width, 0),
      height: Math.max(1, ...naturalPages.map((p) => p.height)),
    };
    const base = computeBaseScale(stageSize, contentSize, mode, state.viewPreferences.stretchSmall);
    const scale = base * (state.manualTransform.zoomPercent / 100);
    const scaled: Size = { width: contentSize.width * scale, height: contentSize.height * scale };
    if (!contentOverflows(stageSize, scaled)) return;
    e.preventDefault();
    panning = true;
    panPointerId = e.pointerId;
    panOrigin = {
      x: e.clientX,
      y: e.clientY,
      panX: state.manualTransform.panX,
      panY: state.manualTransform.panY,
    };
    stage.setPointerCapture(e.pointerId);
    applyTransform();
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!panning || e.pointerId !== panPointerId) return;
    state.manualTransform.panX = panOrigin.panX + (e.clientX - panOrigin.x);
    state.manualTransform.panY = panOrigin.panY + (e.clientY - panOrigin.y);
    applyTransform();
  };
  const endPan = (e: PointerEvent): void => {
    if (!panning || e.pointerId !== panPointerId) return;
    panning = false;
    panPointerId = null;
    applyTransform();
  };
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", endPan);
  stage.addEventListener("pointercancel", endPan);
  stage.append(leftZone, rightZone);

  void (async () => {
    try {
      const pages = currentSpread();
      await loadPages(
        [...cacheIndices(state.pageIndex, comic.pageCount, mode)],
        generation,
        new Set(pages)
      );
      if (generation !== renderGeneration) return;
      naturalPages = [];
      cleanupA?.();
      cleanupB?.();
      cleanupA = null;
      cleanupB = null;
      hostA.replaceChildren();
      hostB.replaceChildren();

      const media0 = pageCache.get(pages[0]!);
      if (media0) {
        const attached = attachMediaElement(
          hostA,
          media0,
          "reader__media--spread",
          `Page ${pages[0]! + 1}`,
          pages[0]!,
          (size) => {
            naturalPages[0] = size;
            if (naturalPages.filter(Boolean).length === currentSpread().length) applyTransform();
          }
        );
        cleanupA = attached.cleanup;
      }
      if (pages[1] != null) {
        const media1 = pageCache.get(pages[1]);
        if (media1) {
          const attached = attachMediaElement(
            hostB,
            media1,
            "reader__media--spread",
            `Page ${pages[1] + 1}`,
            pages[1],
            (size) => {
              naturalPages[1] = size;
              if (naturalPages.filter(Boolean).length === currentSpread().length) applyTransform();
            }
          );
          cleanupB = attached.cleanup;
        }
      } else {
        hostB.hidden = true;
      }
    } catch (err) {
      if (generation !== renderGeneration) return;
      showToast(errMessage(err));
    }
  })();

  readerCleanup = () => {
    cleanupA?.();
    cleanupB?.();
    ro.disconnect();
    stage.removeEventListener("wheel", onWheel);
    stage.removeEventListener("pointerdown", onPointerDown);
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerup", endPan);
    stage.removeEventListener("pointercancel", endPan);
    if (lastPersistedProgress !== state.pageIndex) {
      queueProgress(state.pageIndex);
    }
  };
}

interface WebtoonStageHooks {
  __webtoonScroll?: (deltaRatio: number) => void;
  __webtoonJump?: (index: number) => void;
}

/** Viewport-height fraction for webtoon keyboard / toolbar paging. */
const WEBTOON_SCROLL_RATIO = 0.65;

function getWebtoonStage(stage: Element | null): (HTMLElement & WebtoonStageHooks) | null {
  if (!(stage instanceof HTMLElement)) return null;
  return stage as HTMLElement & WebtoonStageHooks;
}

function mountWebtoonReader(stage: HTMLElement, comic: Comic, generation: number): void {
  stage.classList.add("reader__stage--webtoon");
  const strip = document.createElement("div");
  strip.className = "reader__webtoon-strip";
  const zoom = clampZoom(state.manualTransform.zoomPercent, 200);
  strip.style.width = `${zoom}%`;
  stage.append(strip);

  const items: HTMLElement[] = [];
  const itemCleanups = new Map<number, () => void>();
  for (let i = 0; i < comic.pageCount; i++) {
    const item = document.createElement("div");
    item.className = "reader__webtoon-item";
    item.dataset.index = String(i);
    const ratio = state.webtoonPageRatios.get(i);
    if (ratio) item.style.aspectRatio = String(ratio);
    else item.style.minHeight = "80vh";
    strip.append(item);
    items.push(item);
  }

  let stableTimer: number | null = null;
  const fillCached = (index: number): void => {
    const keep = cacheIndices(index, comic.pageCount, "webtoon");
    for (const i of keep) {
      const item = items[i];
      if (!item) continue;
      const media = pageCache.get(i);
      if (!media) continue;
      // Video/audio only stay mounted while active; PDF/image neighbors stay.
      if (!shouldKeepWebtoonDomMedia(media.kind, i, index, keep, true)) continue;
      // Skip re-attach when the same media is already present.
      const existing = item.querySelector(".reader__media");
      if (
        existing instanceof HTMLElement &&
        existing.dataset.renderKey === mediaRenderKey(media, i)
      ) {
        continue;
      }
      itemCleanups.get(i)?.();
      const attached = attachMediaElement(
        item,
        media,
        "reader__webtoon-media",
        `Page ${i + 1}`,
        i,
        (size) => {
          // Markdown reflows; never lock an image-style ratio box.
          if (media.kind === "markdown") {
            state.webtoonPageRatios.delete(i);
            item.style.aspectRatio = "";
            item.style.minHeight = "";
            return;
          }
          if (size.width > 0 && size.height > 0) {
            const r = size.width / size.height;
            state.webtoonPageRatios.set(i, r);
            item.style.aspectRatio = String(r);
            item.style.minHeight = "";
          }
        }
      );
      attached.el.dataset.mediaUrl = media.url;
      attached.el.dataset.renderKey = mediaRenderKey(media, i);
      itemCleanups.set(i, attached.cleanup);
    }
    for (let i = 0; i < items.length; i++) {
      const media = pageCache.get(i);
      // Evicted/missing cache entries must unmount; video/audio only while active.
      const shouldKeepDom = shouldKeepWebtoonDomMedia(
        media?.kind ?? "image",
        i,
        index,
        keep,
        !!media
      );
      if (shouldKeepDom) continue;
      const item = items[i];
      itemCleanups.get(i)?.();
      itemCleanups.delete(i);
      item.replaceChildren();
    }
  };

  const setActive = (index: number): void => {
    if (index === state.webtoonActiveIndex && pageCache.has(index)) {
      // still refresh cache window
    } else {
      state.webtoonActiveIndex = index;
      state.pageIndex = index;
    }
    const input = document.querySelector(".reader__page-input") as HTMLInputElement | null;
    if (input) input.value = String(index + 1);
    const bar = document.querySelector(".reader__progress-bar") as HTMLElement | null;
    if (bar) {
      bar.style.width = `${comic.pageCount <= 1 ? 100 : ((index + 1) / comic.pageCount) * 100}%`;
    }
    const progress = document.querySelector(".reader__progress");
    if (progress) progress.setAttribute("aria-valuenow", String(index + 1));
    void loadPages(
      [...cacheIndices(index, comic.pageCount, "webtoon")],
      generation,
      new Set([index])
    ).then(
      () => {
        if (generation !== renderGeneration) return;
        fillCached(index);
      }
    );
    if (stableTimer != null) window.clearTimeout(stableTimer);
    stableTimer = window.setTimeout(() => {
      queueProgress(index);
    }, 250);
  };

  const activeObserver = new IntersectionObserver(
    (entries) => {
      let best: { index: number; dist: number } | null = null;
      const stageTop = stage.getBoundingClientRect().top;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = Number((entry.target as HTMLElement).dataset.index);
        const dist = Math.abs(entry.boundingClientRect.top - stageTop);
        if (!best || dist < best.dist) best = { index: idx, dist };
      }
      if (best) setActive(best.index);
    },
    { root: stage, rootMargin: "0px", threshold: [0, 0.1, 0.25, 0.5, 1] }
  );

  const nearObserver = new IntersectionObserver(
    (entries) => {
      const need: number[] = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        need.push(Number((entry.target as HTMLElement).dataset.index));
      }
      if (!need.length) return;
      void loadPages(
        [...new Set(need.flatMap((i) => [...cacheIndices(i, comic.pageCount, "webtoon")]))],
        generation,
        new Set()
      ).then(() => {
        if (generation !== renderGeneration) return;
        fillCached(state.webtoonActiveIndex);
      });
    },
    { root: stage, rootMargin: "150% 0px" }
  );

  for (const item of items) {
    activeObserver.observe(item);
    nearObserver.observe(item);
  }

  const resume = items[state.pageIndex];
  if (resume) {
    requestAnimationFrame(() => {
      resume.scrollIntoView({ block: "start" });
      setActive(state.pageIndex);
    });
  }

  const onWheelZoom = (e: WheelEvent): void => {
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    e.preventDefault();
    const delta = e.shiftKey ? (e.deltaY > 0 ? -1 : 1) : e.deltaY > 0 ? -10 : 10;
    state.manualTransform.zoomPercent = clampZoom(state.manualTransform.zoomPercent + delta, 200);
    strip.style.width = `${state.manualTransform.zoomPercent}%`;
    const label = document.querySelector(".reader__zoom-label");
    if (label) label.textContent = `${Math.round(state.manualTransform.zoomPercent)}%`;
  };
  stage.addEventListener("wheel", onWheelZoom, { passive: false });

  const hooked = stage as HTMLElement & WebtoonStageHooks;
  hooked.__webtoonScroll = (deltaRatio: number) => {
    stage.scrollBy({ top: stage.clientHeight * deltaRatio, behavior: "auto" });
  };
  hooked.__webtoonJump = (index: number) => {
    const item = items[Math.max(0, Math.min(comic.pageCount - 1, index))];
    item?.scrollIntoView({ block: "start" });
    setActive(Math.max(0, Math.min(comic.pageCount - 1, index)));
  };

  readerCleanup = () => {
    for (const cleanup of itemCleanups.values()) cleanup();
    itemCleanups.clear();
    activeObserver.disconnect();
    nearObserver.disconnect();
    stage.removeEventListener("wheel", onWheelZoom);
    if (stableTimer != null) window.clearTimeout(stableTimer);
    if (lastPersistedProgress !== state.webtoonActiveIndex) {
      queueProgress(state.webtoonActiveIndex);
    }
  };
}

async function handleOpenArchive(): Promise<void> {
  clearToast();
  state.loading = true;
  try {
    const comic = await ComicService.OpenArchive();
    if (!comic) throw new Error("open cancelled");
    await enterComic(comic);
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    state.loading = false;
    render();
  }
}

async function handleOpenFolder(): Promise<void> {
  clearToast();
  state.loading = true;
  try {
    const comic = await ComicService.OpenFolder();
    if (!comic) throw new Error("open cancelled");
    await enterComic(comic);
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    state.loading = false;
    render();
  }
}

async function handleOpenMedia(): Promise<void> {
  clearToast();
  state.loading = true;
  try {
    const comic = await ComicService.OpenMedia();
    if (!comic) throw new Error("open cancelled");
    await enterComic(comic);
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    state.loading = false;
    render();
  }
}

async function handleOpenPath(path: string): Promise<void> {
  clearToast();
  state.loading = true;
  try {
    const comic = await ComicService.OpenPath(path);
    if (!comic) throw new Error("open failed");
    await enterComic(comic);
  } catch (err) {
    showToast(errMessage(err));
  } finally {
    state.loading = false;
    render();
  }
}

async function handleOpenRecent(path: string): Promise<void> {
  clearToast();
  state.loading = true;
  try {
    const comic = await ComicService.OpenRecent(path);
    if (!comic) throw new Error("open failed");
    await enterComic(comic);
  } catch (err) {
    showToast(errMessage(err));
    await refreshLibrary();
  } finally {
    state.loading = false;
    render();
  }
}

async function enterComic(comic: Comic): Promise<void> {
  runReaderCleanup();
  clearPageCache();
  renderGeneration += 1;
  state.comic = comic;
  state.webtoonPageRatios = new Map();
  resetManualTransform();
  lastPersistedProgress = comic.currentPage;
  pendingProgressIndex = null;
  state.pageIndex = normalizePageIndex(
    comic.currentPage,
    comic.pageCount,
    state.viewPreferences.mode
  );
  state.webtoonActiveIndex = state.pageIndex;
}

async function handleBackToLibrary(): Promise<void> {
  runReaderCleanup();
  await flushProgress();
  state.comic = null;
  clearPageCache();
  renderGeneration += 1;
  await refreshLibrary();
  render();
}

function clampPage(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  if (index < 0) return 0;
  if (index >= pageCount) return pageCount - 1;
  return index;
}

async function navigate(delta: number): Promise<void> {
  if (!state.comic) return;
  const mode = state.viewPreferences.mode;
  if (mode === "webtoon") {
    const stage = getWebtoonStage(document.querySelector(".reader__stage--webtoon"));
    // Continuous strip: page-turn controls scroll a viewport fraction, not snap to next top.
    stage?.__webtoonScroll?.(delta * WEBTOON_SCROLL_RATIO);
    return;
  }
  if (isDoubleMode(mode)) {
    const lower = normalizePageIndex(state.pageIndex, state.comic.pageCount, mode);
    await goToPage(lower + delta * 2);
    return;
  }
  await goToPage(state.pageIndex + delta);
}

async function goToPage(index: number): Promise<void> {
  if (!state.comic) return;
  const mode = state.viewPreferences.mode;
  if (mode === "webtoon") {
    const stage = getWebtoonStage(document.querySelector(".reader__stage--webtoon"));
    const next = clampPage(index, state.comic.pageCount);
    stage?.__webtoonJump?.(next);
    return;
  }
  const next = normalizePageIndex(index, state.comic.pageCount, mode);
  const changed = next !== state.pageIndex;
  if (changed) {
    resetManualTransform();
    state.pageIndex = next;
    queueProgress(next);
    // In-flight RPCs complete through loadOnePage's publish gates.
    renderGeneration += 1;
    clearQueuedPageLoads();
    pageLoads.clear();
    render();
  } else {
    const generation = renderGeneration;
    await loadPages(
      [...cacheIndices(next, state.comic.pageCount, mode)],
      generation,
      isDoubleMode(mode) ? new Set(spreadForPage(next, state.comic.pageCount, mode)) : new Set([next])
    );
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const target = e.target;
  if (target instanceof HTMLElement) {
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
      return;
    }
  }

  // Native video/audio controls own Space / arrows while focused.
  const mediaFocused =
    target instanceof HTMLVideoElement ||
    target instanceof HTMLAudioElement ||
    (target instanceof HTMLElement && Boolean(target.closest("video, audio")));
  const code = e.code;
  const isNavCode =
    code === "Space" ||
    code === "ArrowLeft" ||
    code === "ArrowRight" ||
    code === "ArrowUp" ||
    code === "ArrowDown" ||
    code === "PageUp" ||
    code === "PageDown" ||
    code === "Home" ||
    code === "End" ||
    code === "KeyW" ||
    code === "KeyA" ||
    code === "KeyS" ||
    code === "KeyD";
  if (mediaFocused && isNavCode) {
    return;
  }

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "0") {
    e.preventDefault();
    setViewMode("original");
    return;
  }
  if (key === "1" || key === "9") {
    e.preventDefault();
    setViewMode("fitWindow");
    return;
  }
  if (key === "8") {
    e.preventDefault();
    setViewMode("fitWidth");
    return;
  }
  if (key === "h") {
    e.preventDefault();
    setViewMode("fitHeight");
    return;
  }
  if (key === "6") {
    e.preventDefault();
    setViewMode("doubleRTL");
    return;
  }
  if (key === "7") {
    e.preventDefault();
    setViewMode("doubleLTR");
    return;
  }
  if (key === "5") {
    e.preventDefault();
    setViewMode("webtoon");
    return;
  }
  if (key === "z") {
    e.preventDefault();
    if (state.viewPreferences.mode !== "original" && state.viewPreferences.mode !== "webtoon") {
      setStretchSmall(!state.viewPreferences.stretchSmall);
    }
    return;
  }
  if (key === "t") {
    e.preventDefault();
    if (state.comic) setToolbarCollapsed(!state.toolbarCollapsed);
    return;
  }

  if (!state.comic) return;
  const mode = state.viewPreferences.mode;
  const dir = state.readingDirection;
  // Physical WASD (IME-safe) + reading-direction-aware left/right.
  const isForward =
    code === (dir === "rtl" ? "ArrowLeft" : "ArrowRight") || code === "KeyD";
  const isBackward =
    code === (dir === "rtl" ? "ArrowRight" : "ArrowLeft") || code === "KeyA";
  const isDown = code === "ArrowDown" || code === "KeyS";
  const isUp = code === "ArrowUp" || code === "KeyW";

  if (mode === "webtoon") {
    const stage = getWebtoonStage(document.querySelector(".reader__stage--webtoon"));
    // All directional keys scroll by viewport fraction; Shift forces page-top jump.
    if (code === "Space" || code === "PageDown" || isDown || isForward) {
      e.preventDefault();
      if (e.shiftKey) stage?.__webtoonJump?.(state.webtoonActiveIndex + 1);
      else stage?.__webtoonScroll?.(WEBTOON_SCROLL_RATIO);
      return;
    }
    if (code === "PageUp" || isUp || isBackward) {
      e.preventDefault();
      if (e.shiftKey) stage?.__webtoonJump?.(state.webtoonActiveIndex - 1);
      else stage?.__webtoonScroll?.(-WEBTOON_SCROLL_RATIO);
      return;
    }
    if (code === "Home") {
      e.preventDefault();
      stage?.__webtoonJump?.(0);
      return;
    }
    if (code === "End") {
      e.preventDefault();
      stage?.__webtoonJump?.(state.comic.pageCount - 1);
      return;
    }
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      adjustZoom(e.shiftKey ? 1 : 10);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      adjustZoom(e.shiftKey ? -1 : -10);
      return;
    }
    return;
  }

  if (isForward || code === "Space" || code === "PageDown") {
    e.preventDefault();
    void navigate(1);
    return;
  }
  if (isBackward || code === "PageUp") {
    e.preventDefault();
    void navigate(-1);
    return;
  }
  // Non-webtoon: W/S also page prev/next for vertical keyboards.
  if (isDown) {
    e.preventDefault();
    void navigate(1);
    return;
  }
  if (isUp) {
    e.preventDefault();
    void navigate(-1);
    return;
  }
  if (code === "Home") {
    e.preventDefault();
    void goToPage(0);
    return;
  }
  if (code === "End") {
    e.preventDefault();
    void goToPage(state.comic.pageCount - 1);
    return;
  }
  if (e.key === "+" || e.key === "=") {
    e.preventDefault();
    adjustZoom(e.shiftKey ? 1 : 10);
    return;
  }
  if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    adjustZoom(e.shiftKey ? -1 : -10);
  }
}

async function refreshLibrary(): Promise<void> {
  try {
    const st = await ComicService.GetLibrary();
    applyLibrarySnapshot(st);
  } catch (err) {
    showToast(errMessage(err));
    if (!state.library) {
      state.library = {
        recents: [],
        settings: { saveRecents: true, retentionDays: 0 },
      };
    }
  }
}

async function boot(): Promise<void> {
  appRoot.dataset.fileDropTarget = "";
  document.addEventListener("keydown", onKeyDown);
  Events.On("files-dropped", (event: { data?: { files?: string[] } }) => {
    const files = event?.data?.files ?? [];
    if (files.length === 0) return;
    if (files.length !== 1) {
      showToast("Drop exactly one file or folder", "info");
      return;
    }
    void handleOpenPath(files[0]);
  });
  await refreshLibrary();
  void refreshDesktopIntegration();
  const pending = await ComicService.ConsumePendingOpenPath();
  if (pending) void handleOpenPath(pending);
  render();
}

void boot();
