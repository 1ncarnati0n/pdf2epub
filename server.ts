// 로컬 전용 API 서버: 프로젝트 파일 저장 + codex exec 로 페이지 인식
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = path.resolve('projects')
const PORT = Number(process.env.PORT) || 5174
const CODEX_TIMEOUT_MS = 10 * 60_000

const ID = /^[\w-]+$/
const FILE = /^(source\.pdf|(pages|images)\/[\w.-]+)$/
const TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.pdf': 'application/pdf' }

async function body(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

function codex(cwd: string, model: string, image: string, prompt: string, schema = 'schema.json'): Promise<string> {
  const out = path.join(cwd, `out-${Date.now()}.json`)
  const args = ['exec', '-', '-m', model, '--output-schema', path.resolve(schema), '-o', out,
    '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-i', image]
  return new Promise((resolve, reject) => {
    const p = spawn('codex', args, { cwd, stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => (err += d).length > 8000 && (err = err.slice(-4000)))
    const timer = setTimeout(() => p.kill(), CODEX_TIMEOUT_MS)
    p.on('error', reject)
    p.on('close', async code => {
      clearTimeout(timer)
      try {
        if (code !== 0) throw new Error(`codex exit ${code}: ${err.slice(-1500)}`)
        resolve(await fs.readFile(out, 'utf8'))
      } catch (e) { reject(e) } finally { fs.rm(out, { force: true }) }
    })
    p.stdin.end(prompt)
  })
}

async function recognize(dir: string, n: number, input: { model: string, textLayer: string, context: string, notation: string }) {
  const prompt = [
    await fs.readFile('prompt.md', 'utf8'),
    `## 누적 표기 규칙\n${input.notation || '(없음)'}`,
    `## 직전 페이지 마지막 블록\n${input.context || '(첫 페이지)'}`,
    `## PDF 텍스트 레이어 (참고용)\n${input.textLayer || '(없음: 스캔 이미지)'}`,
  ].join('\n\n')
  const raw = await codex(dir, input.model, path.join(dir, 'pages', `${n}.png`), prompt)
  const json = JSON.parse(raw)
  if (!Array.isArray(json.blocks)) throw new Error('blocks 없음: ' + raw.slice(0, 500))
  return json
}

// temml 파싱 오류가 난 블록을 페이지 이미지를 다시 보고 고쳐 쓰기. tried 로 실패한 시도를 넘겨 다른 방식을 유도
async function fix(dir: string, n: number, input: { model: string, type: string, text: string, errors: string[], bbox: number[], tried: string[] }) {
  const prompt = [
    `첨부 이미지는 PDF 한 페이지다. 영역 bbox=[x,y,w,h] ${JSON.stringify(input.bbox)} (좌상단 기준 0~1)에 있는 ${input.type} 블록을 옮긴 텍스트가 temml(LaTeX→MathML) 파서에서 오류가 났다.`,
    `이미지의 원문을 다시 보고, 같은 내용을 temml 이 파싱할 수 있는 LaTeX 로 다시 써서 text 로 반환하라.`,
    `규칙: amsmath 표준 명령만. \\multicolumn, \\label, \\eqref, array 의 @{} 열 지정, 사용자 정의 매크로 금지. 줄마다 번호가 있으면 align + 줄마다 \\tag.`,
    input.type === 'math' ? `math 블록이므로 구분자(\\[ \\], $$) 없이 수식만.` : `블록 전체 텍스트를 반환하고 인라인 수식은 \\( ... \\) 로 감싼다. 수식이 아닌 글자는 바꾸지 않는다.`,
    `## 현재 텍스트\n${input.text}`,
    `## 오류\n${input.errors.join('\n')}`,
    input.tried.length ? `## 이미 실패한 시도 (다른 방식으로 써라)\n${input.tried.join('\n---\n')}` : '',
  ].join('\n\n')
  return JSON.parse(await codex(dir, input.model, path.join(dir, 'pages', `${n}.png`), prompt, 'fix.schema.json'))
}

http.createServer(async (req, res) => {
  const send = (code: number, data: unknown, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type })
    res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data))
  }
  try {
    const url = new URL(req.url!, 'http://x')
    const [, api, projects, id, kind, ...rest] = url.pathname.split('/')
    if (api !== 'api' || projects !== 'projects') return send(404, { error: 'not found' })

    if (!id) {
      await fs.mkdir(ROOT, { recursive: true })
      const ids = (await fs.readdir(ROOT, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
      const list = await Promise.all(ids.map(async id => {
        const p = JSON.parse(await fs.readFile(path.join(ROOT, id, 'project.json'), 'utf8').catch(() => '{}'))
        return { id, title: p.title ?? id }
      }))
      return send(200, list)
    }
    if (!ID.test(id)) return send(400, { error: 'bad id' })
    const dir = path.join(ROOT, id)

    if (!kind) {
      if (req.method === 'PUT') {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'project.json'), await body(req))
        return send(200, { ok: true })
      }
      return send(200, await fs.readFile(path.join(dir, 'project.json'), 'utf8'))
    }
    if (kind === 'files') {
      const rel = rest.join('/')
      if (!FILE.test(rel)) return send(400, { error: 'bad path' })
      const file = path.join(dir, rel)
      if (req.method === 'PUT') {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, await body(req))
        return send(200, { ok: true })
      }
      return send(200, await fs.readFile(file), TYPES[path.extname(file)] ?? 'application/octet-stream')
    }
    if (kind === 'recognize' && req.method === 'POST') {
      const n = Number(rest[0])
      if (!Number.isInteger(n)) return send(400, { error: 'bad page' })
      return send(200, await recognize(dir, n, JSON.parse((await body(req)).toString())))
    }
    if (kind === 'fix' && req.method === 'POST') {
      const n = Number(rest[0])
      if (!Number.isInteger(n)) return send(400, { error: 'bad page' })
      return send(200, await fix(dir, n, JSON.parse((await body(req)).toString())))
    }
    send(404, { error: 'not found' })
  } catch (e: any) {
    send(e?.code === 'ENOENT' ? 404 : 500, { error: String(e?.message ?? e) })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`api http://127.0.0.1:${PORT}`))
