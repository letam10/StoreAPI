import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { StoreDb } from '../backend/server/src/db.js'
import { hashPassword } from '../backend/server/src/security.js'
import { responseContract } from '../backend/server/src/knowledge.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'store-admin-ai-smoke-'))
const data = join(temporary, 'pgdata')
const base = 'http://127.0.0.1:19381'
const password = 'local-smoke-password-2026'
const database = new StoreDb(data, { seedDemoData: false })
await database.ready
const { salt, hash } = hashPassword(password)
await database.createAdmin({ username: 'ai-smoke-admin', passwordSalt: salt, passwordHash: hash })
await database.close()

const host = spawn('dotnet', [
  join(root, 'Store-Admin', 'bin', 'Debug', 'net10.0', 'Store-Admin.dll'),
  '--urls', base,
], {
  cwd: join(root, 'Store-Admin'),
  windowsHide: true,
  env: {
    ...process.env,
    ASPNETCORE_ENVIRONMENT: 'Development',
    Backend__Port: '19382',
    Backend__Environment__PGDATA_PATH: data,
    AiLocal__AutoStart: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
host.stdout.on('data', chunk => { logs += chunk.toString() })
host.stderr.on('data', chunk => { logs += chunk.toString() })

async function ready() {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (host.exitCode !== null) throw new Error('Host không khởi động: ' + logs)
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) })
      if (response.ok) return response.json()
    } catch {
      // Đợi host mở cổng sau khi kiểm tra model và mở dữ liệu tạm.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Host chưa sẵn sàng: ' + logs)
}

async function login(path, body, account) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, path.endsWith('/register') ? 201 : 200)
  const payload = await response.json()
  return {
    cookie: response.headers.getSetCookie()[0].split(';')[0],
    csrf: account ? payload.account.csrfToken : payload.csrfToken,
  }
}

async function chat(kind, session, message = 'Xin chào', requestTag = kind,
  scope = 'general') {
  const response = await fetch(base + '/api/' + kind + '/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    },
    body: JSON.stringify({ message, requestId: 'ai_smoke_' + requestTag }),
    signal: AbortSignal.timeout(130000),
  })
  assert.equal(response.status, 200)
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  const error = events.find(event => event.type === 'error')
  if (error) throw new Error(kind + ': ' + JSON.stringify(error))
  const done = events.find(event => event.type === 'done')
  assert.ok(done && !done.deterministic, 'Phải nhận done từ lượt gọi model thật')
  assert.ok(events.some(event => event.type === 'status'))
  assert.ok(events.some(event => event.type === 'delta'))
  const content = events.filter(event => event.type === 'delta').map(event => event.content).join('')
  assert.ok(Object.values(responseContract(scope).choices).includes(content),
    'Câu trả lời phải qua validator responseKey, không phải thông báo fallback bị ẩn')
  assert.ok(events.every(event => !Object.hasOwn(event, 'thinking')))
  return { kind, scope, model: 'qwen3.5:4b', completed: true, validated: true, rawThinkingExposed: false }
}

const evidence = {}
try {
  evidence.health = await ready()
  assert.equal(evidence.health.ollama, 'ok')
  const customer = await login('/api/customer/register', {
    username: 'ai-smoke-customer', email: 'ai-smoke@example.invalid', password,
  }, true)
  evidence.customer = await chat('support', customer)
  console.log('AI khách qua ASP.NET Core: hoàn tất, không lộ thinking.')
  const admin = await login('/api/admin/login', { username: 'ai-smoke-admin', password }, false)
  evidence.admin = await chat('admin', admin)
  console.log('AI Admin qua ASP.NET Core: hoàn tất, không lộ thinking.')
  evidence.adminProduct = await chat('admin', admin, 'Tư vấn Tai nghe Everyday giúp tôi.', 'admin_product', 'product')
  console.log('AI Admin sản phẩm: hoàn tất.')
  evidence.adminReport = await chat('admin', admin, 'Doanh thu hôm nay', 'admin_report', 'report')
  console.log('AI Admin báo cáo: hoàn tất.')
} finally {
  if (host.exitCode === null) {
    const pipe = connect('\\\\.\\pipe\\StoreAdminHost_' + host.pid)
    pipe.on('error', () => {})
    pipe.on('data', () => {})
    pipe.on('connect', () => pipe.end('shutdown\n'))
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 12000))])
    pipe.destroy()
    if (host.exitCode === null) {
      host.kill()
      await once(host, 'exit')
    }
  }
  evidence.hostExitCode = host.exitCode
  evidence.originalOllamaStillRunning = (await fetch('http://127.0.0.1:11434/api/tags')).ok
  await writeFile(join(root, 'work', 'migration-20261010', 'ai-real-smoke.json'), JSON.stringify(evidence, null, 2))
  if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('store-admin-ai-smoke-')) {
    throw new Error('Đường dẫn dữ liệu kiểm thử không hợp lệ, không xóa.')
  }
  await rm(temporary, { recursive: true, force: true })
}
