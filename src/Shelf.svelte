<script lang="ts">
  // epubeditor BookShelf 이식: standalone = 프로젝트가 없을 때 첫 화면, dropdown = 헤더 제목에서 내려온 목록
  export type Entry = { id: string, title: string, author: string, pages: number, done: number, updatedAt: number, bytes: number }

  let { list, current, mode = 'dropdown', onopen, onnew, ondelete }: {
    list: Entry[], current?: string, mode?: 'dropdown' | 'standalone',
    onopen: (id: string) => Promise<void>, onnew: (file: File) => Promise<void>, ondelete: (id: string) => Promise<void>
  } = $props()

  let busy = $state(false)
  let notice = $state('')
  let confirming = $state<string | null>(null)
  let over = $state(false)

  async function act(action: () => Promise<void>) {
    busy = true
    notice = ''
    try { await action() } catch (e: any) { notice = e.message } finally { busy = false }
  }

  function file(files?: FileList | null) {
    const f = files?.[0]
    if (!f) return
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { notice = 'PDF 파일만 열 수 있습니다'; return }
    act(() => onnew(f))
  }

  function when(at: number) {
    const days = Math.floor((Date.now() - at) / 86_400_000)
    return days >= 1 ? `${days}일 전` : new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`
</script>

<div class="shelf" class:standalone={mode === 'standalone'}>
  {#if mode === 'standalone'}
    <div class="mark" aria-hidden="true">PDF<span>→</span>EPUB</div>
  {/if}

  {#if list.length}
    <div class="label">{mode === 'standalone' ? '하던 작업' : '책장'}</div>
    <ul>
      {#each list as p (p.id)}
        <li class:active={p.id === current}>
          <button class="pick" disabled={busy || p.id === current} onclick={() => act(() => onopen(p.id))}>
            <span class="title">{p.title}</span>
            <span class="meta">{[p.author, `인식 ${p.done}/${p.pages}쪽`, when(p.updatedAt), p.bytes && mb(p.bytes)].filter(Boolean).join(' · ')}</span>
            {#if p.pages}<span class="bar" aria-hidden="true"><i style:width="{(p.done / p.pages) * 100}%"></i></span>{/if}
          </button>
          {#if p.id === current}
            <span class="now">보는 중</span>
          {:else if confirming === p.id}
            <button class="del yes" disabled={busy} onclick={() => act(async () => { confirming = null; await ondelete(p.id) })}>정말 지우기</button>
            <button class="del" onclick={() => (confirming = null)}>취소</button>
          {:else}
            <button class="del" title="PDF·인식 결과·그림까지 지웁니다" onclick={() => (confirming = p.id)}>지우기</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <label class="open" class:busy class:over
    ondragover={e => { e.preventDefault(); over = true }} ondragleave={() => (over = false)}
    ondrop={e => { e.preventDefault(); over = false; file(e.dataTransfer?.files) }}>
    <span>{busy ? '여는 중…' : list.length ? '다른 PDF 열기' : 'PDF를 끌어다 놓거나 눌러서 열기'}</span>
    <input type="file" accept="application/pdf,.pdf" hidden disabled={busy} onchange={e => file(e.currentTarget.files)} />
  </label>

  {#if notice}<p class="notice">{notice}</p>{/if}
  {#if mode === 'standalone'}<p class="hint">인식에는 Codex CLI 로그인(<code>codex login</code>)이 필요합니다.</p>{/if}
</div>

<style>
  .shelf { background: var(--paper); padding: 0.9rem 1.1rem 1rem; }
  .shelf.standalone { width: min(620px, 100%); margin: 12vh auto 0; border: 1px solid var(--line); padding: 2.5rem 2rem 2rem; }
  .mark { margin-bottom: 1.6rem; color: var(--muted); font-family: var(--font-en); font-size: 1.5rem; letter-spacing: 0.1em; text-align: center; }
  .mark span { margin: 0 0.35rem; opacity: 0.5; }
  .label { margin-bottom: 0.6rem; color: var(--muted); font-size: 0.72rem; letter-spacing: 0.13em; }
  ul { max-height: 50vh; overflow-y: auto; margin: 0 0 0.9rem; padding: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 0.5rem; border-top: 1px solid var(--line); padding: 0.5rem 0; }
  li.active { background: color-mix(in srgb, var(--sealed) 4%, transparent); }
  .pick, .pick:hover:not(:disabled) { min-width: 0; flex: 1; border: 0; background: none; padding: 0; text-align: left; color: var(--ink); font-size: inherit; white-space: normal; }
  .pick:disabled { cursor: default; opacity: 1; }
  .pick:hover:not(:disabled) .title { color: var(--sealed); }
  .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-en); font-size: 0.95rem; }
  .meta { display: block; margin-top: 0.1rem; color: var(--muted); font-size: 0.72rem; }
  .bar { display: flex; height: 2px; margin-top: 0.35rem; background: var(--line); }
  .bar i { height: 100%; background: var(--sealed); }
  .now { flex-shrink: 0; color: var(--sealed); font-size: 0.7rem; }
  .del { flex-shrink: 0; padding: 0.2rem 0.5rem; font-size: 0.72rem; }
  .del:hover:not(:disabled), .del.yes { border-color: var(--warn); color: var(--warn); }
  .open { display: block; border: 1px dashed var(--line); padding: 0.7rem; color: var(--muted); font-size: 0.82rem; text-align: center; cursor: pointer; }
  .open:hover, .open.over { border-color: var(--sealed); color: var(--sealed); }
  .open.busy { cursor: progress; }
  .shelf.standalone .open { padding: 2rem; }
  .notice { margin: 0.7rem 0 0; color: var(--warn); font-size: 0.78rem; }
  .hint { margin: 1rem 0 0; color: var(--muted); font-size: 0.72rem; text-align: center; }
</style>
