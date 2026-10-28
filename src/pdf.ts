import * as pdfjs from 'pdfjs-dist'
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = worker
export type Doc = pdfjs.PDFDocumentProxy

// wasmUrl: server.ts 가 pdfjs-dist/wasm 을 서빙 (워커가 쓰므로 절대 URL)
export const openPdf = (data: ArrayBuffer) => pdfjs.getDocument({ data, wasmUrl: new URL('/api/pdfjs-wasm/', location.href).href }).promise

export async function render(doc: Doc, n: number, scale: number, canvas = document.createElement('canvas')) {
  const page = await doc.getPage(n)
  const viewport = page.getViewport({ scale })
  canvas.width = viewport.width
  canvas.height = viewport.height
  await page.render({ canvas, viewport }).promise
  return canvas
}

export async function pageText(doc: Doc, n: number) {
  const { items } = await (await doc.getPage(n)).getTextContent()
  return items.map((i: any) => (i.str ?? '') + (i.hasEOL ? '\n' : '')).join('')
}

export const toBlob = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((ok, fail) => c.toBlob(b => b ? ok(b) : fail(new Error('toBlob 실패')), type, quality))

// bbox(0~1) 영역을 잘라 width(px) 이하로 축소 후 인코딩. 확대는 하지 않음
export function crop(src: HTMLCanvasElement, bbox: number[], width: number, format: string, quality: number) {
  const [x, y, w, h] = bbox.map((v, i) => v * (i % 2 ? src.height : src.width))
  const s = width > 0 ? Math.min(1, width / w) : 1
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(w * s))
  out.height = Math.max(1, Math.round(h * s))
  const ctx = out.getContext('2d')!
  ctx.fillStyle = '#fff' // jpeg 투명 영역 검게 나오는 것 방지
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(src, x, y, w, h, 0, 0, out.width, out.height)
  return toBlob(out, `image/${format}`, quality)
}
