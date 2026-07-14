import "merak-protocol-design-system/style.css";
import "./style.css";
import { ComicService } from "../bindings/komika";
import type { Comic, LibrarySettings, LibraryState, RecentComic } from "../bindings/komika";
import { Events, Window as WailsWindow } from "@wailsio/runtime";
import {
  cacheIndices,
  clampPan,
  clampZoom,
  computeBaseScale,
  loadViewPreferences,
  mediaKindForMime,
  orderPageLoadIndices,
  saveViewPreferences,
  releaseHtmlMediaElement,
  shouldLoadMediaDelivery,
  spreadForPage,
  type ImageRendering,
  type ManualTransform,
  type MediaKind,
  type Size,
  type ViewMode,
  type ViewPreferences,
} from "./viewer";

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
}

const DIRECTION_KEY = "komika.readingDirection";
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
};

interface CachedMedia {
  mime: string;
  kind: MediaKind;
  url: string;
  delivery: "blob" | "stream";
  streamToken?: string;
}

const MAX_CONCURRENT_PAGE_LOADS = 2;
const pageCache = new Map<number, CachedMedia>();
const pageLoads = new Map<number, Promise<CachedMedia | undefined>>();
const pageLoadDeferreds = new Map<number, Deferred<CachedMedia | undefined>>();
const pageLoadErrors = new Map<number, unknown>();

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
  if (media.delivery === "blob") {
    URL.revokeObjectURL(media.url);
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
  for (const media of pageCache.values()) {
    revokeCached(media);
  }
  pageCache.clear();
  clearQueuedPageLoads();
  pageLoads.clear();
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

function makeUnavailableMediaCard(message: string, mediaUrl?: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "reader__media reader__media--error";
  card.setAttribute("role", "img");
  card.textContent = message;
  if (mediaUrl) card.dataset.mediaUrl = mediaUrl;
  return card;
}

function attachMediaElement(
  host: HTMLElement,
  media: CachedMedia,
  className: string,
  alt: string,
  onSized: (size: Size) => void
): { el: HTMLElement; cleanup: () => void } {
  host.replaceChildren();
  if (media.kind === "image") {
    const img = document.createElement("img");
    const pixelated = state.viewPreferences.imageRendering === "pixelated";
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
  if (media.kind === "audio") {
    const probe = document.createElement("audio");
    if (probe.canPlayType(media.mime) === "") {
      const card = makeUnavailableMediaCard(
        "This audio format or codec is not supported on this device.",
        media.url
      );
      card.className = `${className} ${card.className}`;
      host.append(card);
      onSized({ width: 16, height: 9 });
      return { el: card, cleanup: () => {} };
    }

    const shell = document.createElement("div");
    shell.className = `${className} reader__media reader__media--audio-shell`;
    shell.dataset.mediaUrl = media.url;

    const audio = document.createElement("audio");
    audio.className = "reader__media--audio";
    audio.controls = true;
    audio.loop = true;
    audio.preload = "metadata";
    audio.setAttribute("aria-label", alt);

    const onMeta = (): void => {
      // Audio has no intrinsic pixel size; keep fit/zoom paths stable.
      onSized({ width: 16, height: 9 });
    };
    const onError = (): void => {
      const card = makeUnavailableMediaCard("This media is unavailable.", media.url);
      card.className = `${className} ${card.className}`;
      host.replaceChildren(card);
      onSized({ width: 16, height: 9 });
    };
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("error", onError);
    audio.src = media.url;
    shell.append(audio);
    host.append(shell);
    // Size immediately so layout does not wait on metadata for audio-only.
    onSized({ width: 16, height: 9 });
    return {
      el: shell,
      cleanup: () => {
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("error", onError);
        releaseHtmlMediaElement(audio);
      },
    };
  }


  const probe = document.createElement("video");
  if (probe.canPlayType(media.mime) === "") {
    const card = makeUnavailableMediaCard(
      "This video format or codec is not supported on this device.",
      media.url
    );
    card.className = `${className} ${card.className}`;
    host.append(card);
    onSized({ width: 16, height: 9 });
    return { el: card, cleanup: () => {} };
  }

  const video = document.createElement("video");
  video.className = `${className} reader__media reader__media--video`;
  video.controls = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-label", alt);
  video.dataset.mediaUrl = media.url;

  const onMeta = (): void => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      onSized({ width: video.videoWidth, height: video.videoHeight });
    }
  };
  const onError = (): void => {
    const card = makeUnavailableMediaCard("This media is unavailable.", media.url);
    card.className = `${className} ${card.className}`;
    host.replaceChildren(card);
    onSized({ width: 16, height: 9 });
  };
  // Autoplay stays muted; first user gesture enables audio.
  const unmuteOnGesture = (): void => {
    video.muted = false;
  };
  video.addEventListener("loadedmetadata", onMeta);
  video.addEventListener("error", onError);
  video.addEventListener("pointerdown", unmuteOnGesture, { once: true });
  video.src = media.url;
  void video.play().catch(() => {});
  host.append(video);
  return {
    el: video,
    cleanup: () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onError);
      video.removeEventListener("pointerdown", unmuteOnGesture);
      releaseHtmlMediaElement(video);
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
    const shouldKeep =
      cached.kind === "video" || cached.kind === "audio" || cached.delivery === "stream"
        ? visible.has(key)
        : keep.has(key);
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
    const nextJob = pageLoadQueue.findIndex((job) => !pageLoadRunning.has(job.index));
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
  let retainVisible: ReadonlySet<number>;
  if (mode === "webtoon") {
    retainVisible = new Set([state.webtoonActiveIndex]);
  } else if (isDoubleMode(mode)) {
    retainVisible = new Set(spreadForPage(state.pageIndex, comic.pageCount, mode));
  } else {
    retainVisible = new Set([state.pageIndex]);
  }
  if (desc?.delivery === "stream" || kind === "video" || kind === "audio") {
    return shouldLoadMediaDelivery(desc?.delivery, kind, index, retainVisible);
  }
  return cacheIndices(active, comic.pageCount, mode).has(index);
}

async function loadOnePage(index: number): Promise<CachedMedia | undefined> {
  const comic = state.comic;
  if (!comic) return undefined;
  const desc = comic.pages?.[index];
  const delivery = desc?.delivery === "stream" ? "stream" : "rpc";
  let media: CachedMedia;

  if (delivery === "stream") {
    const stream = await ComicService.GetPageStream(index);
    if (!stream?.url || !stream.token) throw new Error("empty page stream");
    const kind = mediaKindForMime(desc?.mime ?? "");
    if (!kind) throw new Error(`unsupported media mime: ${desc?.mime ?? ""}`);
    media = {
      mime: desc?.mime ?? "",
      kind,
      url: stream.url,
      delivery: "stream",
      streamToken: stream.token,
    };
  } else {
    const payload = await ComicService.GetPage(index);
    if (!payload) throw new Error("empty page payload");
    const kind = mediaKindForMime(payload.mime);
    if (!kind) throw new Error(`unsupported media mime: ${payload.mime}`);
    const bytes = decodePayloadData(payload.data);
    media = {
      mime: payload.mime,
      kind,
      url: URL.createObjectURL(new Blob([bytes], { type: payload.mime })),
      delivery: "blob",
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
        render();
      }
    )
  );
  header.append(titleBlock, actions);
  view.append(header);

  if (state.historySettingsOpen) {
    view.append(renderHistorySettings());
  }

  const settings = librarySettings();
  const recents = state.library?.recents ?? [];

  if (!settings.saveRecents) {
    const notice = document.createElement("div");
    notice.className = "history-notice";
    notice.textContent = "Recent history is not being saved";
    view.append(notice);
  }

  if (recents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "library__empty";
    const emptyTitle = document.createElement("div");
    emptyTitle.className = "mp-heading--section";
    emptyTitle.textContent = "No recent history";
    const emptyBody = document.createElement("p");
    emptyBody.className = "mp-text--muted";
    emptyBody.textContent = settings.saveRecents
      ? "Open an archive, folder, or media file to begin reading. Recent history and resume positions appear here."
      : "Saving is disabled. Open an archive, folder, or media file to read without adding to history.";
    const emptyActions = document.createElement("div");
    emptyActions.className = "library__actions mp-button-row";
    emptyActions.append(
      makeButton("Open archive", "mp-button--primary", () => void handleOpenArchive()),
      makeButton("Open folder", "mp-button--secondary", () => void handleOpenFolder()),
      makeButton("Open media", "mp-button--secondary", () => void handleOpenMedia())
    );
    empty.append(emptyTitle, emptyBody, emptyActions);
    view.append(empty);
    return view;
  }

  const section = document.createElement("section");
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
  view.append(section);
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

  const stage = document.createElement("div");
  stage.className = "reader__stage";
  if (mode === "webtoon") stage.classList.add("reader__stage--webtoon");

  view.append(toolbar, stage);

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
  const showMedia = (media: CachedMedia): void => {
    mediaCleanup?.();
    const attached = attachMediaElement(
      mediaHost,
      media,
      "reader__media--single",
      `Page ${state.pageIndex + 1}`,
      (size) => {
        natural = size;
        applyTransform();
      }
    );
    mediaCleanup = attached.cleanup;
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
      // Video/audio only stay mounted while active.
      if ((media.kind === "video" || media.kind === "audio") && i !== index) continue;
      // Skip re-attach when the same media is already present.
      const existing = item.querySelector(".reader__media");
      if (
        existing instanceof HTMLElement &&
        existing.dataset.mediaUrl === media.url
      ) {
        continue;
      }
      itemCleanups.get(i)?.();
      const attached = attachMediaElement(
        item,
        media,
        "reader__webtoon-media",
        `Page ${i + 1}`,
        (size) => {
          if (size.width > 0 && size.height > 0) {
            const r = size.width / size.height;
            state.webtoonPageRatios.set(i, r);
            item.style.aspectRatio = String(r);
            item.style.minHeight = "";
          }
        }
      );
      attached.el.dataset.mediaUrl = media.url;
      itemCleanups.set(i, attached.cleanup);
    }
    for (let i = 0; i < items.length; i++) {
      const media = pageCache.get(i);
      // Evicted/missing cache entries must unmount; video/audio only while active.
      const shouldKeepDom =
        keep.has(i) && !!media && ((media.kind !== "video" && media.kind !== "audio") || i === index);
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
  render();
}

void boot();
