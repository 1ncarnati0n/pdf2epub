<script lang="ts">
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
    <button class:on={tab === 'pages'} onclick={() => (tab = 'pages')}>페이지</button>
    <button class:on={tab === 'toc'} onclick={() => (tab = 'toc')}>목차</button>
    <button class:on={tab === 'issues'} onclick={() => (tab = 'issues')}>
      오류 {#if issues.length}<b class="badge">{issues.length}</b>{/if}
    </button>
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
  aside { display: flex; flex-direction: column; min-height: 0; background: var(--panel); border-right: 1px solid var(--line); }
  aside > :global(.thumbs) { flex: 1; border-right: 0; }
  .tabs { display: flex; border-bottom: 1px solid var(--line); }
  .tabs button { all: unset; flex: 1; text-align: center; padding: 7px 0; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; font-size: 12px; }
  .tabs button.on { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
  .badge { background: var(--err); color: #fff; border-radius: 8px; padding: 0 5px; font-size: 10px; }
  .list { list-style: none; margin: 0; padding: 4px; overflow-y: auto; flex: 1; }
  .list button { all: unset; box-sizing: border-box; width: 100%; display: flex; gap: 6px; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .list button span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list button small { color: var(--muted); }
  .list button:hover { background: var(--hover); }
  .list li.cur button { background: var(--accent-soft); }
  .lv1 button { font-weight: 600; } .lv2 button { padding-left: 16px; } .lv3 button { padding-left: 28px; color: var(--muted); }
  .pad { padding: 8px 10px; } .row span { white-space: nowrap; font-size: 12px; } .row { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
</style>
