import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { StoreDb } from '../backend/server/src/db.js'
import { hashPassword } from '../backend/server/src/security.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
export const credentials = { username: 'host-test-owner', password: 'isolated-host-test-password' }
export const product = {
  id: 'host-test-rice', source: 'local', name: 'Gạo kiểm thử', category: 'food', price: 200000,
  discountPercent: 0, label: 'Kiểm thử', stockCount: 80, image: '', description: 'Kiểm thử host',
}
export const checkout = {
  items: [{ id: product.id, quantity: 2 }], recipient: 'Khách kiểm thử', phone: '0901234567',
  address: '12 Đường kiểm thử', fulfillment: 'delivery', region: 'hcm', weightKg: 1,
  voucherCodes: [], paymentMethod: 'bank_transfer',
}

export async function bounded(promise, ms = 10000, message = 'Operation timed out') {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

export async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

export async function until(check, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  throw new Error('Expected state did not arrive before timeout')
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function ownedNodePid(hostPid) {
  assert.equal(process.platform, 'win32')
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${Number(hostPid)}"` +
    ' | Where-Object Name -eq "node.exe" | Select-Object -ExpandProperty ProcessId'
  const result = await execute('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })
  const pids = result.stdout.trim().split(/\s+/).filter(Boolean).map(Number)
  assert.equal(pids.length, 1, 'Host must own exactly one Node process')
  return pids[0]
}

export function startHost(dataPath, port, nodePort, aiPort, overrides = {}) {
  const env = {
    ...process.env, ASPNETCORE_ENVIRONMENT: 'Development',
    Backend__Port: String(nodePort), Backend__NodeExecutable: process.execPath,
    Backend__Environment__PGDATA_PATH: dataPath, Backend__Environment__DATABASE_URL: '',
    Backend__Environment__PGHOST: '', Backend__Environment__PGUSER: '',
    Backend__Environment__PGDATABASE: '', Backend__Environment__ENABLE_DEMO_DATA: 'false',
    Backend__Environment__OLLAMA_URL: 'http://127.0.0.1:' + aiPort,
    Backend__Environment__OLLAMA_MODEL: 'qwen3.5:4b', AiLocal__AutoStart: 'false',
    Backend__Environment__COOKIE_SECURE: 'false', Backend__Environment__PAYMENT_WEBHOOK_SECRET: '',
    Backend__StartupTimeoutSeconds: '30', ...overrides,
  }
  const child = spawn('dotnet', [join(root, 'Store-Admin/bin/Debug/net10.0/Store-Admin.dll'),
    '--contentRoot', join(root, 'Store-Admin'), '--urls', 'http://127.0.0.1:' + port], {
    cwd: join(root, 'Store-Admin'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000) })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-16000) })
  const exited = once(child, 'exit')
  return { child, exited, output: () => output }
}

async function createStub() {
  const stub = { models: [{ name: 'qwen3.5:4b' }], calls: [], mode: 'complete', pending: null }
  const server = createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ models: stub.models }))
      return
    }
    if (req.url !== '/api/chat') {
      res.writeHead(404).end()
      return
    }
    let input = ''
    for await (const chunk of req) input += chunk
    const body = JSON.parse(input)
    stub.calls.push(body)
    res.setHeader('content-type', 'application/x-ndjson')
    const responseKey = body.format?.properties?.responseKey?.enum?.[0]
    const content = responseKey ? JSON.stringify({ responseKey }) : 'Xin chào.'
    res.write(JSON.stringify({ done: false, message: { role: 'assistant', content } }) + '\n')
    // Giữ upstream mở để chứng minh status NDJSON đã đi qua gateway trước khi hoàn tất.
    if (stub.mode === 'gated') {
      stub.pending = Promise.withResolvers()
      await stub.pending.promise
    }
    if (stub.mode !== 'early-eof') res.write(JSON.stringify({ done: true, done_reason: 'stop' }) + '\n')
    res.end()
  })
  stub.port = await listen(server)
  stub.close = async () => {
    stub.pending?.resolve()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  return stub
}

export async function fixture({ seed = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'store-host-integration-'))
  const dataPath = join(directory, 'pgdata')
  let host
  let stub
  let nodePid
  const close = async () => {
    if (host && host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL')
    if (host) await bounded(host.exited).catch(() => {})
    if (nodePid && processAlive(nodePid)) {
      await until(() => !processAlive(nodePid), 5000).catch(() => process.kill(nodePid, 'SIGKILL'))
    }
    if (stub) await stub.close()
    const insideTemp = relative(resolve(tmpdir()), resolve(directory))
    assert.ok(insideTemp.startsWith('store-host-integration-') && !insideTemp.includes(sep))
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  try {
    if (seed) {
      const db = new StoreDb(dataPath)
      try {
        await db.ready
        const { salt, hash } = hashPassword(credentials.password)
        await db.createAdmin({ username: credentials.username, passwordSalt: salt, passwordHash: hash })
        await db.upsertCatalogProducts([product])
      } finally {
        await db.close()
      }
    }
    stub = await createStub()
    const port = await freePort()
    let nodePort = await freePort()
    while (nodePort === port) nodePort = await freePort()
    const instance = {
      directory, dataPath, stub, port, nodePort, root: 'http://127.0.0.1:' + port, close,
      get host() { return host },
      async start(overrides = {}, ready = true) {
        host = startHost(dataPath, port, nodePort, stub.port, overrides)
        if (!ready) return host
        await until(async () => {
          if (host.child.exitCode !== null || host.child.signalCode !== null) {
            throw new Error('Host failed to start: ' + host.output())
          }
          try {
            return (await fetch(instance.root + '/host/health', { signal: AbortSignal.timeout(500) })).ok
          } catch {
            return false
          }
        }, 45000)
        if (process.platform === 'win32') nodePid = await ownedNodePid(host.child.pid)
        return host
      },
      get nodePid() { return nodePid },
    }
    return instance
  } catch (error) {
    await close()
    throw error
  }
}

export function request(root, path, session = {}, body, method = body === undefined ? 'GET' : 'POST') {
  return fetch(root + path, {
    method, headers: { cookie: session.cookie || '', 'x-csrf-token': session.csrfToken || '',
      'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  })
}

export async function json(response, status = 200) {
  const value = await response.json()
  assert.equal(response.status, status, 'Unexpected HTTP status')
  return value
}

export async function login(root, customer = false) {
  const path = customer ? '/api/customer/register' : '/api/admin/login'
  const body = customer ? { ...credentials, email: 'host-test@example.invalid' } : credentials
  const response = await request(root, path, {}, body)
  const payload = await json(response, customer ? 201 : 200)
  const cookie = response.headers.get('set-cookie')
  assert.ok(/HttpOnly/i.test(cookie), 'Session cookie must remain HttpOnly')
  assert.ok(/SameSite=Strict/i.test(cookie), 'Session cookie must remain SameSite Strict')
  assert.ok(/Path=\//i.test(cookie), 'Session cookie must keep its root path')
  return { cookie: cookie.split(';')[0], csrfToken: customer ? payload.account.csrfToken : payload.csrfToken }
}

export function textStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let ended = false
  return {
    get text() { return text },
    get ended() { return ended },
    async until(predicate) {
      while (!predicate(text) && !ended) {
        const chunk = await bounded(reader.read(), 10000, 'Stream was buffered or stalled')
        ended = chunk.done
        text += chunk.value ? decoder.decode(chunk.value, { stream: true }) : ''
      }
      assert.ok(predicate(text), 'Stream ended before expected event')
      return text
    },
    async finish() {
      await this.until(() => ended)
      return text
    },
    async cancel() { await reader.cancel().catch(() => {}) },
  }
}
