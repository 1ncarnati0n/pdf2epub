<script lang="ts">
  import { tick } from 'svelte'
  import { blockHtml, clean, errors, type Block } from './epub'

  export type Action = 'up' | 'down' | 'merge' | 'insert' | 'delete' | 'split'

  let { block = $bindable(), pid, selected, fixing, onselect, onhover, onaction, onrecrop, onfix }: {
    block: Block, pid: string, selected: boolean, fixing: boolean,
    onselect: () => void, onhover: (on: boolean) => void,
    onaction: (a: Action, pos?: number) => void, onrecrop: () => void, onfix: () => void
  } = $props()

  let ta = $state<HTMLTextAreaElement>()
  const errs = $derived(errors(block))
  const preview = $derived(clean(blockHtml(block, b => `/api/projects/${pid}/files/images/${b.src}?v=${b.v ?? 0}`)))
  const label = { heading: '제목', paragraph: '문단 (인라인 수식 \\( \\))', math: 'LaTeX', figure: '캡션', table: 'HTML', list: '항목 (한 줄에 하나, 하위 항목은 앞에 공백 2칸)', contents: '목차 항목 (한 줄에 하나, 하위는 공백 2칸 들여쓰기)' }

  // 선택 영역을 태그로 감싸기 (허용 태그는 epub.ts STYLE 참고)
  function wrap(open: string, close: string) {
    const t = ta!, [a, z] = [t.selectionStart, t.selectionEnd]
    block.text = block.text.slice(0, a) + open + block.text.slice(a, z) + close + block.text.slice(z)
    tick().then(() => { t.focus(); t.setSelectionRange(a + open.length, z + open.length) })
  }
  const STYLED = ['heading', 'paragraph', 'list', 'contents', 'table']

  // 표로 잘못 인식된 목차 → contents. 행마다 셀을 잇고 끝의 쪽번호는 버림, 번호의 점 개수로 들여쓰기
  function tableToContents() {
    const rows = new DOMParser().parseFromString(block.text, 'text/html').querySelectorAll('tr')
    block.text = [...rows].map(tr => {
      const cells = [...tr.cells].map(c => c.textContent!.trim()).filter(Boolean)
      if (cells.length > 1 && /^([0-9]+|[ivxlcdm]+)$/i.test(cells.at(-1)!)) cells.pop()
      const depth = (cells[0]?.match(/^\d+(\.\d+)*/)?.[0].split('.').length ?? 1) - 1
      return '  '.repeat(depth) + cells.join(' ')
    }).filter(s => s.trim()).join('\n')
    block.type = 'contents'
  }

  async function click(e: MouseEvent) {
    onselect()
    if ((e.target as HTMLElement).closest('button,select,input,textarea')) return
    await tick()
    ta?.focus()
  }

  function key(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Escape') ta?.blur()
    else if (mod && e.key === 'Enter') onaction(e.shiftKey ? 'split' : 'insert', ta!.selectionStart)
    else return
    e.preventDefault()
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="block {block.type}" class:selected class:err={errs.length} id="blk-{block.id}"
  onclick={click} onmouseenter={() => onhover(true)} onmouseleave={() => onhover(false)}>
  {#if selected}
    <div class="bar">
      <select bind:value={block.type}>
        {#each Object.keys(label) as t}<option value={t}>{t}</option>{/each}
      </select>
      {#if block.type === 'heading'}
        <select bind:value={block.level}><option value={1}>H1</option><option value={2}>H2</option><option value={3}>H3</option></select>
      {/if}
      {#if block.type === 'list'}<label><input type="checkbox" bind:checked={block.ordered} /> 번호</label>{/if}
      {#if block.type === 'table'}<button onclick={tableToContents} title="표로 인식된 목차를 목차 블록으로 변환 (쪽번호 제거)">⇄ 목차로 변환</button>{/if}
      {#if block.type !== 'figure'}
        <button class="ai" onclick={onfix} disabled={fixing} title="페이지 이미지를 다시 보고 이 블록을 다시 씁니다 (A)">✦ AI 다시 쓰기</button>
      {/if}
      <span class="grow"></span>
      <button title="위로 (Alt+↑)" onclick={() => onaction('up')}>↑</button>
      <button title="아래로 (Alt+↓)" onclick={() => onaction('down')}>↓</button>
      <button title="커서 위치에서 분할 (⌘⇧Enter)" onclick={() => onaction('split', ta?.selectionStart)}>분할</button>
      <button title="다음 블록과 병합" onclick={() => onaction('merge')}>병합</button>
      <button title="아래에 문단 추가 (⌘Enter)" onclick={() => onaction('insert')}>＋</button>
      <button title="삭제 (Delete)" onclick={() => onaction('delete')}>✕</button>
    </div>

    {#if STYLED.includes(block.type)}
      <div class="bar fmt">
        <button title="굵게" onclick={() => wrap('<b>', '</b>')}><b>B</b></button>
        <button title="기울임" onclick={() => wrap('<i>', '</i>')}><i>I</i></button>
        <button title="밑줄" onclick={() => wrap('<u>', '</u>')}><u>U</u></button>
        <button title="위첨자" onclick={() => wrap('<sup>', '</sup>')}>x²</button>
        <button title="아래첨자" onclick={() => wrap('<sub>', '</sub>')}>x₂</button>
        <button title="고정폭" onclick={() => wrap('<code>', '</code>')}>{'</>'}</button>
        <button title="산세리프(고딕)" onclick={() => wrap('<span class="sans">', '</span>')}>Aa 고딕</button>
        <button title="세리프(명조)" onclick={() => wrap('<span class="serif">', '</span>')}>Aa 명조</button>
        <label class="color" title="글자색"><input type="color" value="#c0392b" onchange={e => wrap(`<span style="color:${(e.target as HTMLInputElement).value}">`, '</span>')} /> 색</label>
        <button title="선택 영역의 스타일 태그 제거" onclick={() => {
          const t = ta!, [a, z] = [t.selectionStart, t.selectionEnd]
          block.text = block.text.slice(0, a) + block.text.slice(a, z).replace(/<\/?(b|strong|i|em|u|sup|sub|code|small|span)\b[^>]*>/g, '') + block.text.slice(z)
        }}>⌫ 스타일</button>
      </div>
    {/if}
    <textarea bind:this={ta} bind:value={block.text} onkeydown={key} placeholder={label[block.type]}
      rows={block.type === 'figure' ? 1 : Math.min(14, block.text.split('\n').length + 1)}></textarea>

    {#if block.type === 'figure'}
      <div class="bar">
        <label>폭 <input type="number" min="0" step="50" bind:value={block.width} onchange={onrecrop} style="width:5em" />px</label>
        <select bind:value={block.format} onchange={onrecrop}>
          <option value="webp">webp</option><option value="jpeg">jpeg</option><option value="png">png</option>
        </select>
        {#if block.format !== 'png'}
          <label>품질 <input type="range" min="0.3" max="1" step="0.05" bind:value={block.quality} onchange={onrecrop} /> {block.quality}</label>
        {/if}
        <button onclick={onrecrop}>다시 자르기</button>
        {#if block.bytes}<span class="muted">{(block.bytes / 1024).toFixed(0)} KB</span>{/if}
      </div>
      <small class="muted">왼쪽 PDF 위를 드래그하면 그림 영역을 다시 지정합니다.</small>
    {/if}

  {:else}
    <span class="tag">{block.type === 'heading' ? 'H' + block.level : block.type}</span>
  {/if}
  {#if errs.length || fixing || block.prev != null}
    <div class="fix">
      {#if errs.length}<span class="errmsg" title={errs.join('\n')}>⚠ {errs[0].split('\n')[0]}</span>{/if}
      <span class="grow"></span>
      {#if errs.length || fixing}
        <button class="ai" onclick={onfix} disabled={fixing} title="페이지 이미지를 다시 보고 LaTeX 를 다른 방식으로 고쳐 씁니다">
          {fixing ? '재작성 중…' : '✦ AI 로 다시 쓰기'}
        </button>
      {/if}
      {#if block.prev != null && !fixing}
        <button onclick={() => { block.text = block.prev!; block.prev = undefined }} title="AI 재작성 전으로">원래대로</button>
        {#if !errs.length}<button onclick={() => (block.prev = undefined)} title="재작성 결과 확정">확정</button>{/if}
      {/if}
    </div>
  {/if}
  <div class="preview">{@html preview || '<span class="muted">(비어 있음)</span>'}</div>
</div>
