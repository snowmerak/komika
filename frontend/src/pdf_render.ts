import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const pdfDocCache = new Map<string, Promise<PDFDocumentProxy>>();

export function getPdfDocument(cacheKey: string, url: string): Promise<PDFDocumentProxy> {
  let p = pdfDocCache.get(cacheKey);
  if (!p) {
    p = pdfjs.getDocument({ url }).promise;
    pdfDocCache.set(cacheKey, p);
  }
  return p;
}

export function clearPdfDocCache(): void {
  for (const p of pdfDocCache.values()) {
    void p.then(
      (doc) => {
        try {
          doc.destroy();
        } catch {
          // ignore destroy races
        }
      },
      () => undefined
    );
  }
  pdfDocCache.clear();
}

export type PdfAttachResult = {
  el: HTMLCanvasElement;
  cleanup: () => void;
};

/** Render one PDF page into a canvas under host. */
export async function attachPdfPage(
  host: HTMLElement,
  opts: {
    url: string;
    cacheKey: string;
    pageNum: number;
    className: string;
    mediaUrl: string;
    onSized: (size: { width: number; height: number }) => void;
  }
): Promise<PdfAttachResult> {
  const canvas = document.createElement("canvas");
  canvas.className = `${opts.className} reader__media reader__media--pdf`;
  canvas.dataset.mediaUrl = opts.mediaUrl;
  host.append(canvas);

  let disposed = false;
  let renderTask: RenderTask | null = null;

  try {
    const doc = await getPdfDocument(opts.cacheKey, opts.url);
    if (disposed) {
      return { el: canvas, cleanup: () => {} };
    }
    const page = await doc.getPage(opts.pageNum);
    if (disposed) {
      return { el: canvas, cleanup: () => {} };
    }
    const scale = 1.5;
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas 2d unavailable");
    }
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    renderTask = page.render({ canvasContext: ctx, viewport, canvas });
    await renderTask.promise;
    if (!disposed) {
      opts.onSized({ width: viewport.width, height: viewport.height });
    }
  } catch (err) {
    if (!disposed) {
      throw err;
    }
  }

  return {
    el: canvas,
    cleanup: () => {
      disposed = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
        renderTask = null;
      }
    },
  };
}
