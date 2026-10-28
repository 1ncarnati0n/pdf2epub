<script lang="ts">
  import Block, { type Action } from './Block.svelte'
  import Preview from './Preview.svelte'
  import Segmented from './Segmented.svelte'
  import Shelf, { type Entry } from './Shelf.svelte'
  import Sidebar, { type Issue } from './Sidebar.svelte'
  import { anchor, blocksHtml, buildEpub, clean, css, errors, regroup, type Block as B, type Project } from './epub'
  import { tick } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { crop, openPdf, pageText, render, toBlob, type Doc } from './pdf'

  const HI_SCALE = 2 // 인식·크롭용 래스터 배율 (≈144dpi)
  const DEFAULT_MODEL = 'gpt-6.1-terra'

  let list = $state<Entry[]>([])
  let shelfOpen = $state(false)
  let infoOpen = $state(false)
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
  const xhtml = $derived(page ? clean(blocksHtml(page.blocks, b => `images/${b.src}`)).replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '') : '')
  const api = (p: string) => `/api/projects/${project!.id}${p}`
  const uid = () => Math.random().toString(36).slice(2, 10)

  async function req(url: string, init?: RequestInit) {
    const r = await fetch(url, init)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText)
    return r
  }

  const loadList = () => fetch('/api/projects').then(r => r.json()).then(l => (list = l))
  loadList()

  async function newProject(file: File) {
    if (running) throw new Error('인식 중에는 다른 프로젝트를 열 수 없습니다')
    const data = await file.arrayBuffer()
    const id = Date.now().toString(36) + uid().slice(0, 4)
    await req(`/api/projects/${id}/files/source.pdf`, { method: 'PUT', body: data.slice(0) })
    doc = await openPdf(data)
    project = {
      id, title: file.name.replace(/\.pdf$/i, ''), author: '', lang: 'ko', model: DEFAULT_MODEL, notation: '',
      pages: Array.from({ length: doc.numPages }, (_, i) => ({ n: i + 1, status: 'todo', blocks: [] })),
    }
    pageN = 1
    selected = null
    shelfOpen = false
    await req(api(''), { method: 'PUT', body: JSON.stringify(project) })
    loadList()
  }

  async function deleteProject(id: string) {
    await req(`/api/projects/${id}`, { method: 'DELETE' })
    await loadList()
  }

  async function openProject(id: string) {
    if (running) throw new Error('인식 중에는 다른 프로젝트를 열 수 없습니다')
    const p = await (await req(`/api/projects/${id}`)).json()
    // 중단된 인식 상태 정리
    for (const pg of p.pages) if (pg.status === 'busy') pg.status = 'todo'
    doc = await openPdf(await (await req(`/api/projects/${id}/files/source.pdf`)).arrayBuffer())
    project = p
    pageN = 1
    selected = null
    shelfOpen = false
    loadList()
  }

  // 자동 저장
  // 저장은 그 시점의 url 로 묶어 둔다. 대기 중에 다른 프로젝트로 바꾸면 이전 프로젝트 것을 바로 저장
  let saveTimer: ReturnType<typeof setTimeout>
  let pending: { url: string, run: () => void } | null = null
  $effect(() => {
    if (!project) return
    const json = JSON.stringify(project), url = api('')
    clearTimeout(saveTimer)
    if (pending && pending.url !== url) pending.run()
    saved = '…'
    const run = () => {
      pending = null
      req(url, { method: 'PUT', body: json }).then(() => (saved = '저장됨'), e => (saved = '저장 실패: ' + e.message))
    }
    pending = { url, run }
    saveTimer = setTimeout(run, 600)
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
      const prevBlocks = (p.pages[n - 2]?.blocks ?? []).filter(b => b.type !== 'footnote') // 쪽 끝 각주는 문맥·연속 판단에서 제외
      const context = prevBlocks.slice(-3).map(b => `[${b.type}] ${b.text}`).join('\n')
      const r = await (await req(api(`/recognize/${n}`), {
        method: 'POST',
        body: JSON.stringify({ model: p.model, notation: p.notation, context, textLayer: await pageText(doc!, n) }),
      })).json()

      const last = prevBlocks.at(-1)
      const blocks: B[] = regroup(r.blocks, n, last, r.continues).map((b: Omit<B, 'id'>) => ({ ...b, id: uid() }))
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
    for (let n = pageN; n <= project!.pages.length && !stopFlag; n++) {
      if (project!.pages[n - 1].status === 'done') continue
      pageN = n
      await recognize(n)
    }
    running = false
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

{#if project && page && doc}
  <header>
    <button class="book" aria-expanded={shelfOpen} title="책장 — 다른 프로젝트로 전환·삭제" onclick={() => (shelfOpen = !shelfOpen)}>
      <strong>{project.title || '(제목 없음)'}</strong>
      {#if project.author}<span class="by">{project.author}</span>{/if}
      <span class="caret" aria-hidden="true">▾</span>
    </button>
    <div class="progress" class:live={running} title="인식 {done}/{project.pages.length}쪽">
      <span class="spine" aria-hidden="true"><i style:width="{(done / project.pages.length) * 100}%"></i></span>
      <span class="num">{running ? `${done}/${project.pages.length}` : `${Math.round((done / project.pages.length) * 100)}%`}</span>
    </div>
    <div class="pager">
      <button onclick={() => go(pageN - 1)} disabled={pageN <= 1} title="이전 쪽 (←)">‹</button>
      <input type="number" min="1" max={project.pages.length} value={pageN} onchange={e => go(+(e.target as HTMLInputElement).value)} />
      <span class="muted">/ {project.pages.length}</span>
      <button onclick={() => go(pageN + 1)} disabled={pageN >= project.pages.length} title="다음 쪽 (→)">›</button>
    </div>
    <Segmented size="small" label="보기 전환" value={pane} pick={k => (pane = k)}
      items={[{ key: 'blocks', label: '편집' }, { key: 'preview', label: '미리보기', title: 'P' }, { key: 'xhtml', label: 'XHTML' }]} />

    <!-- 도구: 저장 상태는 점으로, 이름은 툴팁으로 (epubeditor 와 같은 묶음) -->
    <div class="tools" role="group" aria-label="도구">
      <span class="tool save" class:dirty={saved === '…'} class:bad={saved.startsWith('저장 실패')} title={saved || '저장됨'}><i aria-hidden="true"></i>저장</span>
      <button class="tool" onclick={recognizeOne} disabled={running} title="이 쪽 인식 (R)">인식</button>
      {#if running}
        <button class="tool stop" onclick={() => (stopFlag = true)} title="진행 중인 쪽까지만 하고 멈춤">중지</button>
      {:else}
        <button class="tool" onclick={recognizeAll} title="현재 쪽부터 미인식 쪽을 순서대로">전체 인식</button>
      {/if}
      <button class="tool" class:on={infoOpen} onclick={() => (infoOpen = !infoOpen)} title="책 정보 — 제목·저자·글꼴·표기 규칙">정보</button>
    </div>
    <button class="primary" onclick={exportEpub} disabled={running}>내보내기</button>
  </header>

  {#if shelfOpen}
    <div class="shelf-drop"><Shelf {list} current={project.id} onopen={openProject} onnew={newProject} ondelete={deleteProject} /></div>
    <div class="scrim" role="button" tabindex="-1" aria-label="책장 닫기"
      onclick={() => (shelfOpen = false)} onkeydown={e => e.key === 'Escape' && (shelfOpen = false)}></div>
  {/if}
  {#if toast}
    <div class="stale-bar" role="alert"><strong>알림</strong><span>{toast}</span><button onclick={() => (toast = '')}>닫기</button></div>
  {/if}

  <main bind:this={mainEl} style="grid-template-columns: 240px {ratio}fr 5px {1 - ratio}fr{infoOpen ? ' 320px' : ''}; --book-font: {project.font ?? 'serif'}">
    <Sidebar {doc} {project} {pageN} {selected} {issues} {fixingAll}
      onpage={go} onblock={goBlock} onfixall={fixAll} />

    <section class="pdf">
      <div class="panehead">
        <span class="lbl">원본 PDF · {pageN}쪽</span>
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
      <div class="panehead">
        <span class="lbl">{pane === 'blocks' ? `블록 · ${page.blocks.length}` : pane === 'preview' ? 'EPUB 미리보기' : 'XHTML'}</span>
        <span class="grow"></span>
        {#if pane === 'preview' && building}<span class="muted">빌드 중…</span>{/if}
      </div>

      {#if pane === 'blocks'}
        <div class="scroll blocks">
          {#if page.status === 'error'}<div class="note err"><span>{page.error}</span><button onclick={recognizeOne}>다시 시도</button></div>{/if}
          {#if page.status === 'busy'}<div class="note busy">Codex({project.model})로 {pageN}쪽 인식 중…</div>{/if}
          {#each page.blocks as b, i (b.id)}
            <Block bind:block={page.blocks[i]} prev={page.blocks.slice(0, i).findLast(x => x.type !== 'footnote') ?? project.pages[pageN - 2]?.blocks.findLast(x => x.type !== 'footnote')} pid={project.id} selected={b.id === selected} fixing={fixing.has(b.id)}
              onselect={() => (selected = b.id)} onhover={on => (hovered = on ? b.id : null)}
              onaction={(a, pos) => act(i, a, pos)} onrecrop={() => recrop(page.blocks[i], pageN)}
              onfix={() => fixBlock(page.blocks[i], pageN)} />
          {:else}
            {#if page.status !== 'busy'}
              <div class="empty">아직 인식되지 않은 쪽입니다.<br /><button class="primary" onclick={recognizeOne}>인식하기 (R)</button></div>
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

    {#if infoOpen}
      <aside class="panel" aria-label="책 정보">
        <div class="head">책 정보</div>
        <p class="lead">내보내는 EPUB 의 서지정보와 조판 설정입니다. 고치는 즉시 저장됩니다.</p>
        <label class="field"><span>제목</span><input bind:value={project.title} spellcheck="false" /></label>
        <label class="field"><span>저자</span><input bind:value={project.author} spellcheck="false" placeholder="비워두면 저자 항목을 뺍니다" /></label>
        <label class="field"><span>언어</span><input bind:value={project.lang} placeholder="ko" /></label>
        <div class="field"><span>본문 글꼴</span>
          <Segmented size="small" label="본문 글꼴" value={project.font ?? 'serif'} pick={k => (project!.font = k === 'serif' ? undefined : k)}
            items={[{ key: 'serif', label: '명조' }, { key: 'sans-serif', label: '고딕' }]} />
        </div>
        <label class="check"><input type="checkbox" bind:checked={project.indent} /> 문단 첫 줄 들여쓰기</label>
        <div class="sect">
          <div class="label">인식</div>
          <label class="field"><span>모델</span><input bind:value={project.model} spellcheck="false" /></label>
          <label class="field"><span>누적 표기 규칙</span>
            <textarea bind:value={project.notation} rows="8" spellcheck="false" placeholder={"예: 벡터는 \\mathbf{x}"}></textarea></label>
          <small>쪽마다 새로 정의된 기호가 자동으로 쌓이고, 인식할 때 모델에 함께 전달됩니다.</small>
        </div>
      </aside>
    {/if}
  </main>

  <footer>
    <span>{pageN}/{project.pages.length}쪽</span>
    <span>블록 {page.blocks.length}</span>
    <span>인식 {done}/{project.pages.length}</span>
    <button class="link" class:bad={issues.length} onclick={nextIssue} title="다음 오류로 (E)">LaTeX 오류 {issues.length}</button>
    {#if fixing.size}<span class="draft">✦ 재작성 중 {fixing.size}</span>{/if}
    <span class="grow"></span>
    <span class="muted">←/→ 쪽 · ↑/↓ 블록 · Enter 편집 · Esc · Alt+↑/↓ 이동 · Del 삭제 · ⌘Enter 추가 · ⌘⇧Enter 분할 · R 인식 · A AI 재작성 · E 다음 오류 · P 미리보기</span>
  </footer>
{:else}
  <Shelf mode="standalone" {list} current={project?.id} onopen={openProject} onnew={newProject} ondelete={deleteProject} />
{/if}

<svelte:head>
  <!-- EPUB style.css 를 블록 미리보기에만 스코프 (CSS nesting) -->
  {@html `<style>.preview{${css(project ?? {})}}</style>`}
</svelte:head>

<style>
  /* 헤더 — epubeditor +page.svelte 와 같은 구성 */
  header { position: relative; display: flex; align-items: center; gap: 1.25rem; padding: 0 1.25rem; height: 52px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .book, .book:hover:not(:disabled) { display: flex; align-items: baseline; gap: 0.6rem; min-width: 0; flex: 1; border: 0; background: none; padding: 0; color: var(--ink); font-size: inherit; overflow: hidden; text-align: left; }
  .book strong { overflow: hidden; text-overflow: ellipsis; font-family: var(--font-en); font-size: 1.05rem; }
  .by { color: var(--muted); font-size: 0.85rem; }
  .caret { color: var(--muted); font-size: 0.7rem; }
  .book:hover .caret { color: var(--ink); }
  .progress { display: flex; align-items: center; gap: 0.6rem; }
  .spine { display: flex; width: 160px; height: 4px; background: var(--line); overflow: hidden; }
  .spine i { height: 100%; background: var(--sealed); transition: width 0.3s; }
  .progress.live .spine i { background: var(--draft); }
  .progress.live .spine { box-shadow: 0 0 0 2px color-mix(in srgb, var(--draft) 14%, transparent); }
  .progress.live .num { color: var(--draft); }
  .num { min-width: 2.6em; color: var(--muted); font-size: 0.8rem; text-align: right; font-variant-numeric: tabular-nums; }
  .pager { display: flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; }
  .pager input { width: 3.6em; padding: 0.15rem 0.3rem; text-align: right; font-variant-numeric: tabular-nums; }
  .pager button { padding: 0.1rem 0.5rem; }
  /* 도구는 한 덩어리로 묶어 주요 행동(내보내기)과 구분 */
  .tools { display: flex; border: 1px solid var(--line); }
  .tool { display: flex; align-items: center; gap: 0.35rem; border: 0; padding: 0.3rem 0.7rem; color: var(--muted); font-size: 0.8rem; }
  .tool + .tool { border-left: 1px solid var(--line); }
  .tool.on, .tool.on:hover:not(:disabled) { color: var(--sealed); box-shadow: inset 0 -2px 0 var(--sealed); }
  .tool.stop { color: var(--warn); }
  .save { cursor: default; }
  .save i { width: 6px; height: 6px; border-radius: 50%; background: var(--sealed); }
  .save.dirty i { background: var(--draft); }
  .save.bad { color: var(--warn); } .save.bad i { background: var(--warn); }
  header .primary { padding: 0.32rem 0.9rem; }
  .shelf-drop { position: absolute; top: 52px; left: 1.25rem; z-index: 15; width: min(560px, calc(100vw - 2.5rem)); border: 1px solid var(--line); box-shadow: 0 20px 50px -22px rgb(0 0 0 / 45%); }
  .scrim { position: fixed; inset: 0; z-index: 14; cursor: default; }
  .stale-bar { display: flex; align-items: center; gap: 0.8rem; flex-shrink: 0; border-bottom: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line)); background: color-mix(in srgb, var(--warn) 8%, var(--paper)); padding: 0.55rem 1.25rem; font-size: 0.8rem; }
  .stale-bar strong { color: var(--warn); }
  .stale-bar span { flex: 1; color: var(--muted); }
  .stale-bar button { border-color: color-mix(in srgb, var(--warn) 45%, transparent); color: var(--warn); font-size: 0.76rem; }

  /* 본문 */
  main { position: relative; flex: 1; display: grid; min-height: 0; }
  section { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .panehead { display: flex; gap: 0.8rem; align-items: center; padding: 0 1.1rem; height: 34px; flex: none; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--paper) 92%, transparent); font-size: 0.72rem; }
  .lbl { color: var(--muted); letter-spacing: 0.12em; }
  .status { padding: 0 0.5rem; border: 1px solid var(--line); color: var(--muted); }
  .status.done { border-color: var(--sealed); color: var(--sealed); }
  .status.busy { border-color: var(--draft); color: var(--draft); }
  .status.error { border-color: var(--warn); color: var(--warn); }
  .scroll { flex: 1; overflow: auto; padding: 12px; margin: 0; }
  .pdf .scroll { background: var(--paper-dim); }
  .gutter { cursor: col-resize; background: var(--line); }
  .gutter:hover { background: var(--sealed); }
  .sheet { position: relative; margin: 0 auto; touch-action: none; max-width: 900px; }
  canvas { display: block; width: 100%; box-shadow: 0 1px 8px -2px rgb(0 0 0 / 25%); background: #fff; }
  .bbox { position: absolute; border: 1px solid color-mix(in srgb, var(--sealed) 30%, transparent); background: color-mix(in srgb, var(--sealed) 4%, transparent); cursor: pointer; }
  .bbox.math { border-color: color-mix(in srgb, var(--draft) 55%, transparent); } .bbox.figure { border-color: color-mix(in srgb, var(--fig) 55%, transparent); }
  .bbox.bad { border: 1.5px dashed var(--warn); background: color-mix(in srgb, var(--warn) 7%, transparent); }
  .bbox.hov { background: color-mix(in srgb, var(--sealed) 12%, transparent); border-color: var(--sealed); }
  .bbox.sel { border: 2px solid var(--sealed); background: color-mix(in srgb, var(--sealed) 12%, transparent); }
  .bbox.drag { border: 2px dashed var(--sealed); pointer-events: none; }
  .blocks { padding: 0 0 40vh; }
  .note { display: flex; gap: 8px; align-items: center; justify-content: space-between; padding: 0.55rem 1.1rem; border-bottom: 1px solid var(--line); font-size: 0.8rem; white-space: pre-wrap; }
  .note.busy { background: color-mix(in srgb, var(--draft) 8%, var(--paper)); color: var(--draft); }
  .note.err { background: color-mix(in srgb, var(--warn) 8%, var(--paper)); color: var(--warn); }
  .add { display: block; width: calc(100% - 2.2rem); margin: 0.8rem 1.1rem; border-style: dashed; padding: 0.6rem; }
  .code { font: 12px/1.6 ui-monospace, monospace; white-space: pre-wrap; word-break: break-all; background: #fff; }
  .empty { padding: 3rem; color: var(--muted); text-align: center; line-height: 2.4; }

  /* 오른쪽 패널 — epubeditor BookInfoPanel */
  .panel { display: flex; flex-direction: column; overflow-y: auto; border-left: 1px solid var(--line); background: var(--paper-dim); padding: 1rem; }
  .panel .head { margin-bottom: 0.9rem; color: var(--muted); font-size: 0.72rem; letter-spacing: 0.13em; }
  .panel .lead { margin: 0 0 1rem; color: var(--muted); font-size: 0.76rem; line-height: 1.6; }
  .field { display: block; margin-bottom: 0.9rem; }
  .field > span { display: block; margin-bottom: 0.3rem; font-size: 0.78rem; }
  .field input, .field textarea { width: 100%; padding: 0.45rem 0.5rem; font-size: 0.85rem; }
  .field textarea { font: 12px/1.6 ui-monospace, monospace; resize: vertical; }
  .check { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.9rem; font-size: 0.78rem; }
  .check input { accent-color: var(--sealed); }
  .sect { margin-top: 0.4rem; border-top: 1px solid var(--line); padding-top: 0.9rem; }
  .sect .label { margin-bottom: 0.7rem; color: var(--muted); font-size: 0.72rem; letter-spacing: 0.08em; }
  .sect small { display: block; color: var(--muted); font-size: 0.7rem; line-height: 1.55; }

  footer { display: flex; gap: 14px; align-items: center; padding: 3px 1.25rem; border-top: 1px solid var(--line); font-size: 0.7rem; color: var(--muted); white-space: nowrap; overflow: hidden; }
  footer .link { border: 0; background: none; padding: 0; font-size: inherit; }
  footer .link.bad { color: var(--warn); }
  footer .draft { color: var(--draft); }

  /* 좁은 화면: 패널이 본문 폭을 빼앗지 않도록 위에 띄운다 */
  @media (max-width: 1200px) {
    .panel { position: absolute; top: 0; right: 0; bottom: 0; width: 320px; z-index: 5; box-shadow: -12px 0 28px -18px rgb(0 0 0 / 45%); }
  }

  /* 블록 행 — epubeditor BlockRow: 아래 선, 현재 행은 양 끝 쪽빛 표시선 */
  :global(.block) { position: relative; border-bottom: 1px solid var(--line); padding: 0.75rem 1.1rem; background: var(--paper); cursor: text; }
  :global(.block:not(.selected)) { padding-right: 80px; }
  :global(.block:hover) { background: color-mix(in srgb, var(--sealed) 2%, var(--paper)); }
  :global(.block.selected) { background: color-mix(in srgb, var(--sealed) 3%, var(--paper)); }
  :global(.block.selected::before), :global(.block.selected::after) { content: ''; position: absolute; top: 0; bottom: -1px; width: 3px; background: var(--sealed); }
  :global(.block.selected::before) { left: 0; } :global(.block.selected::after) { right: 0; }
  :global(.block.err) { background: color-mix(in srgb, var(--warn) 4%, var(--paper)); box-shadow: inset 3px 0 0 var(--warn); }
  :global(.block .tag) { position: absolute; top: 0.4rem; right: 0.6rem; color: var(--muted); font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.8; }
  :global(.block.math .tag) { color: var(--draft); } :global(.block.figure .tag) { color: var(--fig); }
  :global(.block .bar) { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; font-size: 0.76rem; }
  :global(.block .bar select), :global(.block .bar input:not([type])) { padding: 0.15rem 0.3rem; font-size: 0.76rem; }
  :global(.block .bar button) { padding: 0.15rem 0.5rem; font-size: 0.74rem; }
  :global(.block .fix) { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  :global(.block .fix .errmsg) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  :global(.block textarea) { width: 100%; font: 13px/1.5 ui-monospace, monospace; padding: 0.4rem 0.5rem; resize: vertical; background: #fff; }
  :global(.block .fmt button.on), :global(.block .fmt button.on:hover:not(:disabled)) { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  :global(.block .color) { display: inline-flex; align-items: center; gap: 2px; } :global(.block .color input) { width: 22px; height: 20px; padding: 0; border: 0; }
  :global(.preview) { font-family: var(--book-font, serif); font-size: 16px; line-height: 1.6; overflow-x: auto; }
  :global(.block.selected .preview) { border-top: 1px dashed var(--line); margin-top: 8px; padding-top: 6px; }
  :global(.preview > *:first-child) { margin-top: 0; } :global(.preview > *:last-child) { margin-bottom: 0; }
  :global(.preview img) { max-width: 100%; }
  :global(.preview .sans) { font-family: sans-serif; } :global(.preview .serif) { font-family: serif; } :global(.preview .mono) { font-family: monospace; }
  :global(.preview .contents), :global(.preview .contents ul) { list-style: none; padding-left: 1.5em; } :global(.preview .contents) { padding-left: 0; }
  :global(.preview figure) { margin: 0; text-align: center; }
  :global(.preview table) { border-collapse: collapse; } :global(.preview td), :global(.preview th) { border: 1px solid #aaa; padding: .2em .4em; }
  :global(.errmsg), :global(.math-error) { color: var(--warn); font-size: 12px; }
</style>
