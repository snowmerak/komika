import { FFmpeg } from "@ffmpeg/ffmpeg";
// package exports: "." → core js, "./wasm" → core wasm
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

/** Soft cap: whole-file WASM load; larger media stays on native/host-ffmpeg only. */
export const WASM_TRANSCODE_MAX_BYTES = 12 << 20; // 12 MiB — larger clips need host ffmpeg

let ffmpegSingleton: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let loadFailed: Error | null = null;
/** Single-flight queue: one core is not safe for concurrent exec/write. */
let chain: Promise<unknown> = Promise.resolve();
/** Core currently inside write/exec/read — abort calls terminate() on this. */
let activeCore: FFmpeg | null = null;

export function isFFmpegUnavailableError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const lower = raw.toLowerCase();
  return (
    lower.includes("ffmpeg not found") ||
    lower.includes("executable file not found") ||
    lower.includes("not found on path") ||
    lower.includes("ffmpeg=")
  );
}

/** Prefer the terminal (wasm) error; keep host-ffmpeg hint only as secondary text. */
export function combinedFallbackMessage(
  hostErr: unknown,
  wasmErr: unknown,
  kind: "video" | "audio"
): string {
  const wasmRaw = wasmErr instanceof Error ? wasmErr.message : String(wasmErr ?? "");
  const hostRaw = hostErr instanceof Error ? hostErr.message : String(hostErr ?? "");
  if (wasmRaw.trim() !== "") {
    if (isFFmpegUnavailableError(hostErr)) {
      return `${wasmRaw} (system ffmpeg also unavailable)`;
    }
    if (hostRaw.trim() !== "" && !isFFmpegUnavailableError(hostErr)) {
      return `${wasmRaw} (host fallback: ${hostRaw})`;
    }
    return wasmRaw;
  }
  if (isFFmpegUnavailableError(hostErr)) {
    return kind === "video"
      ? "This video codec is not supported here. Install ffmpeg or wait for the in-app decoder."
      : "This audio codec is not supported here. Install ffmpeg or wait for the in-app decoder.";
  }
  if (hostRaw.trim() !== "") return hostRaw;
  return kind === "video"
    ? "This video format or codec is not supported on this device."
    : "This audio format or codec is not supported on this device.";
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Kill worker and drop singleton so the next job reloads a fresh core. */
function terminateActiveCore(): void {
  const ff = activeCore ?? ffmpegSingleton;
  activeCore = null;
  ffmpegSingleton = null;
  loadPromise = null;
  // Aborted mid-flight is not a permanent load failure.
  loadFailed = null;
  if (!ff) return;
  try {
    ff.terminate();
  } catch {
    /* ignore */
  }
}

async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegSingleton?.loaded) return ffmpegSingleton;
  if (loadFailed) throw loadFailed;
  if (!loadPromise) {
    loadPromise = (async () => {
      const ff = new FFmpeg();
      await ff.load({ coreURL, wasmURL });
      ffmpegSingleton = ff;
      return ff;
    })().catch((err) => {
      loadFailed = err instanceof Error ? err : new Error(String(err));
      loadPromise = null;
      throw loadFailed;
    });
  }
  return loadPromise;
}

function extForMime(mime: string, kind: "video" | "audio"): string {
  const lower = mime.toLowerCase();
  if (lower.includes("webm")) return "webm";
  if (lower.includes("quicktime") || lower.endsWith("/mov")) return "mov";
  if (lower.includes("mp4") || lower.includes("m4a") || lower.includes("aac")) return "mp4";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("ogg") || lower.includes("opus")) return "ogg";
  if (lower.includes("wav")) return "wav";
  return kind === "audio" ? "bin" : "mp4";
}

function tooLargeError(n: number): Error {
  return new Error(`media too large for in-app decoder (${n} bytes; max ${WASM_TRANSCODE_MAX_BYTES})`);
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Read a Response body with a hard byte cap (avoids arrayBuffer OOM on huge streams). */
async function readResponseCapped(res: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(res.headers.get("Content-Length") || "0");
  if (Number.isFinite(declared) && declared > WASM_TRANSCODE_MAX_BYTES) {
    throw tooLargeError(declared);
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > WASM_TRANSCODE_MAX_BYTES) throw tooLargeError(buf.byteLength);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > WASM_TRANSCODE_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw tooLargeError(total);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function loadInputBytes(
  source: Blob | ArrayBuffer | Uint8Array | string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (typeof source === "string") {
    const res = await fetch(source, { signal });
    if (!res.ok) throw new Error(`wasm fallback fetch failed: ${res.status}`);
    return readResponseCapped(res, signal);
  }
  if (source instanceof Blob) {
    if (source.size > WASM_TRANSCODE_MAX_BYTES) throw tooLargeError(source.size);
    return new Uint8Array(await source.arrayBuffer());
  }
  if (source instanceof ArrayBuffer) {
    if (source.byteLength > WASM_TRANSCODE_MAX_BYTES) throw tooLargeError(source.byteLength);
    return new Uint8Array(source);
  }
  if (source.byteLength > WASM_TRANSCODE_MAX_BYTES) throw tooLargeError(source.byteLength);
  return source;
}

/**
 * Transcode media to a WebView-friendly container using bundled ffmpeg.wasm.
 * Video → video/webm (libvpx + libopus). Audio → audio/ogg (libopus).
 * Serialized on one FFmpeg core. Abort during exec terminates the worker.
 */
export async function transcodeWithWasm(
  source: Blob | ArrayBuffer | Uint8Array | string,
  sourceMime: string,
  kind: "video" | "audio",
  signal?: AbortSignal
): Promise<{ blob: Blob; mime: string }> {
  if (signal?.aborted) throw abortError();
  const input = await loadInputBytes(source, signal);

  return enqueue(async () => {
    if (signal?.aborted) throw abortError();
    const ff = await getFFmpeg();
    if (signal?.aborted) throw abortError();

    const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const inName = `in_${id}.${extForMime(sourceMime, kind)}`;
    const outName = kind === "audio" ? `out_${id}.ogg` : `out_${id}.webm`;
    const outMime = kind === "audio" ? "audio/ogg" : "video/webm";

    const onAbort = (): void => {
      terminateActiveCore();
    };
    signal?.addEventListener("abort", onAbort);

    activeCore = ff;
    try {
      await ff.writeFile(inName, input);
      if (signal?.aborted) throw abortError();

      const args =
        kind === "audio"
          ? ["-i", inName, "-vn", "-c:a", "libopus", "-b:a", "96k", outName]
          : [
              "-i",
              inName,
              "-c:v",
              "libvpx",
              "-b:v",
              "1M",
              "-crf",
              "32",
              "-c:a",
              "libopus",
              "-b:a",
              "96k",
              outName,
            ];
      const code = await ff.exec(args);
      if (signal?.aborted) throw abortError();
      // terminate() may leave singleton cleared while this ff is dead.
      if (ffmpegSingleton !== ff) throw abortError();
      if (code !== 0) {
        throw new Error(`ffmpeg.wasm exited with code ${code}`);
      }
      const data = await ff.readFile(outName);
      if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error("ffmpeg.wasm produced empty output");
      }
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      return { blob: new Blob([copy], { type: outMime }), mime: outMime };
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (activeCore === ff) {
        activeCore = null;
      }
      // Best-effort cleanup only if this core is still alive.
      if (ffmpegSingleton === ff) {
        try {
          await ff.deleteFile(inName);
        } catch {
          /* ignore */
        }
        try {
          await ff.deleteFile(outName);
        } catch {
          /* ignore */
        }
      }
    }
  });
}
