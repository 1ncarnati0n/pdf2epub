<script lang="ts" generics="T extends string">
  // epubeditor Segmented 이식 — 헤더 보기 전환·사이드바 탭·미리보기 흐름 토글 공용
  type Item = { key: T, label: string, count?: number, disabled?: boolean, title?: string }
  let { items, value, pick, label, size = 'normal' }: {
    items: Item[], value: T, pick: (key: T) => void, label: string, size?: 'normal' | 'small'
  } = $props()
</script>

<div class="seg" class:small={size === 'small'} role="group" aria-label={label}>
  {#each items as item (item.key)}
    <button class:on={value === item.key} aria-pressed={value === item.key} disabled={item.disabled} title={item.title}
      onclick={() => pick(item.key)}>
      {item.label}{#if item.count !== undefined}<em>{item.count}</em>{/if}
    </button>
  {/each}
</div>

<style>
  .seg { display: flex; flex-shrink: 0; border: 1px solid var(--line); background: var(--paper); }
  button { display: flex; align-items: center; justify-content: center; gap: 0.3rem; flex: 1; border: 0; padding: 0.35rem 0.6rem; color: var(--muted); font-size: 0.76rem; }
  .seg.small button { padding: 0.2rem 0.55rem; font-size: 0.74rem; }
  button + button { border-left: 1px solid var(--line); }
  button:hover:not(:disabled) { color: var(--ink); }
  button.on, button.on:hover:not(:disabled) { background: var(--ink); color: var(--paper); }
  em { font-style: normal; font-variant-numeric: tabular-nums; opacity: 0.65; }
</style>
