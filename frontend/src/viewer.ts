export type ViewMode =
  | "fitWindow"
  | "fitWidth"
  | "fitHeight"
  | "original"
  | "doubleLTR"
  | "doubleRTL"
  | "webtoon";

export type ImageRendering = "smooth" | "pixelated" | "highQuality" | "noHalo" | "xbrz";

export interface ViewPreferences {
  mode: ViewMode;
  stretchSmall: boolean;
  imageRendering: ImageRendering;
}

export interface ManualTransform {
  zoomPercent: number;
  panX: number;
  panY: number;
}

export interface Size {
  width: number;
  height: number;
}

export const VIEW_PREFERENCES_KEY = "komika.viewPreferences";

const DEFAULT_PREFS: ViewPreferences = {
  mode: "fitWindow",
  stretchSmall: false,
  imageRendering: "smooth",
};

const VALID_IMAGE_RENDERINGS: ReadonlySet<ImageRendering> = new Set([
  "smooth",
  "pixelated",
  "highQuality",
  "noHalo",
  "xbrz",
]);

function isImageRendering(value: unknown): value is ImageRendering {
  return typeof value === "string" && VALID_IMAGE_RENDERINGS.has(value as ImageRendering);
}

const VALID_MODES: ReadonlySet<ViewMode> = new Set([
  "fitWindow",
  "fitWidth",
  "fitHeight",
  "original",
  "doubleLTR",
  "doubleRTL",
  "webtoon",
]);

function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && VALID_MODES.has(value as ViewMode);
}

export function loadViewPreferences(storage: Storage): ViewPreferences {
  let raw: string | null = null;
  try {
    raw = storage.getItem(VIEW_PREFERENCES_KEY);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (raw == null || raw === "") {
    return { ...DEFAULT_PREFS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const normalized = { ...DEFAULT_PREFS };
    saveViewPreferences(storage, normalized);
    return normalized;
  }
  if (parsed == null || typeof parsed !== "object") {
    const normalized = { ...DEFAULT_PREFS };
    saveViewPreferences(storage, normalized);
    return normalized;
  }
  const obj = parsed as Record<string, unknown>;
  const mode = isViewMode(obj.mode) ? obj.mode : DEFAULT_PREFS.mode;
  const stretchSmall =
    typeof obj.stretchSmall === "boolean" ? obj.stretchSmall : DEFAULT_PREFS.stretchSmall;
  const imageRendering = isImageRendering(obj.imageRendering)
    ? obj.imageRendering
    : DEFAULT_PREFS.imageRendering;
  const normalized: ViewPreferences = { mode, stretchSmall, imageRendering };
  // Persist normalized form when input was partially invalid or unknown fields present.
  const needsWrite =
    !isViewMode(obj.mode) ||
    typeof obj.stretchSmall !== "boolean" ||
    !isImageRendering(obj.imageRendering) ||
    Object.keys(obj).length !== 3;
  if (needsWrite) {
    saveViewPreferences(storage, normalized);
  }
  return normalized;
}

export function saveViewPreferences(storage: Storage, value: ViewPreferences): void {
  const normalized: ViewPreferences = {
    mode: isViewMode(value.mode) ? value.mode : DEFAULT_PREFS.mode,
    stretchSmall:
      typeof value.stretchSmall === "boolean" ? value.stretchSmall : DEFAULT_PREFS.stretchSmall,
    imageRendering: isImageRendering(value.imageRendering)
      ? value.imageRendering
      : DEFAULT_PREFS.imageRendering,
  };
  try {
    storage.setItem(VIEW_PREFERENCES_KEY, JSON.stringify(normalized));
  } catch {
    // Unavailable storage: leave in-memory value usable.
  }
}

export function clampZoom(value: number, max?: number): number {
  const upper = max ?? 800;
  if (!Number.isFinite(value)) return 100;
  if (value < 25) return 25;
  if (value > upper) return upper;
  return value;
}

export function computeBaseScale(
  stage: Size,
  content: Size,
  mode: ViewMode,
  stretchSmall: boolean
): number {
  if (content.width <= 0 || content.height <= 0 || stage.width <= 0 || stage.height <= 0) {
    return 1;
  }
  let scale: number;
  switch (mode) {
    case "original":
      scale = 1;
      break;
    case "fitWidth":
    case "webtoon":
      scale = stage.width / content.width;
      break;
    case "fitHeight":
      scale = stage.height / content.height;
      break;
    case "fitWindow":
    case "doubleLTR":
    case "doubleRTL":
    default:
      scale = Math.min(stage.width / content.width, stage.height / content.height);
      break;
  }
  if (!stretchSmall && mode !== "original" && scale > 1) {
    scale = 1;
  }
  return scale;
}

export function clampPan(
  stage: Size,
  scaledContent: Size,
  panX: number,
  panY: number
): { x: number; y: number } {
  const overflowX = Math.max(0, scaledContent.width - stage.width);
  const overflowY = Math.max(0, scaledContent.height - stage.height);
  const maxX = overflowX / 2;
  const maxY = overflowY / 2;
  let x = panX;
  let y = panY;
  if (maxX === 0) x = 0;
  else if (x < -maxX) x = -maxX;
  else if (x > maxX) x = maxX;
  if (maxY === 0) y = 0;
  else if (y < -maxY) y = -maxY;
  else if (y > maxY) y = maxY;
  return { x, y };
}

export function spreadForPage(
  index: number,
  pageCount: number,
  mode: "doubleLTR" | "doubleRTL"
): number[] {
  if (pageCount <= 0) return [];
  const clamped = Math.max(0, Math.min(pageCount - 1, index));
  const lower = Math.floor(clamped / 2) * 2;
  if (lower + 1 >= pageCount) {
    return [lower];
  }
  const pair = [lower, lower + 1];
  return mode === "doubleRTL" ? [pair[1], pair[0]] : pair;
}

export const PAGE_PRELOAD_RADIUS = 10;

export function cacheIndices(index: number, pageCount: number, mode: ViewMode): Set<number> {
  const out = new Set<number>();
  if (pageCount <= 0) return out;
  const clamped = Math.max(0, Math.min(pageCount - 1, index));

  if (mode === "webtoon") {
    for (let i = clamped - PAGE_PRELOAD_RADIUS; i <= clamped + PAGE_PRELOAD_RADIUS; i++) {
      if (i >= 0 && i < pageCount) out.add(i);
    }
    return out;
  }

  if (mode === "doubleLTR" || mode === "doubleRTL") {
    const lower = Math.floor(clamped / 2) * 2;
    for (
      let start = lower - PAGE_PRELOAD_RADIUS;
      start <= lower + PAGE_PRELOAD_RADIUS;
      start += 2
    ) {
      if (start < 0 || start >= pageCount) continue;
      out.add(start);
      if (start + 1 < pageCount) out.add(start + 1);
    }
    return out;
  }

  for (let i = clamped - PAGE_PRELOAD_RADIUS; i <= clamped + PAGE_PRELOAD_RADIUS; i++) {
    if (i >= 0 && i < pageCount) out.add(i);
  }
  return out;
}

export function orderPageLoadIndices(
  indices: Iterable<number>,
  active: number,
  visible: ReadonlySet<number>
): number[] {
  const unique = new Set<number>();
  for (const index of indices) {
    if (Number.isFinite(index) && index >= 0) unique.add(index);
  }

  return [...unique].sort((a, b) => {
    const aVisible = visible.has(a);
    const bVisible = visible.has(b);
    if (aVisible !== bVisible) return aVisible ? -1 : 1;
    return Math.abs(a - active) - Math.abs(b - active) || a - b;
  });
}

/**
 * Keep background preloading from occupying every load slot. Visible work may
 * use any free slot, while background work runs only when no other load is active.
 */
export function nextPageLoadQueueIndex(
  queue: ReadonlyArray<{ priority: "visible" | "background" }>,
  runningCount: number,
  maxConcurrent: number
): number {
  if (queue.length === 0 || runningCount >= maxConcurrent) return -1;
  const visible = queue.findIndex((job) => job.priority === "visible");
  if (visible >= 0) return visible;
  return runningCount === 0 ? 0 : -1;
}

export type MediaKind = "image" | "video" | "audio" | "pdf" | "markdown";

export function mediaKindForMime(mime: string): MediaKind | null {
  if (typeof mime !== "string" || mime === "") return null;
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower === "video/webm" || lower === "video/mp4" || lower === "video/quicktime") {
    return "video";
  }
  if (
    lower === "audio/mpeg" ||
    lower === "audio/mp4" ||
    lower === "audio/aac" ||
    lower === "audio/ogg" ||
    lower === "audio/opus" ||
    lower === "audio/wav"
  ) {
    return "audio";
  }
  if (lower === "application/pdf") return "pdf";
  if (lower === "text/markdown" || lower === "text/x-markdown") return "markdown";
  return null;
}

/**
 * True when playback has advanced enough to treat the stream as healthy.
 * Uses accumulated forward delta so seek/resume start offsets don't false-trigger.
 */
export function isMeaningfulVideoProgress(
  videoWidth: number,
  progressedSeconds: number,
  minProgress = 0.5
): boolean {
  return videoWidth > 0 && progressedSeconds >= minProgress;
}

/** Accumulate only forward clock movement (ignore seeks backward / resets). */
export function accumulateVideoProgress(
  lastTime: number,
  currentTime: number,
  progressed: number
): { lastTime: number; progressed: number } {
  if (!(currentTime >= 0) || !Number.isFinite(currentTime)) {
    return { lastTime, progressed };
  }
  if (!(lastTime >= 0) || !Number.isFinite(lastTime)) {
    return { lastTime: currentTime, progressed };
  }
  const delta = currentTime - lastTime;
  // Ignore large jumps (seek) and backward steps; count small forward ticks.
  if (delta > 0 && delta < 2) {
    return { lastTime: currentTime, progressed: progressed + delta };
  }
  return { lastTime: currentTime, progressed };
}

export type VideoFallbackStage = "none" | "remux" | "reencode" | "done";

/** Whether a page is close enough to the active page for expensive HQ work. */
export function isPageWithinRadius(
  pageIndex: number,
  activeIndex: number,
  radius: number
): boolean {
  if (!Number.isInteger(pageIndex) || !Number.isInteger(activeIndex)) return false;
  if (!Number.isFinite(radius) || radius < 0) return false;
  return Math.abs(pageIndex - activeIndex) <= Math.floor(radius);
}

/** Pure details open toggle used by diagnostics summary click handler. */
export function toggleDetailsOpen(currentlyOpen: boolean): boolean {
  return !currentlyOpen;
}

/** Whether reader video should call play() after an unexpected pause. */
export function shouldAutoResumeVideo(input: {
  disposed: boolean;
  fallingBack: boolean;
  userPaused: boolean;
  isPaused: boolean;
  ended: boolean;
  visibilityState: string;
}): boolean {
  if (input.disposed || input.fallingBack || input.userPaused) return false;
  if (input.ended) return false;
  if (!input.isPaused) return false;
  if (input.visibilityState === "hidden") return false;
  return true;
}

/**
 * Mark pause as user-intent if a control gesture happened recently.
 * gestureAt/pauseAt are performance.now()-style timestamps; windowMs default 500.
 */
export function isUserIntentionalPause(
  lastGestureAt: number | null,
  pauseAt: number,
  windowMs = 500
): boolean {
  if (lastGestureAt == null || !Number.isFinite(lastGestureAt)) return false;
  const dt = pauseAt - lastGestureAt;
  return dt >= 0 && dt <= windowMs;
}

/**
 * One-click play when the element was already paused before this gesture.
 * If it was playing, the same click is a pause intent — do not force play.
 */
/** Diagnostics accordion closed: always hard-kick unless terminal. */
/**
 * After ended, WebKit may show "playing" while frames stay frozen.
 * Reviving (reload src from 0) is appropriate when playback has ended
 * or a play gesture arrives while still marked ended.
 */
export function shouldReviveVideoAfterEnded(input: {
  ended: boolean;
  userWantsPlay: boolean;
}): boolean {
  return input.ended && input.userWantsPlay;
}

/** Single-flight gate: only the first play/click after ended may start a revive. */
export function beginEndedRevive(alreadyReviving: boolean): boolean {
  return !alreadyReviving;
}

/** Soft-loop: auto-revive after ended without native video.loop (WebKit mid-file rewind). */
export function shouldSoftLoopAfterEnded(input: {
  softLoop: boolean;
  ended: boolean;
  disposed: boolean;
  fallingBack: boolean;
  reviving: boolean;
}): boolean {
  return (
    input.softLoop &&
    input.ended &&
    !input.disposed &&
    !input.fallingBack &&
    !input.reviving
  );
}

export type VideoPlaybackChrome = {
  muted: boolean;
  volume: number;
  playbackRate: number;
};

export function captureVideoPlaybackChrome(el: {
  muted: boolean;
  volume: number;
  playbackRate: number;
}): VideoPlaybackChrome {
  const volume = Number.isFinite(el.volume) ? Math.min(1, Math.max(0, el.volume)) : 1;
  const playbackRate =
    Number.isFinite(el.playbackRate) && el.playbackRate > 0 ? el.playbackRate : 1;
  return { muted: Boolean(el.muted), volume, playbackRate };
}

export function applyVideoPlaybackChrome(
  el: { muted: boolean; volume: number; playbackRate: number },
  chrome: VideoPlaybackChrome
): void {
  el.muted = chrome.muted;
  el.volume = chrome.volume;
  el.playbackRate = chrome.playbackRate;
}

/** Same object identity → keep live <video>; do not tear down. */
export function shouldRemountCachedMedia(
  mounted: object | null | undefined,
  next: object | null | undefined
): boolean {
  if (!next) return false;
  if (!mounted) return true;
  return mounted !== next;
}

export function shouldHardKickPlaybackOnDiagnosticsClose(input: {
  disposed: boolean;
  fallingBack: boolean;
  ended: boolean;
}): boolean {
  return !input.disposed && !input.fallingBack && !input.ended;
}

export function shouldClickToPlayVideo(input: {
  disposed: boolean;
  fallingBack: boolean;
  ended: boolean;
  wasPausedBeforeGesture: boolean;
  isPausedNow: boolean;
}): boolean {
  if (input.disposed || input.fallingBack || input.ended) return false;
  if (!input.wasPausedBeforeGesture) return false;
  return input.isPausedNow;
}

export type StallWatchdogDecision =
  | { action: "noop" }
  | { action: "mark-ok" }
  | { action: "remux"; openDiagnostics: true }
  | { action: "reencode"; openDiagnostics: true }
  | { action: "error"; openDiagnostics: true; message: string };

/**
 * Pure decision for the black-controls stall timer.
 * Call after ~3.5s without confirmed forward progress (or on prolonged waiting).
 */
export function decideStallWatchdog(input: {
  disposed: boolean;
  fallingBack: boolean;
  hadMeaningfulPlayback: boolean;
  videoWidth: number;
  progressAccum: number;
  fallbackStage: VideoFallbackStage;
  minProgress?: number;
}): StallWatchdogDecision {
  if (input.disposed || input.fallingBack) return { action: "noop" };
  if (input.hadMeaningfulPlayback) return { action: "noop" };
  if (isMeaningfulVideoProgress(input.videoWidth, input.progressAccum, input.minProgress ?? 0.5)) {
    return { action: "mark-ok" };
  }
  if (input.fallbackStage === "none") {
    return { action: "remux", openDiagnostics: true };
  }
  if (input.fallbackStage === "remux") {
    return { action: "reencode", openDiagnostics: true };
  }
  // reencode or done — nowhere left to climb
  return {
    action: "error",
    openDiagnostics: true,
    message: "Playback stalled with no video progress after fallback.",
  };
}

/** Stop playback and drop the media resource so streams/blobs can be reclaimed. */
export function releaseHtmlMediaElement(el: {
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
}): void {
  el.pause();
  el.removeAttribute("src");
  el.load();
}

/** User-facing message when native play and host/wasm fallback both fail. */
export function mediaPlaybackFallbackMessage(err: unknown, kind: "video" | "audio"): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const lower = raw.toLowerCase();
  if (
    lower.includes("ffmpeg not found") ||
    lower.includes("executable file not found") ||
    lower.includes("not found on path") ||
    lower.includes("ffmpeg=")
  ) {
    return kind === "video"
      ? "WebView could not decode this video (VLC may still play it). Install WebKit/GStreamer codecs and/or ffmpeg — Debian/Ubuntu: sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good ffmpeg"
      : "WebView could not decode this audio. Debian/Ubuntu: sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good ffmpeg";
  }
  if (raw.trim() !== "") {
    return raw;
  }
  return kind === "video"
    ? "WebView could not play this video (often H.264/AAC). Debian/Ubuntu: sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good ffmpeg — then fully restart the app. AppImage needs bundled GStreamer plugins (rebuild) or use .deb / host ffmpeg fallback."
    : "WebView could not play this audio. Debian/Ubuntu: sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good ffmpeg";
}


/** Whether loadPages should fetch this index given delivery/kind and visibility. */
export function shouldLoadMediaDelivery(
  delivery: string | undefined,
  kind: MediaKind | null,
  index: number,
  visible: ReadonlySet<number>
): boolean {
  if (!kind) return false;
  const isStream = delivery === "stream";
  // Per-page streams stay visible-only. PDF shares one document URL across pages,
  // so neighbors may load outside the strict visible set (cache window decides).
  if (isStream && kind !== "pdf" && !visible.has(index)) return false;
  // Video/audio stay mounted only while visible; PDF is rasterized per page and
  // must retain neighbors for continuous scroll / page-turn.
  if ((kind === "video" || kind === "audio") && !visible.has(index)) {
    return false;
  }
  return true;
}

/** Whether a cached entry survives trimCache for the current keep/visible sets. */
export function shouldRetainCachedMedia(
  kind: MediaKind,
  delivery: string | undefined,
  index: number,
  keep: ReadonlySet<number>,
  visible: ReadonlySet<number>
): boolean {
  // Video/audio and per-page streams are visible-only. PDF shares one document URL
  // and follows the normal cache window so webtoon neighbors stay warm.
  if (kind === "video" || kind === "audio" || (delivery === "stream" && kind !== "pdf")) {
    return visible.has(index);
  }
  return keep.has(index);
}

/** Webtoon strip: keep mounted media in the cache window (video/audio only while active). */
export function shouldKeepWebtoonDomMedia(
  kind: MediaKind,
  index: number,
  active: number,
  keep: ReadonlySet<number>,
  hasMedia: boolean
): boolean {
  if (!hasMedia || !keep.has(index)) return false;
  if (kind === "video" || kind === "audio") return index === active;
  return true;
}
