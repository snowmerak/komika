import type { CanvasScaleRendering, ScaleRegion } from "./upscale";

interface WorkerRequest {
  id: number;
  url: string;
  rendering: CanvasScaleRendering;
  region: ScaleRegion;
  destWidth: number;
  destHeight: number;
}

type WorkerResponse =
  | { id: number; bitmap: ImageBitmap }
  | { id: number; error: string };

interface PendingRequest {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextRequestID = 1;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./upscale_worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>): void => {
    const result = event.data;
    const request = pending.get(result.id);
    if (!request) {
      if ("bitmap" in result) result.bitmap.close();
      return;
    }
    pending.delete(result.id);
    if ("error" in result) request.reject(new Error(result.error));
    else request.resolve(result.bitmap);
  };
  worker.onerror = (event): void => {
    const error = new Error(event.message || "upscale worker failed");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function renderUpscaleInWorker(input: Omit<WorkerRequest, "id">): Promise<ImageBitmap> {
  const id = nextRequestID++;
  return new Promise<ImageBitmap>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ id, ...input } satisfies WorkerRequest);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
