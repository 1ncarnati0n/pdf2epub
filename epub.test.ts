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

test('block styles: one class attr, whitelist, boxes by group, tint validated', async () => {
  const { blocksHtml } = await import('./src/epub.ts')
  const b = (id: string, extra: object, type = 'paragraph', text = id) => ({ id, type, text, level: 0, ordered: false, bbox: [0, 0, 0, 0], ...extra }) as any
  const m = blockHtml(b('m', { style: ['center', 'evil"x'] }, 'math', 'x'), () => '')
  assert.equal(m.match(/^<div [^>]*>/)![0].match(/class=/g)?.length, 1)
  assert.match(m, /class="eq center"/)
  const h = blocksHtml([b('a', { style: ['box', 'shade'], tint: '#ff0000', group: '1.1' }), b('b', { group: '1.1' }), b('c', { group: '1.1' }), b('d', { style: ['rule'], group: '1.2', tint: 'red;x' }), b('e', {})], () => '')
  assert.equal(h.match(/<div class=/g)?.length, 2)
  assert.match(h, /^<div class="box shade" style="border-color:#ff0000;background-color:rgba\(255,0,0,.1\)"><p id="b-a">a<\/p>\n<p id="b-b">b<\/p>\n<p id="b-c">c<\/p>\n<\/div>\n<div class="rule"><p id="b-d">d<\/p>\n<\/div>\n<p id="b-e">e<\/p>\n$/)
})

test('regroup: per-page group numbers become unique, continues joins previous box', async () => {
  const { regroup } = await import('./src/epub.ts')
  const p1 = regroup([{ group: 1 }, { group: 1 }, { group: 0 }], 3, undefined, false)
  assert.deepEqual(p1.map(b => b.group), ['3.1', '3.1', undefined])
  const prev = { group: '3.1' } as any
  assert.deepEqual(regroup([{ group: 1 }, { group: 2 }], 4, prev, false).map(b => b.group), ['4.1', '4.2'])
  assert.deepEqual(regroup([{ group: 1 }, { group: 2 }], 4, prev, true).map(b => b.group), ['3.1', '4.2'])
})

test('footnotes: ref links to the next footnote with the same marker', async () => {
  const { blocksHtml } = await import('./src/epub.ts')
  const b = (id: string, type: string, text: string) => ({ id, type, text, level: 0, ordered: false, bbox: [0, 0, 0, 0] }) as any
  const h = blocksHtml([b('p1', 'paragraph', 'a<sup class="fn">1</sup>'), b('f1', 'footnote', '1 one'),
    b('p2', 'paragraph', 'b<sup class="fn">1</sup> c<sup class="fn">9</sup>'), b('f2', 'footnote', '1 two')], () => '')
  assert.match(h, /a<sup><a epub:type="noteref" href="#b-f1">1<\/a><\/sup>/)
  assert.match(h, /b<sup><a epub:type="noteref" href="#b-f2">1<\/a><\/sup> c<sup>9<\/sup>/)
  assert.match(h, /<aside epub:type="footnote" id="b-f1" class="footnote">1 one<\/aside>/)
})

test('inline mark/s/background allowed, other styles escaped', () => {
  assert.equal(inline('<mark>m</mark><s>s</s><span style="background-color:#ffee00">h</span><span class="small">x</span>'),
    '<mark>m</mark><s>s</s><span style="background-color:#ffee00">h</span><span class="small">x</span>')
  assert.match(inline('<span style="font-size:9px">x</span>'), /^&lt;span/)
})

test('boxes: no box style in group → no wrapper; split box keeps leader look', async () => {
  const { blocksHtml } = await import('./src/epub.ts')
  const b = (id: string, extra: object) => ({ id, type: 'paragraph', text: id, level: 0, ordered: false, bbox: [0, 0, 0, 0], ...extra }) as any
  assert.equal(blocksHtml([b('a', { group: 'g' }), b('b', { group: 'g' })], () => ''), '<p id="b-a">a</p>\n<p id="b-b">b</p>\n')
  const h = blocksHtml([b('a', { group: 'g', style: ['shade'], tint: '#00ff00' }), b('x', {}), b('c', { group: 'g' })], () => '')
  assert.equal(h.match(/<div class="shade" style="border-color:#00ff00;background-color:rgba\(0,255,0,.1\)">/g)?.length, 2)
  assert.equal(h.match(/<\/div>/g)?.length, 2)
})

test('<br> and newlines become <br/>, plain() turns them into spaces', async () => {
  const { plain } = await import('./src/epub.ts')
  assert.equal(inline('<b>A<br>B</b> C<br/>D<br />E\nF'), '<b>A<br/>B</b> C<br/>D<br/>E<br/>F')
  assert.equal(inline('<br onclick=x>'), '&lt;br onclick=x&gt;')
  assert.equal(plain('<span style="color:#207CC3">Linear Algebra<br>Step by Step</span>'), 'Linear Algebra Step by Step')
})
