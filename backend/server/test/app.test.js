/**
 * @codex-vn-doc
 * Tệp: server/test/app.test.js
 * Mục đích: Tệp kiểm thử tự động cho các luồng chính và tình huống biên của module này.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:assert/strict, node:test, ../src/app.js, ../src/db.js, ../src/queue.js, ../src/security.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { StoreDb } from '../src/db.js'
import { GenerationQueue } from '../src/queue.js'
import { hashPassword, hashToken } from '../src/security.js'

// Vai trò lớp MockOllama: gom các trạng thái/hành vi liên quan trong cùng một đối tượng.
class MockOllama {
  constructor(responses = []) {
    this.calls = []
    this.responses = [...responses]
  }
  async check() { return { connected: true, modelPresent: true, models: ['qwen3.5:4b'] } }
  async *chatStream(options) {
    this.calls.push(options)
    const response = this.responses.length ? this.responses.shift() : { text: options.think ? 'Nhận xét định tính.' : 'Xin chào.' }
    if (response.wait) await response.wait
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (response.error) throw response.error
    if (response.text) yield { type: 'delta', content: response.text }
    yield { type: 'terminal', status: response.status || 'complete', doneReason: response.doneReason || 'stop' }
  }
}

// Chức năng cookiePair: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function cookiePair(response) {
  return response.headers.get('set-cookie')?.split(';')[0] || ''
}

// Chức năng ownerFromSupportCookie: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function ownerFromSupportCookie(cookie) {
  const raw = decodeURIComponent(cookie.split('=')[1])
  return 'support:1:' + hashToken(raw)
}

let currentSupportAuth = null
// Chức năng fetchSupport: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function fetchSupport(url, options = {}) {
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (!currentSupportAuth) throw new Error('Support test account is missing')
  const headers = { ...(options.headers || {}) }
  headers.cookie = [currentSupportAuth.cookie, headers.cookie].filter(Boolean).join('; ')
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (options.method === 'POST') headers['x-csrf-token'] = currentSupportAuth.csrfToken
  return fetch(url, { ...options, headers })
}

// Chức năng parseEvents: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function parseEvents(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// Chức năng withServer: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function withServer(run, { ollama = new MockOllama(), queue, seedDemoData = true } = {}) {
  const storeDb = new StoreDb(':memory:', { seedDemoData })
  await storeDb.ready
  const { app } = createApp({
    storeDb,
    ollama,
    generationQueue: queue,
    now: () => new Date('2026-09-18T07:00:00.000Z'),
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  const register = await fetch(baseUrl + '/api/customer/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'support-user', email: 'support@example.com', password: 'support-password-123' }) })
  currentSupportAuth = { cookie: cookiePair(register), csrfToken: (await register.json()).account.csrfToken }
  try { await run({ baseUrl, storeDb, ollama }) }
  finally {
    currentSupportAuth = null
    await new Promise((resolve) => server.close(resolve))
    await storeDb.close()
  }
}

// Chức năng createAdminSession: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function createAdminSession(baseUrl, storeDb, username = 'owner') {
  const credentials = hashPassword('correct-horse-battery-staple')
  await storeDb.createAdmin({ username, passwordSalt: credentials.salt, passwordHash: credentials.hash })
  const login = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'correct-horse-battery-staple' }),
  })
  const body = await login.json()
  return { cookie: cookiePair(login), body }
}

// Kiểm thử edge case: support forces think=false and client cannot choose privileged fields.
test('support forces think=false and client cannot choose privileged fields', async () => {
  await withServer(async ({ baseUrl, ollama }) => {
    const invalid = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Xin chào', think: true }),
    })
    assert.equal(invalid.status, 400)
    const response = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Xin chào', requestId: 'request_support_001' }),
    })
    assert.equal(response.status, 200)
    assert.ok(parseEvents(await response.text()).some((event) => event.type === 'done'))
    assert.equal(ollama.calls[0].think, false)
  })
})

// Kiểm thử edge case: missing policy is backend deterministic and malicious model is never called.
test('missing policy is backend deterministic and malicious model is never called', async () => {
  const ollama = new MockOllama([{ text: 'Đổi miễn phí và hoàn tiền 100%.' }])
  await withServer(async ({ baseUrl }) => {
    const response = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Chính sách đổi trả và hoàn tiền?', requestId: 'request_policy_001' }),
    })
    const events = parseEvents(await response.text())
    assert.ok(events.some((event) => event.type === 'delta' && event.content === 'Store chưa cung cấp thông tin này.'))
    assert.equal(ollama.calls.length, 0)
  }, { ollama })
})

// Kiểm thử edge case: wrong product price from model is blocked while backend price stays verified.
test('wrong product price from model is blocked while backend price stays verified', async () => {
  const ollama = new MockOllama([{ text: 'Tai nghe này chỉ 1 đồng, rất đáng mua.' }])
  await withServer(async ({ baseUrl }) => {
    const response = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Tư vấn tai nghe Everyday', requestId: 'request_product_001' }),
    })
    const events = parseEvents(await response.text())
    const verified = events.find((event) => event.type === 'verified')?.verified
    assert.equal(verified.items[0].price, 890000)
    const published = events.filter((event) => event.type === 'delta').map((event) => event.content).join('')
    assert.doesNotMatch(published, /1 đồng/)
    assert.match(published, /đã bị ẩn/)
  }, { ollama })
})

// Kiểm thử edge case: admin report malicious numbers/time are blocked and report is tied to resolved range.
test('admin report malicious numbers/time are blocked and report is tied to resolved range', async () => {
  const ollama = new MockOllama([{ text: 'Doanh thu tháng trước là 999999 VND.' }])
  await withServer(async ({ baseUrl, storeDb }) => {
    const { cookie, body } = await createAdminSession(baseUrl, storeDb)
    const response = await fetch(baseUrl + '/api/admin/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': body.csrfToken },
      body: JSON.stringify({ message: 'Phân tích doanh thu tháng này', requestId: 'request_admin_report_001' }),
    })
    const events = parseEvents(await response.text())
    const report = events.find((event) => event.type === 'report').report
    assert.equal(report.from, '2026-09-01')
    assert.equal(report.to, '2026-09-18')
    const published = events.filter((event) => event.type === 'delta').map((event) => event.content).join('')
    assert.doesNotMatch(published, /999999|tháng trước/)
    assert.match(published, /đã bị ẩn/)
    assert.equal(ollama.calls.at(-1).think, true)
  }, { ollama })
})

// Kiểm thử edge case: ambiguous report asks for range instead of silently choosing one.
test('ambiguous report asks for range instead of silently choosing one', async () => {
  const ollama = new MockOllama([{ text: 'should not run' }])
  await withServer(async ({ baseUrl, storeDb }) => {
    const { cookie, body } = await createAdminSession(baseUrl, storeDb)
    const response = await fetch(baseUrl + '/api/admin/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': body.csrfToken },
      body: JSON.stringify({ message: 'Cho tôi báo cáo doanh thu gần đây', requestId: 'request_admin_ambiguous' }),
    })
    const text = await response.text()
    assert.match(text, /Bạn muốn báo cáo cho khoảng nào/)
    assert.equal(ollama.calls.length, 0)
  }, { ollama })
})

// Kiểm thử edge case: same requestId replays completed turn without duplicate generation or user message.
test('same requestId replays completed turn without duplicate generation or user message', async () => {
  const ollama = new MockOllama([{ text: 'Một câu trả lời.' }])
  await withServer(async ({ baseUrl, storeDb }) => {
    const requestId = 'request_retry_001'
    const first = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Xin chào', requestId }),
    })
    const cookie = cookiePair(first)
    const events = parseEvents(await first.text())
    const conversationId = events.find((event) => event.type === 'conversation').conversationId
    const second = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'Xin chào', conversationId, requestId }),
    })
    const replay = parseEvents(await second.text())
    assert.equal(replay.find((event) => event.type === 'done').replayed, true)
    assert.equal(ollama.calls.length, 1)
    assert.equal((await storeDb.getMessages(conversationId)).filter((message) => message.role === 'user').length, 1)
  }, { ollama })
})

// Kiểm thử edge case: same conversation rejects concurrent second turn.
test('same conversation rejects concurrent second turn', async () => {
  let releaseModel
  const wait = new Promise((resolve) => { releaseModel = resolve })
  const ollama = new MockOllama([{ wait, text: 'x' }])
  await withServer(async ({ baseUrl }) => {
    const controller = new AbortController()
    const first = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Xin chào', requestId: 'request_concurrent_1' }),
    })
    const cookie = cookiePair(first)
    const reader = first.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let conversationId = ''
    while (!conversationId) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: true })
      for (const line of buffer.split('\n').filter(Boolean)) {
        try { const event = JSON.parse(line); if (event.type === 'conversation') conversationId = event.conversationId } catch { /* partial line; keep reading */ }
      }
    }
    const second = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'Lượt hai', conversationId, requestId: 'request_concurrent_2' }),
    })
    assert.equal(second.status, 409)
    assert.equal((await second.json()).error, 'CONVERSATION_BUSY')
    releaseModel()
    while (!(await reader.read()).done) { /* drain first response */ }
  }, { ollama })
})

// Kiểm thử edge case: queue full and abort while queued do not create turns, next request can proceed.
test('queue full and abort while queued do not create turns, next request can proceed', async () => {
  let releaseModel
  const wait = new Promise((resolve) => { releaseModel = resolve })
  const ollama = new MockOllama([{ wait, text: 'first' }, { text: 'third' }])
  const queue = new GenerationQueue({ concurrency: 1, maxQueued: 1 })
  await withServer(async ({ baseUrl, storeDb }) => {
    const first = fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: 'store_support_id=owner-a' },
      body: JSON.stringify({ message: 'first', requestId: 'request_queue_first' }),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const abortController = new AbortController()
    const queued = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', signal: abortController.signal,
      headers: { 'content-type': 'application/json', cookie: 'store_support_id=owner-b' },
      body: JSON.stringify({ message: 'queued', requestId: 'request_queue_abort' }),
    })

    // Kiểm tra queue-full khi slot chờ vẫn đang bị chiếm.
    const full = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: 'store_support_id=owner-c' },
      body: JSON.stringify({ message: 'full', requestId: 'request_queue_full' }),
    })
    const fullEvents = parseEvents(await full.text())
    assert.equal(fullEvents.at(-1).code, 'QUEUE_FULL')
    assert.equal(await storeDb.getTurn(ownerFromSupportCookie('store_support_id=owner-c'), 'request_queue_full'), null)

    // Sau đó hủy request đang chờ và xác nhận admission chưa ghi turn.
    abortController.abort()
    try { await queued.text() } catch { /* expected client abort */ }
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(await storeDb.getTurn(ownerFromSupportCookie('store_support_id=owner-b'), 'request_queue_abort'), null)

    releaseModel()
    await (await first).text()
    const third = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: 'store_support_id=owner-d' },
      body: JSON.stringify({ message: 'third', requestId: 'request_queue_third' }),
    })
    assert.ok(parseEvents(await third.text()).some((event) => event.type === 'done'))
  }, { ollama, queue })
})

// Kiểm thử edge case: admin CSRF, expiration, no-store and whitespace-normalized login limits.
test('admin CSRF, expiration, no-store and whitespace-normalized login limits', async () => {
  await withServer(async ({ baseUrl, storeDb }) => {
    const { cookie, body } = await createAdminSession(baseUrl, storeDb)
    const settings = await fetch(baseUrl + '/api/admin/settings', { headers: { cookie } })
    assert.match(settings.headers.get('cache-control'), /no-store/)
    const noCsrf = await fetch(baseUrl + '/api/admin/logout', { method: 'POST', headers: { cookie } })
    assert.equal(noCsrf.status, 403)
    const badCsrf = await fetch(baseUrl + '/api/admin/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': 'bad' } })
    assert.equal(badCsrf.status, 403)

    const rawToken = decodeURIComponent(cookie.split('=')[1])
    await storeDb.expireAdminSessionForTest(hashToken(rawToken))
    const expired = await fetch(baseUrl + '/api/admin/settings', { headers: { cookie } })
    assert.equal(expired.status, 401)

    for (let index = 0; index < 5; index += 1) {
      await fetch(baseUrl + '/api/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: index % 2 ? ' missing ' : 'missing', password: 'wrong-password' }),
      })
    }
    const limited = await fetch(baseUrl + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '  missing  ', password: 'wrong-password' }),
    })
    assert.equal(limited.status, 429)
    assert.ok(body.csrfToken)
  })
})

// Kiểm thử edge case: model prose and extra JSON fields cannot publish invented business claims.
test('model prose and extra JSON fields cannot publish invented business claims', async () => {
  const malicious = [
    'Doanh thu đạt một tỷ đồng, tăng gấp đôi so với quý trước.',
    'Store đổi miễn phí và hoàn tiền toàn bộ.',
    JSON.stringify({ responseKey: 'product_summary', text: 'Hoàn tiền toàn bộ.' }),
  ]
  for (const text of malicious) {
    await withServer(async ({ baseUrl }) => {
      const response = await fetchSupport(baseUrl + '/api/support/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Tư vấn tai nghe', requestId: 'contract_bad_request' }),
      })
      const events = parseEvents(await response.text())
      const content = events.filter((item) => item.type === 'delta').map((item) => item.content).join('')
      assert.match(content, /đã bị ẩn/)
      assert.doesNotMatch(content, /một tỷ|đổi miễn phí|Hoàn tiền toàn bộ/)
    }, { ollama: new MockOllama([{ text }]) })
  }
})

// Kiểm thử edge case: verified product metadata survives history reload without duplicate assistant.
test('verified product metadata survives history reload without duplicate assistant', async () => {
  await withServer(async ({ baseUrl, ollama }) => {
    const response = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Tư vấn tai nghe', requestId: 'history_contract_001' }),
    })
    const cookie = cookiePair(response)
    const events = parseEvents(await response.text())
    const id = events.find((item) => item.type === 'conversation').conversationId
    const restored = await (await fetchSupport(baseUrl + '/api/support/conversations/' + id, { headers: { cookie } })).json()
    assert.equal(restored.messages.length, 2)
    assert.equal(restored.messages[1].verified.items[0].price, 890000)
    assert.equal(restored.messages[1].requestId, 'history_contract_001')
    assert.match(restored.messages[1].content, /Các sản phẩm liên quan/)
    assert.ok(ollama.calls[0].format.properties.responseKey.enum.includes('product_summary'))
  }, { ollama: new MockOllama([{ text: '{"responseKey":"product_summary"}' }]) })
})

// Kiểm thử edge case: failed database completion never publishes done or business content.
test('failed database completion never publishes done or business content', async () => {
  await withServer(async ({ baseUrl, storeDb }) => {
    storeDb.completeTurn = async () => false
    const response = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Chính sách đổi trả?', requestId: 'db_failed_completion' }),
    })
    const events = parseEvents(await response.text())
    assert.equal(events.some((item) => item.type === 'done' || item.type === 'delta'), false)
    assert.equal(events.at(-1).type, 'error')
  })
})

// Kiểm thử edge case: admin report history survives reload and contract rejects word-only invented numbers.
test('admin report history survives reload and contract rejects word-only invented numbers', async () => {
  await withServer(async ({ baseUrl, storeDb }) => {
    const { cookie, body } = await createAdminSession(baseUrl, storeDb)
    const response = await fetch(baseUrl + '/api/admin/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': body.csrfToken },
      body: JSON.stringify({ message: 'Doanh thu tháng này', requestId: 'word_report_001' }),
    })
    const events = parseEvents(await response.text())
    const id = events.find((event) => event.type === 'conversation').conversationId
    assert.match(events.find((event) => event.type === 'delta').content, /đã bị ẩn/)
    const history = await (await fetch(baseUrl + '/api/admin/conversations/' + id, { headers: { cookie } })).json()
    assert.equal(history.messages[1].report.from, '2026-09-01')
    assert.equal(history.messages[1].report.netRevenue, 2270000)
    assert.equal(history.messages[1].status, 'complete')
  }, { ollama: new MockOllama([{ text: 'Doanh thu một tỷ đồng và tăng gấp đôi so với quý trước.' }]) })
})

// Kiểm thử edge case: failed turns restore retry metadata and cannot retry behind a newer question.
test('failed turns restore retry metadata and cannot retry behind a newer question', async () => {
  const ollama = new MockOllama([{ error: new Error('offline') }, { text: '{"responseKey":"greeting"}' }])
  await withServer(async ({ baseUrl }) => {
    const first = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Xin chào', requestId: 'failed_history_001' }),
    })
    const cookie = cookiePair(first)
    const events = parseEvents(await first.text())
    const conversationId = events.find((item) => item.type === 'conversation').conversationId
    const history = await (await fetchSupport(baseUrl + '/api/support/conversations/' + conversationId, { headers: { cookie } })).json()
    assert.equal(history.messages[1].status, 'error')
    assert.equal(history.messages[1].requestId, 'failed_history_001')
    assert.equal(history.messages[1].retryContent, 'Xin chào')
    const next = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'Chào bạn', conversationId, requestId: 'newer_history_002' }),
    })
    await next.text()
    const oldRetry = await fetchSupport(baseUrl + '/api/support/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ message: 'Xin chào', conversationId, requestId: 'failed_history_001' }),
    })
    assert.equal(oldRetry.status, 409)
    assert.equal((await oldRetry.json()).error, 'RETRY_SUPERSEDED')
    assert.equal(ollama.calls.length, 2)
  }, { ollama })
})

// Kiểm thử edge case: admin offers feed public catalog and product views without exposing admin writes.
test('admin offers feed public catalog and product views without exposing admin writes', async () => {
  await withServer(async ({ baseUrl, storeDb }) => {
    const id = 'demo-11111111-1111-1111-1111-111111111111'
    await storeDb.upsertCatalogProducts([{
      id, source: 'mock-store-api', sourceId: '11111111-1111-1111-1111-111111111111',
      name: 'Test product', category: 'Điện tử', price: 100000, description: 'Demo',
      image: '/products/imported/test.jpg', features: [], tone: 'blue', symbol: '◈', label: 'Demo',
      sourceUrl: 'https://example.com/test', sourcePriceCents: 400, sourceCurrency: 'USD', importedAt: '2026-09-24T00:00:00.000Z',
    }])
    const { cookie, body } = await createAdminSession(baseUrl, storeDb)
    const offerUrl = baseUrl + '/api/admin/products/' + id + '/offer'
    const invalid = await fetch(offerUrl, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': body.csrfToken }, body: JSON.stringify({ discountPercent: 100, stockCount: 0 }) })
    assert.equal(invalid.status, 400)
    const noCsrf = await fetch(offerUrl, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ discountPercent: 20, stockCount: 0 }) })
    assert.equal(noCsrf.status, 403)
    const saved = await fetch(offerUrl, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': body.csrfToken }, body: JSON.stringify({ discountPercent: 20, stockCount: 0 }) })
    assert.equal(saved.status, 200)
    const viewed = await fetch(baseUrl + '/api/storefront/products/' + id + '/view', { method: 'POST' })
    assert.equal((await viewed.json()).viewCount, 1)
    const publicCatalog = await (await fetch(baseUrl + '/api/storefront/catalog')).json()
    assert.deepEqual(publicCatalog.products.find((item) => item.id === id), { id, discountPercent: 20, stockCount: 0, viewCount: 1, favoriteCount: 0 })
    assert.equal((await fetch(baseUrl + '/api/storefront/products/unknown/view', { method: 'POST' })).status, 404)
    const adminCatalog = await (await fetch(baseUrl + '/api/admin/products', { headers: { cookie } })).json()
    assert.equal(adminCatalog.products.find((item) => item.id === id).discountPercent, 20)
  })
})

// Kiểm thử edge case: admin top-view report is private and ranks viewed products.
test('admin top-view report is private and ranks viewed products', async () => {
  await withServer(async ({ baseUrl, storeDb }) => {
    const unauthenticated = await fetch(baseUrl + '/api/admin/product-views')
    assert.equal(unauthenticated.status, 401)
    const { cookie } = await createAdminSession(baseUrl, storeDb)
    const viewed = await fetch(baseUrl + '/api/storefront/products/1/view', { method: 'POST' })
    assert.equal(viewed.status, 200)
    const response = await fetch(baseUrl + '/api/admin/product-views', { headers: { cookie } })
    assert.equal(response.status, 200)
    const report = await response.json()
    assert.equal(report.products.length, 4)
    assert.equal(report.products[0].id, '1')
    assert.equal(report.products[0].viewCount, 1)
    assert.equal(report.totalViews, 1)
  })
})

