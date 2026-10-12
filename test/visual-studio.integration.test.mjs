import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { access } from 'node:fs/promises'
import { StoreDb } from '../backend/server/src/db.js'
import {
  bounded, checkout, fixture, json, listen, login, processAlive, request, textStream, until,
} from './hostTestHelpers.mjs'

const sessions = '/api/customer/payment-sessions'

test('ASP.NET gateway integrates the actual Node backend with an isolated PGlite database', async t => {
  const context = await fixture()
  let admin
  let customer
  let confirmedId
  try {
    await context.start()
    const root = context.root

    await t.test('health, HTTP error payloads, cookies and CSRF survive YARP forwarding', async () => {
      const health = await json(await request(root, '/host/health'))
      assert.equal(health.backend, 'ok')
      assert.equal(health.ai, 'ok')
      assert.equal(health.aiOwnedByHost, false)
      assert.equal((await request(root, '/api/health')).status, 200)
      assert.equal((await json(await request(root, '/api/missing'), 404)).error, 'NOT_FOUND')
      assert.equal((await json(await request(root, '/api/admin/settings'), 401)).error, 'UNAUTHENTICATED')
      const invalid = await fetch(root + '/api/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
      })
      assert.equal((await json(invalid, 400)).error, 'INVALID_JSON')
      admin = await login(root)
      customer = await login(root, true)
      assert.ok((await json(await request(root, '/api/admin/session', admin))).authenticated)
      const settings = '/api/admin/settings'
      const denied = await request(root, settings, { ...admin, csrfToken: '' }, { contextSize: 8192 }, 'PUT')
      assert.equal((await json(denied, 403)).error, 'CSRF_INVALID')
      await json(await request(root, settings, admin, { contextSize: 8192 }, 'PUT'))
      assert.equal((await json(await request(root, settings, admin))).contextSize, 8192)
      const invalidSize = await request(root, settings, admin, { contextSize: 1 }, 'PUT')
      assert.equal((await json(invalidSize, 400)).error, 'INVALID_CONTEXT_SIZE')
      const csrf = await request(root, sessions, { ...customer, csrfToken: '' }, checkout)
      assert.equal((await json(csrf, 403)).error, 'CSRF_INVALID')
    })

    async function orderCount(expected) {
      const customerOrders = await json(await request(root, '/api/customer/orders', customer))
      const adminOrders = await json(await request(root, '/api/admin/customer-orders', admin))
      assert.equal(customerOrders.orders.length, expected)
      assert.equal(adminOrders.orders.length, expected)
    }

    await t.test('QR preview and cancellation create no order or rewards', async () => {
      const preview = await json(await request(root, sessions, customer, checkout), 201)
      assert.equal(preview.sessionId, preview.order.id)
      assert.equal(preview.payment.amount, preview.order.total)
      assert.equal(preview.payment.mode, 'demo')
      assert.ok(preview.payment.qrImage)
      await orderCount(0)
      await json(await request(root, sessions + '/' + preview.sessionId, customer, {}, 'DELETE'))
      const cancelled = await request(root, sessions + '/' + preview.sessionId + '/simulate-pay', customer, {})
      assert.equal(cancelled.status, 404)
      await orderCount(0)
      const account = await json(await request(root, '/api/customer/session', customer))
      assert.equal(account.account.points, 0)
    })

    await t.test('SSE stays open and confirmation creates one order despite duplicate requests', async () => {
      const response = await request(root, '/api/admin/events/stream', admin)
      assert.match(response.headers.get('content-type'), /^text\/event-stream/)
      assert.equal(response.headers.get('x-accel-buffering'), 'no')
      const stream = textStream(response)
      try {
        await stream.until(text => text.includes('event: connected'))
        assert.equal(stream.ended, false)
        const preview = await json(await request(root, sessions, customer, checkout), 201)
        confirmedId = preview.sessionId
        await orderCount(0)
        const path = sessions + '/' + confirmedId + '/simulate-pay'
        const responses = await Promise.all([request(root, path, customer, {}), request(root, path, customer, {})])
        for (const item of responses) assert.equal((await json(item)).order.status, 'paid')
        await stream.until(text => text.includes('event: order:created') && text.includes('event: order:paid'))
        assert.equal(stream.ended, false)
        assert.equal(stream.text.split('event: order:created').length - 1, 1)
        assert.equal(stream.text.split('event: order:paid').length - 1, 1)
        await orderCount(1)
        const receipt = await json(await request(root, '/api/customer/orders/' + confirmedId + '/receipt', customer))
        assert.equal(receipt.order.status, 'paid')
        const account = await json(await request(root, '/api/customer/session', customer))
        assert.equal(account.account.points, receipt.order.pointsEarned)
        assert.equal(account.account.spinCredits, 4)
        assert.equal((await request(root, sessions + '/' + confirmedId, customer, {}, 'DELETE')).status, 409)
      } finally {
        await stream.cancel()
      }
    })

    await t.test('NDJSON status reaches the client while Ollama response is held open', async () => {
      context.stub.mode = 'gated'
      const response = await request(root, '/api/admin/chat', admin, {
        message: 'Xin chào', requestId: 'host_stream_forwarding_001',
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /^application\/x-ndjson/)
      assert.equal(response.headers.get('x-accel-buffering'), 'no')
      const stream = textStream(response)
      try {
        await stream.until(text => text.includes('"type":"conversation"'))
        await until(() => context.stub.pending !== null)
        assert.equal(stream.ended, false)
        assert.ok(!stream.text.includes('"type":"done"'))
        assert.equal(context.stub.calls.at(-1).model, 'qwen3.5:4b')
        assert.equal(context.stub.calls.at(-1).stream, true)
        context.stub.pending.resolve()
        const events = (await stream.finish()).trim().split('\n').map(JSON.parse)
        assert.ok(events.some(event => event.type === 'delta'))
        assert.equal(events.at(-1).type, 'done')
        assert.equal(events.filter(event => event.type === 'error').length, 0)
      } finally {
        context.stub.pending?.resolve()
        await stream.cancel()
      }
    })

    await t.test('upstream early EOF remains an NDJSON error and never a successful completion', async () => {
      context.stub.mode = 'early-eof'
      const response = await request(root, '/api/admin/chat', admin, {
        message: 'Xin chào', requestId: 'host_stream_error_001',
      })
      assert.equal(response.status, 200)
      const events = (await response.text()).trim().split('\n').map(JSON.parse)
      assert.equal(events.at(-1).type, 'error')
      assert.equal(events.at(-1).code, 'OLLAMA_EARLY_EOF')
      assert.equal(events.filter(event => event.type === 'done').length, 0)
      const id = events.find(event => event.type === 'conversation').conversationId
      const history = await json(await request(root, '/api/admin/conversations/' + id, admin))
      assert.equal(history.messages.at(-1).status, 'error')
    })

    await t.test('logout clears the forwarded cookie and invalidates its server session', async () => {
      const response = await request(root, '/api/admin/logout', admin, {})
      await json(response)
      assert.match(response.headers.get('set-cookie'), /Max-Age=0/i)
      assert.equal((await request(root, '/api/admin/settings', admin)).status, 401)
    })

    await t.test('killing the Windows host stops its owned Node and leaves reused AI alive', {
      skip: process.platform !== 'win32',
    }, async () => {
      assert.ok(processAlive(context.nodePid))
      context.host.child.kill('SIGKILL')
      await bounded(context.host.exited)
      await until(() => !processAlive(context.nodePid))
      await assert.rejects(fetch('http://127.0.0.1:' + context.nodePort + '/api/health'))
      assert.equal((await fetch('http://127.0.0.1:' + context.stub.port + '/api/tags')).status, 200)
      // Chỉ mở lại DB sau khi tiến trình sở hữu đã dừng hoàn toàn.
      const db = new StoreDb(context.dataPath)
      try {
        await db.ready
        const orders = await db.query('SELECT id, status FROM customer_orders')
        assert.deepEqual(orders.rows, [{ id: confirmedId, status: 'paid' }])
        const events = await db.query('SELECT COUNT(*) AS count FROM customer_order_events')
        assert.equal(Number(events.rows[0].count), 2)
      } finally {
        await db.close()
      }
    })
  } finally {
    await context.close()
  }
})

test('missing local model fails startup before Node opens the temporary database', async () => {
  const context = await fixture({ seed: false })
  try {
    context.stub.models = []
    const host = await context.start({}, false)
    const [code] = await bounded(host.exited, 15000)
    assert.notEqual(code, 0)
    assert.match(host.output(), /qwen3\.5:4b/)
    await assert.rejects(access(context.dataPath))
    await assert.rejects(fetch('http://127.0.0.1:' + context.nodePort + '/api/health'))
    assert.equal((await fetch('http://127.0.0.1:' + context.stub.port + '/api/tags')).status, 200)
  } finally {
    await context.close()
  }
})

test('occupied private port fails startup without killing the existing listener', async () => {
  const context = await fixture({ seed: false })
  const listener = createServer((_, response) => response.end('port owner is intact'))
  try {
    const port = await listen(listener)
    const host = await context.start({ Backend__Port: String(port) }, false)
    const [code] = await bounded(host.exited, 15000)
    assert.notEqual(code, 0)
    assert.match(host.output(), new RegExp('Node ' + port))
    assert.match(host.output(), /InvalidOperationException/)
    assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'port owner is intact')
    await assert.rejects(access(context.dataPath))
  } finally {
    listener.closeAllConnections()
    await new Promise(resolve => listener.close(resolve))
    await context.close()
  }
})
