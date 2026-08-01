import {
  scaleRegionForRendering,
  type CanvasScaleRendering,
  type ScaleRegion,
} from "./upscale";

interface UpscaleWorkerRequest {
  id: number;
  url: string;
  rendering: CanvasScaleRendering;
  region: ScaleRegion;
  destWidth: number;
  destHeight: number;
}

type UpscaleWorkerResponse =
  | { id: number; bitmap: ImageBitmap }
  | { id: number; error: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<UpscaleWorkerRequest>) => void) | null;
  postMessage: (message: UpscaleWorkerResponse, transfer?: Transferable[]) => void;
};

workerScope.onmessage = (event): void => {
  void render(event.data);
};

async function render(request: UpscaleWorkerRequest): Promise<void> {
  let sourceBitmap: ImageBitmap | null = null;
  try {
    const response = await fetch(request.url);
    if (!response.ok) throw new Error(`image fetch failed (${response.status})`);
    sourceBitmap = await createImageBitmap(await response.blob());

    const sourceCanvas = new OffscreenCanvas(sourceBitmap.width, sourceBitmap.height);
    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) throw new Error("2D worker canvas unavailable");
    sourceContext.drawImage(sourceBitmap, 0, 0);
    const pixels = sourceContext.getImageData(
      0,
      0,
      sourceBitmap.width,
      sourceBitmap.height
    );
    const scaled = scaleRegionForRendering(
      request.rendering,
      pixels,
      request.region,
      request.destWidth,
      request.destHeight
    );

    const outputCanvas = new OffscreenCanvas(request.destWidth, request.destHeight);
    const outputContext = outputCanvas.getContext("2d");
    if (!outputContext) throw new Error("2D output canvas unavailable");
    outputContext.putImageData(scaled, 0, 0);
    const bitmap = outputCanvas.transferToImageBitmap();
    workerScope.postMessage({ id: request.id, bitmap }, [bitmap]);
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    sourceBitmap?.close();
  }
}
