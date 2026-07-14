export type ViewMode =
  | "fitWindow"
  | "fitWidth"
  | "fitHeight"
  | "original"
  | "doubleLTR"
  | "doubleRTL"
  | "webtoon";

export type ImageRendering = "smooth" | "pixelated";

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

const VALID_IMAGE_RENDERINGS: ReadonlySet<ImageRendering> = new Set(["smooth", "pixelated"]);

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

export function cacheIndices(index: number, pageCount: number, mode: ViewMode): Set<number> {
  const out = new Set<number>();
  if (pageCount <= 0) return out;
  const clamped = Math.max(0, Math.min(pageCount - 1, index));

  if (mode === "webtoon") {
    for (let i = clamped - 2; i <= clamped + 2; i++) {
      if (i >= 0 && i < pageCount) out.add(i);
    }
    return out;
  }

  if (mode === "doubleLTR" || mode === "doubleRTL") {
    const lower = Math.floor(clamped / 2) * 2;
    const spreads = [lower - 2, lower, lower + 2];
    for (const start of spreads) {
      if (start < 0 || start >= pageCount) continue;
      out.add(start);
      if (start + 1 < pageCount) out.add(start + 1);
    }
    return out;
  }

  for (const i of [clamped - 1, clamped, clamped + 1]) {
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

export type MediaKind = "image" | "video" | "audio";

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
  return null;
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

/** Whether loadPages should fetch this index given delivery/kind and visibility. */
export function shouldLoadMediaDelivery(
  delivery: string | undefined,
  kind: MediaKind | null,
  index: number,
  visible: ReadonlySet<number>
): boolean {
  if (!kind) return false;
  const isStream = delivery === "stream";
  if (isStream && !visible.has(index)) return false;
  if ((kind === "video" || kind === "audio") && !visible.has(index)) return false;
  return true;
}
