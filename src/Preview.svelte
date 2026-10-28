<script lang="ts">
  import { untrack } from 'svelte'
  import ePub, { type Book, type Rendition } from 'epubjs'
  import Segmented from './Segmented.svelte'

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
    // 스크롤은 continuous 매니저로 장을 이어 붙인다 (scrolled-doc 은 한 장만 보여서 앞 장이 그림뿐이면 글이 안 보임)
    const r = rendition = book!.renderTo(el!, {
      width: '100%', height: '100%', spread: 'none', allowScriptedContent: false,
      ...(flow === 'paginated' ? { flow } : { flow: 'scrolled', manager: 'continuous' }),
    })
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
    book = ePub(epub as any)
    untrack(() => mount(target))
    // ponytail: book.destroy() 는 안 부름. 렌더 중인 장의 훅이 지워진 book.packaging 을 읽다 TypeError — 참조만 끊고 GC 에 맡김
    return () => { rendition?.destroy(); rendition = null; book = null }
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
    <Segmented size="small" label="넘김 방식" value={flow} pick={setFlow}
      items={[{ key: 'scrolled-doc', label: '스크롤' }, { key: 'paginated', label: '페이지' }]} />
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
  .pv { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .tools { display: flex; gap: 6px; align-items: center; padding: 0.4rem 1.1rem; border-bottom: 1px solid var(--line); font-size: 0.75rem; }
  .tools button { padding: 0.15rem 0.5rem; }
  .reader { flex: 1; min-height: 0; background: #fff; padding: 0 16px; }
</style>
