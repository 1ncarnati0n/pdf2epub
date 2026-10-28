// 블록 → XHTML(미리보기·내보내기 공용) 과 EPUB3 패키징
import temml from 'temml'
import JSZip from 'jszip'

export type BlockType = 'heading' | 'paragraph' | 'math' | 'figure' | 'table' | 'list' | 'contents' | 'footnote'
export type Block = {
  id: string, type: BlockType, text: string, level: number, ordered: boolean, bbox: number[],
  // figure 전용 (클라이언트에서 크롭)
  src?: string, width?: number, format?: 'webp' | 'jpeg' | 'png', quality?: number, bytes?: number, v?: number
  prev?: string // AI 재작성 전 텍스트 (되돌리기용)
  // 블록 편집 스타일: style 은 BLOCK_CLS/BOX_CLS 어휘, tint 는 상자색 #RRGGBB, 같은 group 의 연속 블록은 한 상자
  style?: string[], tint?: string, group?: string
}
export type Page = { n: number, status: 'todo' | 'busy' | 'done' | 'error', error?: string, blocks: Block[] }
export type Project = { id: string, title: string, author: string, lang: string, model: string, notation: string, font?: string, indent?: boolean, pages: Page[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const INLINE = /\\\((.+?)\\\)/s

// ponytail: 무제한 메모. 수천 블록 책에서 키 입력마다 전체 오류 검사를 싸게 하려는 용도, 메모리 문제 생기면 LRU 로
const memo = new Map<string, { html: string, error?: string }>()
export function tex(latex: string, display = false): { html: string, error?: string } {
  const key = (display ? 'D' : 'I') + latex
  let r = memo.get(key)
  if (!r) {
    try {
      r = { html: temml.renderToString(latex, { displayMode: display, xml: true, annotate: true, throwOnError: true }) }
    } catch (e: any) {
      r = { html: `<code class="math-error">${esc(latex)}</code>`, error: e.message }
    }
    memo.set(key, r)
  }
  return r
}

// \( ... \) → MathML. raw=true 면 나머지(표 HTML)는 escape 하지 않음
// 본문에 허용하는 글자 스타일 태그 (나머지는 전부 escape)
const STYLE = /(<br ?\/?>|<\/?(?:b|strong|i|em|u|s|mark|sup|sub|code|small)>|<sup class="fn">|<span (?:style="(?:background-)?color: ?#[0-9a-fA-F]{3,8};?"|class="(?:sans|serif|mono|small|large)")>|<\/span>)/
// <br> 과 텍스트 안의 줄바꿈은 XHTML <br/> 로
const styled = (s: string) => s.split(STYLE).map((p, i) => i % 2 ? (p.startsWith('<br') ? '<br/>' : p) : esc(p).replace(/\n/g, '<br/>')).join('')
export const plain = (s: string) => s.replace(/\\\(|\\\)/g, '').replace(/<br ?\/?>|\n/g, ' ').replace(/<[^>]*>/g, '')

export function inline(text: string, raw = false) {
  return text.split(INLINE).map((part, i) => i % 2 ? tex(part).html : raw ? part : styled(part)).join('')
}

export function errors(b: Block): string[] {
  if (b.type === 'math') return [tex(b.text, true).error].filter(Boolean) as string[]
  if (b.type === 'figure') return []
  return b.text.split(INLINE).filter((_, i) => i % 2).map(p => tex(p).error).filter(Boolean) as string[]
}

// 줄 앞 공백 2칸 = 한 단계 하위 항목인 중첩 목록
export function nested(text: string, tag: string, attrs: string) {
  let out = '', cur = -1
  for (const line of text.split('\n').filter(s => s.trim())) {
    const d = Math.min(Math.floor(line.match(/^ */)![0].length / 2), cur + 1) // 한 번에 한 단계만 내려감
    if (d > cur) out += cur < 0 ? `<${tag} ${attrs}>` : `<${tag}>`
    else { out += '</li>'; for (; cur > d; cur--) out += `</${tag}></li>` }
    out += `<li>${inline(line.trim())}`
    cur = d
  }
  if (cur < 0) return ''
  out += '</li>'
  for (; cur > 0; cur--) out += `</${tag}></li>`
  return out + `</${tag}>`
}

export const BLOCK_CLS = ['center', 'right', 'quote', 'indent', 'noindent', 'small', 'large']
export const BOX_CLS = ['box', 'shade', 'rule']
// 기존 class(eq, table, contents) 와 합쳐 class 속성 하나로
const cls = (b: Block, base = '') => {
  const c = [base, ...(b.style ?? []).filter(s => BLOCK_CLS.includes(s))].filter(Boolean).join(' ')
  return c ? ` class="${c}"` : ''
}

// 모든 블록 요소에 id="b-<블록id>" → 미리보기/목차에서 블록 위치로 바로 이동
export function blockHtml(b: Block, img: (b: Block) => string): string {
  const id = `id="b-${b.id}"`
  switch (b.type) {
    case 'heading': { const l = Math.min(Math.max(b.level || 1, 1), 3); return `<h${l} ${id}${cls(b)}>${inline(b.text)}</h${l}>` }
    case 'paragraph': return `<p ${id}${cls(b)}>${inline(b.text)}</p>`
    case 'math': return `<div ${id}${cls(b, 'eq')}>${tex(b.text, true).html}</div>`
    case 'list': return nested(b.text, b.ordered ? 'ol' : 'ul', id + cls(b))
    case 'contents': return nested(b.text, 'ul', id + cls(b, 'contents'))
    case 'table': return `<div ${id}${cls(b, 'table')}>${inline(b.text, true)}</div>`
    case 'footnote': return `<aside epub:type="footnote" ${id}${cls(b, 'footnote')}>${inline(b.text)}</aside>`
    case 'figure':
      if (!b.src) return ''
      return `<figure ${id}${cls(b)}><img src="${img(b)}" alt="${esc(b.text || 'figure')}"/>${b.text ? `<figcaption>${inline(b.text)}</figcaption>` : ''}</figure>`
  }
}

// 상자 래퍼: 그룹 첫 블록의 box/shade/rule 과 tint 사용. tint 는 검증된 6자리 hex 만 (구형 리더용으로 rgba)
function boxOpen(b: Block) {
  const c = (b.style ?? []).filter(s => BOX_CLS.includes(s)).join(' ')
  const t = /^#[0-9a-f]{6}$/i.test(b.tint ?? '') ? b.tint! : ''
  const rgb = t && [1, 3, 5].map(i => parseInt(t.slice(i, i + 2), 16)).join(',')
  return `<div class="${c}"${t ? ` style="border-color:${t}${c.includes('shade') ? `;background-color:rgba(${rgb},.1)` : ''}"` : ''}>`
}

// 블록 묶음 → HTML: 같은 group 연속 블록을 상자 하나로, <sup class="fn">k</sup> 를 뒤따르는 같은 표시의 각주에 연결
// ponytail: 각주 짝은 넘겨받은 blocks(=장) 안에서만 찾음
export function blocksHtml(blocks: Block[], img: (b: Block) => string): string {
  const notes = blocks.flatMap((b, i) => b.type === 'footnote' ? [{ i, id: b.id, k: plain(b.text).trim().split(/\s/)[0].replace(/[.)]$/, '') }] : [])
  // 그룹 상자 모양은 그 그룹에서 상자 스타일을 가진 첫 블록 것. 아무도 없으면 상자 없음 (스타일 끄면 상자도 사라짐)
  const hasBox = (b: Block) => b.style?.some(s => BOX_CLS.includes(s))
  const leader = new Map<string, Block>()
  for (const b of blocks) if (b.group && hasBox(b) && !leader.has(b.group)) leader.set(b.group, b)
  let out = '', open = '', wrapped = false
  blocks.forEach((b, i) => {
    const h = blockHtml(b, img).replace(/<sup class="fn">([^<]*)<\/sup>/g, (_, k) => {
      const n = notes.find(n => n.i > i && esc(n.k) === k)
      return n ? `<sup><a epub:type="noteref" href="#b-${n.id}">${k}</a></sup>` : `<sup>${k}</sup>`
    })
    const key = b.group ? 'g' + b.group : hasBox(b) ? 'b' + b.id : ''
    if (key !== open) {
      if (wrapped) out += '</div>\n'
      const src = b.group ? leader.get(b.group) : hasBox(b) ? b : undefined
      if (src) out += boxOpen(src)
      open = key
      wrapped = !!src
    }
    out += h + '\n'
  })
  return out + (wrapped ? '</div>' : '')
}

// 인식 결과의 쪽 내 group 번호(1..) → 전역 유일 "<쪽>.<k>". 직전 쪽에서 이어지는 상자면 직전 group 재사용
export function regroup<T extends { group?: unknown }>(blocks: T[], n: number, prev: Block | undefined, continues: boolean): T[] {
  const first = Number(blocks[0]?.group) || 0
  for (const b of blocks) {
    const k = Number(b.group) || 0
    b.group = k > 0 ? (continues && k === first && prev?.group ? prev.group : `${n}.${k}`) : undefined
  }
  return blocks
}

// 브라우저: 모델이 만든 HTML 을 정리(스크립트/이벤트 속성 제거)하고 XHTML 로 직렬화
export function clean(html: string): string {
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach(e => e.remove())
  doc.querySelectorAll('*').forEach(e => [...e.attributes].forEach(a => {
    if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) e.removeAttribute(a.name)
  }))
  const s = new XMLSerializer()
  return [...doc.body.childNodes].map(n => s.serializeToString(n)).join('')
}

export const css = (p: Pick<Project, 'font' | 'indent'>) => `body{font-family:${p.font || 'serif'};line-height:1.6}
${p.indent ? 'p{text-indent:1em;margin:0}' : ''}
.center{text-align:center;text-indent:0}.right{text-align:right;text-indent:0}.noindent{text-indent:0}
.quote{margin-left:2em;margin-right:2em}.indent{margin-left:2em}
.small{font-size:.85em}.large{font-size:1.2em}
.box,.shade,.rule{margin:1em 0;padding:.5em 1em}
.box{border:1px solid #888;border-radius:4px}.shade{background-color:#f2f2f2}.rule{border-left:3px solid #888}
.footnote{display:block;font-size:.85em;border-top:1px solid #ccc;margin-top:1em;padding-top:.3em}
mark{background-color:#fff3a0}
.sans{font-family:sans-serif}.serif{font-family:serif}.mono,code{font-family:monospace}
.eq{margin:1em 0;text-align:center;overflow-x:auto}
.contents,.contents ul{list-style:none;padding-left:1.5em}.contents{padding-left:0}
math[display="block"]{display:block;margin:0 auto}
figure{margin:1em 0;text-align:center}figure img{max-width:100%}
figcaption{font-size:.9em}
table{border-collapse:collapse;margin:0 auto}td,th{border:1px solid #888;padding:.2em .5em}
.math-error{color:#c00}`

const MIME: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' }

// ponytail: 챕터는 level-1 제목 기준으로만 분할. 제목이 없으면 한 파일
const chFile = (i: number) => `ch${String(i + 1).padStart(3, '0')}.xhtml`

// EPUB 안에서 블록 위치 (chNNN.xhtml#b-id)
export function anchor(p: Project, blockId: string) {
  const i = chapters(p).findIndex(c => c.some(b => b.id === blockId))
  return i < 0 ? undefined : `${chFile(i)}#b-${blockId}`
}

export function chapters(p: Project): Block[][] {
  const out: Block[][] = [[]]
  for (const b of p.pages.flatMap(pg => pg.blocks)) {
    if (b.type === 'heading' && b.level === 1 && out.at(-1)!.length) out.push([])
    out.at(-1)!.push(b)
  }
  return out
}

const xhtml = (title: string, lang: string, body: string) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>${body}</body>
</html>`

export async function buildEpub(p: Project, image: (src: string) => Promise<ArrayBuffer | Uint8Array>) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  zip.file('OEBPS/style.css', css(p))

  const manifest: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
  ]
  const spine: string[] = []
  const toc: string[] = []

  for (const [i, blocks] of chapters(p).entries()) {
    const file = chFile(i)
    const body = clean(blocksHtml(blocks, b => `images/${b.src}`))
    const h = blocks.find(b => b.type === 'heading')
    zip.file(`OEBPS/${file}`, xhtml(h ? plain(h.text) : p.title, p.lang, body))
    manifest.push(`<item id="c${i}" href="${file}" media-type="application/xhtml+xml"${body.includes('<math') ? ' properties="mathml"' : ''}/>`)
    spine.push(`<itemref idref="c${i}"/>`)
    for (const b of blocks) if (b.type === 'heading' && b.level <= 2)
      toc.push(`<li><a href="${file}#b-${b.id}">${esc(plain(b.text))}</a></li>`)
    for (const b of blocks) if (b.type === 'figure' && b.src) {
      zip.file(`OEBPS/images/${b.src}`, await image(b.src))
      manifest.push(`<item id="img-${b.id}" href="images/${b.src}" media-type="${MIME[b.src.split('.').pop()!]}"/>`)
    }
  }
  if (!toc.length) toc.push(`<li><a href="ch001.xhtml">${esc(p.title)}</a></li>`)

  zip.file('OEBPS/nav.xhtml', xhtml(p.title, p.lang, `<nav epub:type="toc" id="toc"><h1>목차</h1><ol>${toc.join('')}</ol></nav>`))
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${p.lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:pdf2epub:${p.id}</dc:identifier>
<dc:title>${esc(p.title)}</dc:title>
<dc:language>${p.lang}</dc:language>
${p.author ? `<dc:creator>${esc(p.author)}</dc:creator>` : ''}
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>${manifest.join('\n')}</manifest>
<spine>${spine.join('')}</spine>
</package>`)
  return zip
}
