import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { blockHtml, buildEpub, chapters, errors, inline, type Project } from './src/epub.ts'

test('inline math → MathML, text escaped', () => {
  const h = inline('if \\(a<b\\) & \\(\\frac{1}{2}\\)')
  assert.match(h, /^if <math .*<\/math> &amp; <math/)
  assert.ok(h.includes('<annotation encoding="application/x-tex">a&lt;b</annotation>'))
})

test('latex errors are reported', () => {
  const b = { id: 'x', type: 'math', text: '\\frac{a', level: 0, ordered: false, bbox: [0, 0, 0, 0] } as const
  assert.equal(errors({ ...b }).length, 1)
  assert.match(blockHtml({ ...b }, () => ''), /math-error/)
  assert.equal(errors({ ...b, type: 'paragraph', text: 'ok \\(x^2\\)' }).length, 0)
})

test('epub: mimetype first & stored, mathml property, chapters by h1', async () => {
  const blk = (type: any, text: string, level = 0) => ({ id: Math.random().toString(36).slice(2), type, text, level, ordered: false, bbox: [0, 0, 1, 1] })
  const p: Project = {
    id: 't', title: 'T', author: 'A', lang: 'ko', model: 'm', notation: '',
    pages: [{ n: 1, status: 'done', blocks: [blk('heading', '1장', 1), blk('paragraph', '식 \\(e^{i\\pi}+1=0\\)')] },
            { n: 2, status: 'done', blocks: [blk('heading', '2장', 1), blk('math', '\\int_0^1 x\\,dx')] }],
  }
  assert.equal(chapters(p).length, 2)
  const zip = await buildEpub(p, async () => new Uint8Array())
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  assert.equal(buf.subarray(30, 38).toString(), 'mimetype')
  assert.equal(buf.readUInt16LE(8), 0) // STORE
  const opf = await (await JSZip.loadAsync(buf)).file('OEBPS/content.opf')!.async('string')
  assert.equal(opf.match(/properties="mathml"/g)?.length, 2)
})

test('nested list / contents by 2-space indent', async () => {
  const { nested } = await import('./src/epub.ts')
  assert.equal(nested('1 A\n  1.1 B\n  1.2 C\n2 D', 'ul', 'id="x"'),
    '<ul id="x"><li>1 A<ul><li>1.1 B</li><li>1.2 C</li></ul></li><li>2 D</li></ul>')
  assert.equal(nested('A\n    deep\nB', 'ul', ''), '<ul ><li>A<ul><li>deep</li></ul></li><li>B</li></ul>')
  assert.equal(nested('A\n  B\n    C', 'ol', ''), '<ol ><li>A<ol><li>B<ol><li>C</li></ol></li></ol></li></ol>')
  assert.equal(nested('  \n', 'ul', ''), '')
})

test('style tags whitelisted, others escaped', () => {
  assert.equal(inline('<b>굵게</b> <span style="color:#c0392b">빨강</span> <span class="sans">고딕</span>'),
    '<b>굵게</b> <span style="color:#c0392b">빨강</span> <span class="sans">고딕</span>')
  assert.equal(inline('<img src=x onerror=alert(1)> <span style="background:red">x</span>'),
    '&lt;img src=x onerror=alert(1)&gt; &lt;span style=&quot;background:red&quot;&gt;x</span>')
  assert.match(inline('<i>a</i> \\(x<y\\)'), /^<i>a<\/i> <math/)
})
