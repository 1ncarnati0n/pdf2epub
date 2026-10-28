<script lang="ts">
  import Segmented from './Segmented.svelte'
  import Thumbs from './Thumbs.svelte'
  import { plain, type Block, type Project } from './epub'
  import type { Doc } from './pdf'

  export type Issue = { n: number, block: Block, msg: string }

  let { doc, project, pageN, selected, issues, fixingAll, onpage, onblock, onfixall }: {
    doc: Doc, project: Project, pageN: number, selected: string | null, issues: Issue[], fixingAll: boolean,
    onpage: (n: number) => void, onblock: (n: number, id: string) => void, onfixall: () => void
  } = $props()

  let tab = $state<'pages' | 'toc' | 'issues'>('pages')
  const toc = $derived(project.pages.flatMap(pg => pg.blocks.filter(b => b.type === 'heading').map(b => ({ n: pg.n, b }))))
  // 현재 쪽이 속한 제목 = 현재 쪽 이하의 마지막 제목
  const curHead = $derived(toc.findLast(t => t.n <= pageN)?.b.id)
</script>

<aside>
  <div class="tabs">
    <Segmented size="small" label="왼쪽 패널" value={tab} pick={k => (tab = k)}
      items={[{ key: 'pages', label: '페이지' }, { key: 'toc', label: '목차' }, { key: 'issues', label: '오류', count: issues.length }]} />
  </div>

  {#if tab === 'pages'}
    <Thumbs {doc} pages={project.pages} current={pageN} onpick={onpage} />
  {:else if tab === 'toc'}
    <ol class="list">
      {#each toc as t (t.b.id)}
        <li class="lv{t.b.level}" class:cur={t.b.id === curHead || t.b.id === selected}>
          <button onclick={() => onblock(t.n, t.b.id)}><span>{plain(t.b.text) || '(제목 없음)'}</span><small>{t.n}</small></button>
        </li>
      {:else}
        <li class="muted pad">인식된 제목이 없습니다.</li>
      {/each}
    </ol>
  {:else}
    <div class="pad row">
      <span class="muted">LaTeX 오류 {issues.length}개</span>
      <button class="ai" onclick={onfixall} disabled={!issues.length || fixingAll}>{fixingAll ? '재작성 중…' : '✦ 모두 AI 재작성'}</button>
    </div>
    <ol class="list">
      {#each issues as it (it.block.id)}
        <li class:cur={it.block.id === selected}>
          <button onclick={() => onblock(it.n, it.block.id)} title={it.msg}>
            <span><b>{it.block.type}</b> {it.msg.split('\n')[0]}</span><small>{it.n}</small>
          </button>
        </li>
      {:else}
        <li class="muted pad">오류가 없습니다 ✓</li>
      {/each}
    </ol>
  {/if}
</aside>

<style>
  /* epubeditor ChapterNav: 종이 바랜 배경, 현재 항목은 왼쪽 쪽빛 선 */
  aside { display: flex; flex-direction: column; min-height: 0; background: var(--paper-dim); border-right: 1px solid var(--line); }
  aside > :global(.thumbs) { flex: 1; border-right: 0; }
  .tabs { padding: 0.7rem 0.8rem 0.5rem; }
  .tabs :global(.seg) { width: 100%; }
  .list { list-style: none; margin: 0; padding: 0 0 2rem; overflow-y: auto; flex: 1; }
  .list button, .list button:hover:not(:disabled) { box-sizing: border-box; width: 100%; display: flex; gap: 6px; border: 0; border-left: 2px solid transparent; background: none; padding: 0.45rem 1rem 0.45rem 0.8rem; color: var(--ink); font-size: 0.8rem; text-align: left; white-space: normal; }
  .list button span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list button small { color: var(--muted); font-size: 0.7rem; font-variant-numeric: tabular-nums; }
  .list button:hover:not(:disabled) { background: var(--paper); }
  .list li.cur button { background: var(--paper); border-left-color: var(--sealed); }
  .lv1 button { font-weight: 700; } .lv2 button { padding-left: 1.6rem !important; } .lv3 button { padding-left: 2.4rem !important; color: var(--muted) !important; }
  .pad { padding: 0.6rem 1rem; font-size: 0.75rem; } .row { display: flex; align-items: center; gap: 6px; justify-content: space-between; } .row span { white-space: nowrap; }
</style>
