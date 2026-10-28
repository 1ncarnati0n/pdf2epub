<script lang="ts">
  import { untrack } from 'svelte'
  import ePub, { type Book, type Rendition } from 'epubjs'

  // epub: buildEpub 결과(내보내기와 동일), target: 보여줄 위치(chNNN.xhtml#b-id). target 이 바뀌면 그 위치로 이동
  let { epub, target }: { epub: ArrayBuffer, target?: string } = $props()

  let el = $state<HTMLElement>()
  let flow = $state<'paginated' | 'scrolled-doc'>(localStorage.flow === 'paginated' ? 'paginated' : 'scrolled-doc')
  let font = $state(Number(localStorage.font) || 100)
  let where = $state('')
  let book: Book | null = null
  let rendition: Rendition | null = null
  let shown: string | undefined

  function mount(at?: string) {
    shown = at
    rendition?.destroy()
    el!.innerHTML = ''
    const r = rendition = book!.renderTo(el!, { width: '100%', height: '100%', flow, spread: 'none', allowScriptedContent: false })
    r.themes.fontSize(font + '%')
    r.themes.default({ '.math-error': { color: '#d33' }, '.pdf2epub-hit': { background: '#fff3a0', transition: 'background .6s' } })
    r.on('relocated', (loc: any) => {
      const d = loc.start.displayed
      where = `${loc.start.href} · ${d.page}/${d.total}`
    })
    r.display(at).then(() => flash(at)).catch(() => r.display())
  }

  // 이동한 블록을 잠깐 강조
  function flash(at?: string) {
    const id = at?.split('#')[1]
    if (!id) return
    for (const c of (rendition as any)?.getContents?.() ?? []) {
      const e = c.document.getElementById(id)
      if (!e) continue
      e.classList.add('pdf2epub-hit')
      setTimeout(() => e.classList.remove('pdf2epub-hit'), 900)
    }
  }

  // 새 빌드: 책을 다시 열고 현재 target 위치에서 시작
  $effect(() => {
    const b = book = ePub(epub as any)
    untrack(() => mount(target))
    return () => { rendition?.destroy(); rendition = null; b.destroy() }
  })

  // 위치만 바뀜
  $effect(() => {
    const t = target
    if (t && t !== shown) untrack(() => (shown = t))
    else return
    untrack(() => rendition?.display(t).then(() => flash(t)).catch(() => {}))
  })

  function setFlow(f: typeof flow) {
    const cfi = (rendition?.currentLocation() as any)?.start?.cfi
    flow = localStorage.flow = f
    mount(cfi)
  }
  function zoom(d: number) {
    font = Math.min(200, Math.max(60, font + d))
    localStorage.font = font
    rendition?.themes.fontSize(font + '%')
  }
</script>

<div class="pv">
  <div class="tools">
    <div class="seg">
      <button class:on={flow === 'scrolled-doc'} onclick={() => setFlow('scrolled-doc')} title="스크롤">☰ 스크롤</button>
      <button class:on={flow === 'paginated'} onclick={() => setFlow('paginated')} title="페이지">▤ 페이지</button>
    </div>
    <button onclick={() => zoom(-10)} title="글자 작게">A−</button>
    <span class="muted">{font}%</span>
    <button onclick={() => zoom(10)} title="글자 크게">A+</button>
    <span class="grow"></span>
    <span class="muted">{where}</span>
    <button onclick={() => rendition?.prev()} title="이전">‹</button>
    <button onclick={() => rendition?.next()} title="다음">›</button>
  </div>
  <div class="reader" bind:this={el}></div>
</div>

<style>
  .pv { display: flex; flex-direction: column; height: 100%; }
  .tools { display: flex; gap: 4px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); background: var(--bg); }
  .reader { flex: 1; min-height: 0; background: #fff; padding: 0 16px; }
  .seg { display: flex; }
  .seg button { border-radius: 0; } .seg button:first-child { border-radius: 5px 0 0 5px; } .seg button:last-child { border-radius: 0 5px 5px 0; border-left: 0; }
  .seg button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
</style>
