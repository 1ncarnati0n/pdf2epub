<script lang="ts">
  import type { Page } from './epub'
  import { render, type Doc } from './pdf'

  let { doc, pages, current, onpick }: { doc: Doc, pages: Page[], current: number, onpick: (n: number) => void } = $props()

  let urls = $state<Record<number, string>>({})
  let listEl = $state<HTMLElement>()

  // 보이는 썸네일만 렌더 (문서가 바뀌면 캐시 초기화)
  $effect(() => {
    const d = doc
    urls = {}
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset.n)
        if (!e.isIntersecting || urls[n]) continue
        io.unobserve(e.target)
        render(d, n, 0.25).then(c => (urls[n] = c.toDataURL('image/jpeg', 0.7)))
      }
    }, { root: listEl, rootMargin: '300px' })
    listEl!.querySelectorAll('[data-n]').forEach(el => io.observe(el))
    return () => io.disconnect()
  })

  $effect(() => {
    listEl?.querySelector(`[data-n="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  })
</script>

<aside class="thumbs" bind:this={listEl}>
  {#each pages as p (p.n)}
    <button data-n={p.n} class:cur={p.n === current} onclick={() => onpick(p.n)} title={p.error || `${p.n}쪽 · ${p.status}`}>
      {#if urls[p.n]}<img src={urls[p.n]} alt="" />{:else}<div class="ph"></div>{/if}
      <span><i class="dot {p.status}"></i>{p.n}</span>
    </button>
  {/each}
</aside>

<style>
  .thumbs { overflow-y: auto; padding: 0.4rem 0.8rem 2rem; background: var(--paper-dim); display: flex; flex-direction: column; gap: 6px; }
  button, button:hover:not(:disabled) { display: flex; flex-direction: column; align-items: center; gap: 3px; border: 0; border-left: 2px solid transparent; background: none; padding: 6px 4px; color: var(--muted); font-size: 0.72rem; }
  button:hover:not(:disabled) { background: var(--paper); }
  button.cur { background: var(--paper); border-left-color: var(--sealed); color: var(--ink); }
  img, .ph { width: 96px; box-shadow: 0 1px 4px -1px rgb(0 0 0 / 30%); background: #fff; }
  button.cur img { outline: 1px solid var(--sealed); }
  .ph { aspect-ratio: 1 / 1.414; }
  span { display: flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
  .dot { width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--muted); }
  .dot.busy { border-color: var(--draft); background: var(--draft); } .dot.done { border-color: var(--sealed); background: var(--sealed); } .dot.error { border-color: var(--warn); background: var(--warn); }
</style>
