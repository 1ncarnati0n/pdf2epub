<script lang="ts">
  import Block, { type Action } from './Block.svelte'
  import Preview from './Preview.svelte'
  import Sidebar, { type Issue } from './Sidebar.svelte'
  import { anchor, blockHtml, buildEpub, clean, errors, type Block as B, type Project } from './epub'
  import { tick } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { crop, openPdf, pageText, render, toBlob, type Doc } from './pdf'

  const HI_SCALE = 2 // 인식·크롭용 래스터 배율 (≈144dpi)
  const DEFAULT_MODEL = 'gpt-6.1-terra'

  let list = $state<{ id: string, title: string }[]>([])
  let project = $state<Project | null>(null)
  let doc = $state.raw<Doc | null>(null)
  let pageN = $state(1)
  let selected = $state<string | null>(null)
  let running = $state(false)
  let stopFlag = false
  let saved = $state('')
  let canvasEl = $state<HTMLCanvasElement>()
  let drag = $state<{ x0: number, y0: number, x: number, y: number } | null>(null)
  let hovered = $state<string | null>(null)
  let pane = $state<'blocks' | 'preview' | 'xhtml'>(localStorage.pane || 'blocks') // 오른쪽 패널
  let epubBuf = $state.raw<ArrayBuffer | null>(null)
  let building = $state(false)
  const fixing = new SvelteSet<string>()
  let fixingAll = $state(false)
  let toast = $state('')
  let progress = $state<{ from: number, at: number } | null>(null)
  let ratio = $state(Number(localStorage.ratio) || 0.5) // PDF : 블록 분할 비율
  let mainEl = $state<HTMLElement>()

  const page = $derived(project?.pages[pageN - 1])
  const issues = $derived<Issue[]>(project?.pages.flatMap(pg => pg.blocks.flatMap(block => {
    const e = errors(block)
    return e.length ? [{ n: pg.n, block, msg: e[0] }] : []
  })) ?? [])
  // 미리보기 위치: 선택 블록 → 현재 쪽 첫 블록 → 앞쪽의 마지막 블록
  const previewTarget = $derived.by(() => {
    if (!project) return
    const id = selected ?? page?.blocks[0]?.id ?? project.pages.slice(0, pageN).findLast(p => p.blocks.length)?.blocks.at(-1)?.id
    return id ? anchor(project, id) : undefined
  })
  const xhtml = $derived(page ? clean(page.blocks.map(b => blockHtml(b, b => `images/${b.src}`)).join('\n')).replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '') : '')
  const api = (p: string) => `/api/projects/${project!.id}${p}`
  const uid = () => Math.random().toString(36).slice(2, 10)

  async function req(url: string, init?: RequestInit) {
    const r = await fetch(url, init)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText)
    return r
  }

  fetch('/api/projects').then(r => r.json()).then(l => (list = l))

  async function newProject(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    const data = await file.arrayBuffer()
    const id = Date.now().toString(36) + uid().slice(0, 4)
    await req(`/api/projects/${id}/files/source.pdf`, { method: 'PUT', body: data.slice(0) })
    doc = await openPdf(data)
    project = {
      id, title: file.name.replace(/\.pdf$/i, ''), author: '', lang: 'ko', model: DEFAULT_MODEL, notation: '',
      pages: Array.from({ length: doc.numPages }, (_, i) => ({ n: i + 1, status: 'todo', blocks: [] })),
    }
    pageN = 1
  }

  async function openProject(id: string) {
    if (!id) return
    const p = await (await req(`/api/projects/${id}`)).json()
    // 중단된 인식 상태 정리
    for (const pg of p.pages) if (pg.status === 'busy') pg.status = 'todo'
    doc = await openPdf(await (await req(`/api/projects/${id}/files/source.pdf`)).arrayBuffer())
    project = p
    pageN = 1
  }

  // 자동 저장
  let saveTimer: ReturnType<typeof setTimeout>
  $effect(() => {
    if (!project) return
    const json = JSON.stringify(project)
    clearTimeout(saveTimer)
    saved = '…'
    saveTimer = setTimeout(() => req(api(''), { method: 'PUT', body: json })
      .then(() => (saved = '저장됨'), e => (saved = '저장 실패: ' + e.message)), 600)
  })

  addEventListener('beforeunload', e => { if (saved === '…') e.preventDefault() })

  // 왼쪽 PDF 표시
  let renderJob = Promise.resolve()
  $effect(() => {
    const d = doc, n = pageN, c = canvasEl
    if (!d || !c) return
    renderJob = renderJob.then(() => render(d, n, 2, c).then(() => {})).catch(console.error)
  })

  // 인식/크롭용 고해상도 렌더 (마지막 1페이지만 캐시)
  let hiCache: { n: number, c: HTMLCanvasElement } | null = null
  async function hiRes(n: number) {
    if (hiCache?.n !== n) hiCache = { n, c: await render(doc!, n, HI_SCALE) }
    return hiCache.c
  }

  async function recrop(b: B, n: number) {
    b.format ??= 'webp'
    b.quality ??= 0.85
    b.width ??= 0
    const blob = await crop(await hiRes(n), b.bbox, b.width, b.format, b.quality)
    const src = `${b.id}.${b.format === 'jpeg' ? 'jpg' : b.format}`
    await req(api(`/files/images/${src}`), { method: 'PUT', body: blob })
    images.delete(src)
    b.src = src
    b.bytes = blob.size
    b.v = Date.now()
  }

  async function recognize(n: number) {
    const p = project!, pg = p.pages[n - 1]
    pg.status = 'busy'
    pg.error = ''
    try {
      const c = await hiRes(n)
      await req(api(`/files/pages/${n}.png`), { method: 'PUT', body: await toBlob(c, 'image/png') })
      const prevBlocks = p.pages[n - 2]?.blocks ?? []
      const context = prevBlocks.slice(-3).map(b => `[${b.type}] ${b.text}`).join('\n')
      const r = await (await req(api(`/recognize/${n}`), {
        method: 'POST',
        body: JSON.stringify({ model: p.model, notation: p.notation, context, textLayer: await pageText(doc!, n) }),
      })).json()

      const blocks: B[] = r.blocks.map((b: Omit<B, 'id'>) => ({ ...b, id: uid() }))
      const last = prevBlocks.at(-1)
      if (r.continues && last?.type === 'paragraph' && blocks[0]?.type === 'paragraph')
        last.text = last.text.trimEnd() + ' ' + blocks.shift()!.text.trimStart()

      const known = new Set(p.notation.split('\n'))
      const fresh = (r.notation ?? '').split('\n').map((s: string) => s.trim()).filter((s: string) => s && !known.has(s))
      if (fresh.length) p.notation = [p.notation, ...fresh].filter(Boolean).join('\n')

      pg.blocks = blocks
      for (const b of pg.blocks) if (b.type === 'figure') await recrop(b, n)
      pg.status = 'done'
      // 파싱 안 되는 LaTeX 는 바로 한 번 재작성 시도
      for (const b of pg.blocks) if (errors(b).length) await fixBlock(b, n, 2)
    } catch (e: any) {
      pg.status = 'error'
      pg.error = e.message
    }
  }

  async function ensurePageImage(n: number) {
    await req(api(`/files/pages/${n}.png`), { method: 'PUT', body: await toBlob(await hiRes(n), 'image/png') })
  }

  // 페이지 이미지를 다시 보고 블록을 고쳐 쓰기. 실패한 시도를 넘겨 매번 다른 방식을 유도, 파싱되면 멈춤
  async function fixBlock(b: B, n: number, attempts = 3) {
    if (fixing.has(b.id)) return
    fixing.add(b.id)
    const original = b.text, tried: string[] = []
    try {
      await ensurePageImage(n)
      for (let i = 0; i < attempts; i++) {
        const errs = errors(b)
        const r = await (await req(api(`/fix/${n}`), {
          method: 'POST',
          body: JSON.stringify({ model: project!.model, type: b.type, text: b.text, bbox: b.bbox, tried,
            errors: errs.length ? errs : ['오류는 없지만 사용자가 원문과 다르다고 표시함. 이미지를 다시 보고 정확히 옮겨라.'] }),
        })).json()
        tried.push(b.text)
        b.text = r.text
        if (!errors(b).length) break
      }
      if (b.text !== original) b.prev ??= original
      if (errors(b).length) toast = `${n}쪽 블록: ${attempts}번 재작성했지만 아직 오류가 있습니다`
    } catch (e: any) {
      toast = 'AI 재작성 실패: ' + e.message
    } finally {
      fixing.delete(b.id)
    }
  }

  async function fixAll() {
    fixingAll = true
    for (const it of [...issues]) {
      if (stopFlag) break
      await fixBlock(it.block, it.n)
    }
    fixingAll = false
  }

  async function recognizeOne() {
    if (page!.blocks.length && !confirm('이 페이지의 기존 블록을 덮어씁니다. 계속할까요?')) return
    running = true
    await recognize(pageN)
    running = false
  }

  // 문맥(직전 페이지)을 이어 받아야 하므로 순차 실행
  async function recognizeAll() {
    running = true
    stopFlag = false
    progress = { from: pageN, at: pageN }
    for (let n = pageN; n <= project!.pages.length && !stopFlag; n++) {
      progress.at = n
      if (project!.pages[n - 1].status === 'done') continue
      pageN = n
      await recognize(n)
    }
    running = false
    progress = null
  }

  function act(i: number, a: Action, pos?: number) {
    const bs = page!.blocks
    if (a === 'up' && i > 0) [bs[i - 1], bs[i]] = [bs[i], bs[i - 1]]
    if (a === 'down' && i < bs.length - 1) [bs[i + 1], bs[i]] = [bs[i], bs[i + 1]]
    if (a === 'delete') {
      bs.splice(i, 1)
      selected = bs[Math.min(i, bs.length - 1)]?.id ?? null
    }
    if (a === 'insert' || a === 'split') {
      const src = bs[i]
      // 인라인 수식 \( \) 안에서 자르지 않도록 수식 끝으로 밀기
      for (const m of src.text.matchAll(/\\\(.+?\\\)/gs))
        if (pos != null && pos > m.index && pos < m.index + m[0].length) pos = m.index + m[0].length
      const b: B = a === 'insert'
        ? { id: uid(), type: 'paragraph', text: '', level: 0, ordered: false, bbox: [0, 0, 0, 0] }
        : { ...src, id: uid(), src: undefined, text: src.text.slice(pos ?? src.text.length).trimStart() }
      if (a === 'split') src.text = src.text.slice(0, pos ?? src.text.length).trimEnd()
      bs.splice(i + 1, 0, b)
      focusBlock(b.id)
    }
    if (a === 'merge' && bs[i + 1]) {
      const [a0, b0] = [bs[i], bs[i + 1]]
      a0.text = a0.text + (a0.type === 'list' || a0.type === 'math' ? '\n' : ' ') + b0.text
      const [x, y] = [Math.min(a0.bbox[0], b0.bbox[0]), Math.min(a0.bbox[1], b0.bbox[1])]
      a0.bbox = [x, y, Math.max(a0.bbox[0] + a0.bbox[2], b0.bbox[0] + b0.bbox[2]) - x, Math.max(a0.bbox[1] + a0.bbox[3], b0.bbox[1] + b0.bbox[3]) - y]
      bs.splice(i + 1, 1)
    }
  }

  function select(id: string) {
    selected = id
    document.getElementById('blk-' + id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  async function focusBlock(id: string) {
    pane = 'blocks'
    select(id)
    await tick()
    document.querySelector<HTMLTextAreaElement>(`#blk-${id} textarea`)?.focus()
  }

  function nextIssue() {
    if (!issues.length) return
    const bs = page!.blocks, i = bs.findIndex(b => b.id === selected)
    const next = issues.find(it => it.n > pageN || (it.n === pageN && bs.findIndex(b => b.id === it.block.id) > i)) ?? issues[0]
    goBlock(next.n, next.block.id)
  }

  async function goBlock(n: number, id: string) {
    pageN = n
    await tick()
    select(id)
  }

  function go(n: number) {
    if (!project) return
    pageN = Math.min(project.pages.length, Math.max(1, n))
    selected = null
  }

  // 입력창 밖 단축키
  function keys(e: KeyboardEvent) {
    if (!project || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest('input,textarea,select')) return
    const bs = page!.blocks, i = bs.findIndex(b => b.id === selected)
    const k = e.key
    if (k === 'ArrowLeft') go(pageN - 1)
    else if (k === 'ArrowRight') go(pageN + 1)
    else if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown') && i >= 0) act(i, k === 'ArrowUp' ? 'up' : 'down')
    else if (k === 'ArrowUp' || k === 'ArrowDown') {
      const j = i < 0 ? 0 : Math.min(bs.length - 1, Math.max(0, i + (k === 'ArrowUp' ? -1 : 1)))
      if (bs[j]) select(bs[j].id)
    }
    else if (k === 'Enter' && i >= 0) focusBlock(bs[i].id)
    else if ((k === 'Delete' || k === 'Backspace') && i >= 0) act(i, 'delete')
    else if (k === 'r' && !running) recognizeOne()
    else if (k === 'p') pane = pane === 'preview' ? 'blocks' : 'preview'
    else if (k === 'a' && i >= 0) fixBlock(bs[i], pageN)
    else if (k === 'e') nextIssue()
    else return
    e.preventDefault()
  }

  $effect(() => { localStorage.pane = pane })
  $effect(() => { if (toast) { const t = setTimeout(() => (toast = ''), 5000); return () => clearTimeout(t) } })

  // 이미지 바이트 캐시 (미리보기 재빌드마다 다시 받지 않도록, recrop 시 무효화)
  const images = new Map<string, Promise<ArrayBuffer>>()
  const image = (src: string) => {
    if (!images.has(src)) images.set(src, req(api(`/files/images/${src}`)).then(r => r.arrayBuffer()))
    return images.get(src)!
  }

  // 미리보기 탭이 열려 있으면 편집 후 0.8초 뒤 다시 빌드
  let builtKey = ''
  // ponytail: 매번 책 전체를 빌드. 수백 쪽에서 느려지면 현재 챕터만 빌드하도록
  $effect(() => {
    if (pane !== 'preview' || !project) return
    const p = $state.snapshot(project) as Project
    // 본문이 실제로 바뀐 경우만 (인식 상태·표기 규칙 변경 등은 무시) → iframe 재생성 최소화
    const key = JSON.stringify([p.title, p.author, p.lang, p.pages.map(pg => pg.blocks)])
    if (key === builtKey) return
    const t = setTimeout(async () => {
      building = true
      builtKey = key
      try { epubBuf = await (await buildEpub(p, image)).generateAsync({ type: 'arraybuffer' }) }
      catch (e: any) { toast = '미리보기 빌드 실패: ' + e.message; builtKey = '' }
      building = false
    }, epubBuf ? 800 : 0)
    return () => clearTimeout(t)
  })

  function resize(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const left = (el.previousElementSibling as HTMLElement).getBoundingClientRect().left
    const right = mainEl!.getBoundingClientRect().right
    el.onpointermove = ev => (ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - left) / (right - left))))
    el.onpointerup = () => { el.onpointermove = null; localStorage.ratio = ratio }
  }

  // PDF 위 드래그 → 선택 블록 bbox 재지정
  const rel = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  function down(e: PointerEvent) {
    if (!selected || e.target !== e.currentTarget) return
    const { x, y } = rel(e)
    drag = { x0: x, y0: y, x, y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function move(e: PointerEvent) { if (drag) Object.assign(drag, rel(e)) }
  async function up() {
    const d = drag
    drag = null
    const b = page?.blocks.find(b => b.id === selected)
    if (!d || !b || Math.abs(d.x - d.x0) < 0.01 || Math.abs(d.y - d.y0) < 0.01) return
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    const [x, y] = [clamp(Math.min(d.x, d.x0)), clamp(Math.min(d.y, d.y0))]
    b.bbox = [x, y, clamp(Math.max(d.x, d.x0)) - x, clamp(Math.max(d.y, d.y0)) - y]
    if (b.type === 'figure') await recrop(b, pageN)
  }

  async function exportEpub() {
    const zip = await buildEpub(project!, image)
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${project!.title || 'book'}.epub`
    a.click()
    URL.revokeObjectURL(a.href)
  }


  const box = (bb: number[]) => `left:${bb[0] * 100}%;top:${bb[1] * 100}%;width:${bb[2] * 100}%;height:${bb[3] * 100}%`
  const done = $derived(project?.pages.filter(p => p.status === 'done').length ?? 0)
  const STATUS = { todo: '미인식', busy: '인식 중', done: '완료', error: '오류' }
</script>

<svelte:window onkeydown={keys} />

<header>
  <strong class="logo">pdf2epub</strong>
  <label class="btn" title="새 PDF 로 프로젝트 만들기">📄 PDF 열기<input type="file" accept="application/pdf" onchange={newProject} hidden /></label>
  <select onchange={e => openProject((e.target as HTMLSelectElement).value)} title="프로젝트 불러오기">
    <option value="">{project ? project.title : '프로젝트 불러오기…'}</option>
    {#each list as p}<option value={p.id}>{p.title}</option>{/each}
  </select>

  {#if project && page}
    <div class="sep"></div>
    <button onclick={() => go(pageN - 1)} disabled={pageN <= 1} title="이전 쪽 (←)">◀</button>
    <input type="number" min="1" max={project.pages.length} value={pageN} onchange={e => go(+(e.target as HTMLInputElement).value)} style="width:4.5em" />
    <span class="muted">/ {project.pages.length}</span>
    <button onclick={() => go(pageN + 1)} disabled={pageN >= project.pages.length} title="다음 쪽 (→)">▶</button>

    <div class="sep"></div>
    <button onclick={recognizeOne} disabled={running} title="이 쪽 인식 (R)">⟳ 이 쪽 인식</button>
    {#if running}
      <button class="danger" onclick={() => (stopFlag = true)}>■ 중지</button>
    {:else}
      <button onclick={recognizeAll} title="현재 쪽부터 미인식 쪽을 순서대로">⏵ 여기부터 전체</button>
    {/if}

    <span class="grow"></span>
    <details class="pop">
      <summary class="btn">⚙ 책 정보</summary>
      <div class="card">
        <label>제목 <input bind:value={project.title} /></label>
        <label>저자 <input bind:value={project.author} /></label>
        <label>언어 <input bind:value={project.lang} placeholder="ko" /></label>
        <label>모델 <input bind:value={project.model} /></label>
        <label>본문 글꼴 <select bind:value={project.font}>
          <option value={undefined}>세리프(명조)</option>
          <option value="sans-serif">산세리프(고딕)</option>
        </select></label>
        <label>누적 표기 규칙 <textarea bind:value={project.notation} rows="5" placeholder={"예: 벡터는 \\mathbf{x}"}></textarea></label>
      </div>
    </details>
    <button class="primary" onclick={exportEpub} disabled={running}>⬇ EPUB 내보내기</button>
  {/if}
</header>
<div class="progress">{#if progress}<div style="width:{done / project!.pages.length * 100}%"></div>{/if}</div>

{#if project && page && doc}
  <main bind:this={mainEl} style="grid-template-columns: 190px {ratio}fr 5px {1 - ratio}fr; --book-font: {project.font ?? 'serif'}">
    <Sidebar {doc} {project} {pageN} {selected} {issues} {fixingAll}
      onpage={go} onblock={goBlock} onfixall={fixAll} />

    <section class="pdf">
      <div class="panehead">
        <span>원본 PDF · {pageN}쪽</span>
        <span class="status {page.status}">{STATUS[page.status]}</span>
        <span class="grow"></span>
        <span class="muted">{selected ? '드래그해서 선택 블록 영역 지정' : ''}</span>
      </div>
      <div class="scroll">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="sheet" onpointerdown={down} onpointermove={move} onpointerup={up}>
          <canvas bind:this={canvasEl}></canvas>
          {#each page.blocks as b (b.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div class="bbox {b.type}" class:sel={b.id === selected} class:hov={b.id === hovered} class:bad={errors(b).length}
              style={box(b.bbox)} onclick={() => select(b.id)}></div>
          {/each}
          {#if drag}
            <div class="bbox drag" style={box([Math.min(drag.x, drag.x0), Math.min(drag.y, drag.y0), Math.abs(drag.x - drag.x0), Math.abs(drag.y - drag.y0)])}></div>
          {/if}
        </div>
      </div>
    </section>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="gutter" onpointerdown={resize}></div>

    <section class="right">
      <div class="panehead tabs">
        <button class:on={pane === 'blocks'} onclick={() => (pane = 'blocks')}>✎ 블록 편집</button>
        <button class:on={pane === 'preview'} onclick={() => (pane = 'preview')} title="P">👁 EPUB 미리보기</button>
        <button class:on={pane === 'xhtml'} onclick={() => (pane = 'xhtml')}>&lt;/&gt; XHTML</button>
        <span class="grow"></span>
        {#if pane === 'preview' && building}<span class="muted">빌드 중…</span>{/if}
      </div>

      {#if pane === 'blocks'}
        <div class="scroll blocks">
          {#if page.status === 'error'}<div class="note err">{page.error}<button onclick={recognizeOne}>다시 시도</button></div>{/if}
          {#if page.status === 'busy'}<div class="note busy">Codex({project.model})로 {pageN}쪽 인식 중…</div>{/if}
          {#each page.blocks as b, i (b.id)}
            <Block bind:block={page.blocks[i]} pid={project.id} selected={b.id === selected} fixing={fixing.has(b.id)}
              onselect={() => (selected = b.id)} onhover={on => (hovered = on ? b.id : null)}
              onaction={(a, pos) => act(i, a, pos)} onrecrop={() => recrop(page.blocks[i], pageN)}
              onfix={() => fixBlock(page.blocks[i], pageN)} />
          {:else}
            {#if page.status !== 'busy'}
              <div class="empty">아직 인식되지 않은 쪽입니다.<br /><button class="primary" onclick={recognizeOne}>⟳ 인식하기 (R)</button></div>
            {/if}
          {/each}
          {#if page.blocks.length}
            <button class="add" onclick={() => act(page.blocks.length - 1, 'insert')}>＋ 블록 추가</button>
          {/if}
        </div>
      {:else if pane === 'preview'}
        {#if epubBuf}
          <Preview epub={epubBuf} target={previewTarget} />
        {:else}
          <div class="empty">EPUB 빌드 중…</div>
        {/if}
      {:else}
        <pre class="scroll code">{xhtml || '<!-- 블록 없음 -->'}</pre>
      {/if}
    </section>
  </main>

  <footer>
    <span>{pageN}/{project.pages.length}쪽</span>
    <span>블록 {page.blocks.length}</span>
    <span>인식 {done}/{project.pages.length}</span>
    <button class="link" class:bad={issues.length} onclick={nextIssue} title="다음 오류로 (E)">
      LaTeX 오류 {issues.length}
    </button>
    {#if fixing.size}<span>✦ 재작성 중 {fixing.size}</span>{/if}
    <span>{saved}</span>
    <span class="grow"></span>
    <span class="muted">←/→ 쪽 · ↑/↓ 블록 · Enter 편집 · Esc · Alt+↑/↓ 이동 · Del 삭제 · ⌘Enter 추가 · ⌘⇧Enter 분할 · R 인식 · A AI 재작성 · E 다음 오류 · P 미리보기</span>
  </footer>
{:else}
  <div class="empty big">
    <h2>PDF → EPUB</h2>
    <p>PDF 를 열거나 기존 프로젝트를 불러오세요.</p>
    <p class="muted">인식에는 Codex CLI 로그인(<code>codex login</code>)이 필요합니다.</p>
  </div>
{/if}

{#if toast}<div class="toast">{toast}<button onclick={() => (toast = '')}>✕</button></div>{/if}

<style>
  :global(:root) {
    --bg: #fff; --panel: #f6f7f9; --line: #e2e4e8; --fg: #1d1f23; --muted: #7a808a; --hover: #eceef2;
    --accent: #3b6ef5; --accent-soft: #e3ebff; --err: #d33; --math: #f39c12; --fig: #22a35a; --ai: #7b4ddb;
  }
  :global(body) { margin: 0; font: 13px system-ui, sans-serif; color: var(--fg); background: var(--bg); height: 100vh; display: flex; flex-direction: column; }
  :global(#app) { display: contents; }
  :global(button), :global(select), :global(input), :global(.btn), :global(textarea) {
    font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 5px; padding: 3px 8px;
  }
  :global(button), :global(.btn) { cursor: pointer; white-space: nowrap; }
  :global(button:hover:not(:disabled)), :global(.btn:hover) { background: var(--hover); }
  :global(button:disabled) { opacity: .45; cursor: default; }
  :global(.grow) { flex: 1; }
  :global(.muted) { color: var(--muted); }
  :global(button.ai) { color: var(--ai); border-color: #d9cdf5; }
  :global(button.ai:hover:not(:disabled)) { background: #f1ebff; }
  .primary, :global(button.primary) { background: var(--accent); color: #fff; border-color: var(--accent); }
  .primary:hover:not(:disabled) { background: #2f5ad0 !important; }
  .danger { color: var(--err); border-color: #f3c4c4; }
  header { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
  .logo { margin-right: 4px; letter-spacing: -.02em; }
  .sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
  .pop { position: relative; }
  .pop summary { list-style: none; }
  .pop .card { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 24px #0002; padding: 12px; display: grid; gap: 8px; width: 320px; }
  .pop label { display: grid; gap: 3px; font-size: 12px; color: var(--muted); }
  .pop textarea { font: 12px ui-monospace, monospace; }
  .progress { height: 2px; background: var(--line); }
  .progress div { height: 100%; background: var(--accent); transition: width .3s; }
  main { flex: 1; display: grid; min-height: 0; }
  section { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .panehead { display: flex; gap: 8px; align-items: center; padding: 0 10px; height: 34px; flex: none; border-bottom: 1px solid var(--line); background: var(--bg); font-size: 12px; }
  .tabs button { all: unset; cursor: pointer; padding: 0 10px; height: 100%; color: var(--muted); border-bottom: 2px solid transparent; }
  .tabs button.on { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
  .scroll { flex: 1; overflow: auto; padding: 12px; margin: 0; }
  .pdf .scroll { background: #e4e6ea; }
  .gutter { cursor: col-resize; background: var(--line); }
  .gutter:hover { background: var(--accent); }
  .sheet { position: relative; margin: 0 auto; touch-action: none; max-width: 900px; }
  canvas { display: block; width: 100%; box-shadow: 0 1px 6px #0003; background: #fff; }
  .bbox { position: absolute; border: 1px solid #3b6ef555; background: #3b6ef50d; cursor: pointer; border-radius: 2px; }
  .bbox.math { border-color: #f39c1288; } .bbox.figure { border-color: #22a35a88; }
  .bbox.bad { border: 1.5px dashed var(--err); background: #dd333310; }
  .bbox.hov { background: #3b6ef522; border-color: var(--accent); }
  .bbox.sel { border: 2px solid var(--accent); background: #3b6ef522; }
  .bbox.drag { border: 2px dashed var(--accent); pointer-events: none; }
  .status { padding: 1px 8px; border-radius: 10px; background: var(--hover); }
  .status.done { background: #d8f5df; } .status.error { background: #fde0e0; } .status.busy { background: #fff3c4; }
  .blocks { background: var(--panel); }
  .note { padding: 8px 12px; margin-bottom: 8px; border-radius: 6px; display: flex; gap: 8px; align-items: center; justify-content: space-between; white-space: pre-wrap; }
  .note.busy { background: #fff3c4; } .note.err { background: #fde0e0; color: var(--err); }
  .add { width: 100%; border-style: dashed; color: var(--muted); padding: 8px; }
  .code { font: 12px/1.6 ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; background: #fbfbfc; }
  .empty { padding: 32px; color: var(--muted); text-align: center; line-height: 2.4; }
  .empty.big { margin: auto; }
  footer { display: flex; gap: 14px; align-items: center; padding: 3px 10px; border-top: 1px solid var(--line); font-size: 11px; background: var(--panel); white-space: nowrap; overflow: hidden; }
  footer .link { all: unset; cursor: pointer; } footer .link.bad { color: var(--err); font-weight: 600; }
  .toast { position: fixed; bottom: 36px; left: 50%; transform: translateX(-50%); background: #222; color: #fff; padding: 8px 12px; border-radius: 8px; display: flex; gap: 10px; align-items: center; z-index: 30; box-shadow: 0 6px 20px #0004; }
  .toast button { all: unset; cursor: pointer; opacity: .7; }

  :global(.block) { position: relative; border: 1px solid var(--line); border-left: 3px solid #3b6ef555; border-radius: 6px; padding: 6px 10px; margin-bottom: 6px; background: var(--bg); cursor: text; }
  :global(.block:not(.selected)) { padding-right: 80px; }
  :global(.block.math) { border-left-color: var(--math); } :global(.block.figure) { border-left-color: var(--fig); }
  :global(.block:hover) { border-color: #c5cad3; }
  :global(.block.selected) { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  :global(.block.err) { border-color: var(--err); background: #fff8f8; }
  :global(.block .tag) { position: absolute; top: 4px; right: 6px; font-size: 10px; color: var(--muted); text-transform: uppercase; }
  :global(.block .bar) { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
  :global(.block .fix) { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  :global(.block .fix .errmsg) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  :global(.block textarea) { width: 100%; box-sizing: border-box; font: 13px/1.5 ui-monospace, monospace; padding: 4px 6px; resize: vertical; }
  :global(.preview) { font-family: var(--book-font, serif); font-size: 16px; line-height: 1.6; overflow-x: auto; }
  :global(.block.selected .preview) { border-top: 1px dashed var(--line); margin-top: 6px; padding-top: 4px; }
  :global(.preview > *:first-child) { margin-top: 0; } :global(.preview > *:last-child) { margin-bottom: 0; }
  :global(.preview img) { max-width: 100%; }
  :global(.preview .sans) { font-family: sans-serif; } :global(.preview .serif) { font-family: serif; } :global(.preview .mono) { font-family: monospace; }
  :global(.block .fmt button) { padding: 1px 6px; font-size: 12px; } :global(.block .color) { display: inline-flex; align-items: center; gap: 2px; font-size: 12px; } :global(.block .color input) { width: 22px; height: 20px; padding: 0; border: 0; }
  :global(.preview .contents), :global(.preview .contents ul) { list-style: none; padding-left: 1.5em; } :global(.preview .contents) { padding-left: 0; }
  :global(.preview figure) { margin: 0; text-align: center; }
  :global(.preview table) { border-collapse: collapse; } :global(.preview td), :global(.preview th) { border: 1px solid #aaa; padding: .2em .4em; }
  :global(.errmsg), :global(.math-error) { color: var(--err); font-size: 12px; }
</style>
