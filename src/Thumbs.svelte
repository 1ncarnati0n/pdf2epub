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
  .thumbs { overflow-y: auto; padding: 8px; background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  button { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; border-radius: 6px; font-size: 12px; color: var(--muted); }
  button:hover { background: var(--hover); }
  button.cur { background: var(--accent-soft); color: var(--fg); font-weight: 600; }
  img, .ph { width: 96px; box-shadow: 0 1px 3px #0003; background: #fff; }
  .ph { aspect-ratio: 1 / 1.414; }
  span { display: flex; align-items: center; gap: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #bbb; }
  .dot.busy { background: #e6b800; } .dot.done { background: #2a2; } .dot.error { background: #d33; }
</style>
