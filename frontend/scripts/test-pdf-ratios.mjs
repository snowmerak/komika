import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// Fixture smoke: multi-page PDF viewports must be readable for webtoon ratio priming.
// Production code path: frontend/src/pdf_render.ts getPdfPageRatios().
const data = new Uint8Array(
  await readFile(new URL("../../testdata/docs-fixture/sample.pdf", import.meta.url))
);
const document = await pdfjs.getDocument({ data }).promise;

assert.equal(document.numPages, 3, "fixture must cover a multi-page PDF");
for (let pageNum = 1; pageNum <= document.numPages; pageNum++) {
  const page = await document.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const ratio = viewport.width / viewport.height;
  assert.ok(Number.isFinite(ratio) && ratio > 0, `page ${pageNum} must have a usable viewport ratio`);
}

console.log(`test-pdf-ratios: ${document.numPages} page ratios verified`);
