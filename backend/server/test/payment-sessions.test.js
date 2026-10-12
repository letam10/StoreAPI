import assert from 'node:assert/strict'
import test from 'node:test'
import { withCommerceServer, customerSession, adminSession, write } from './commerceTestHelpers.js'
import { PAYMENT_WINDOW_MS, registerPaymentSessions } from '../src/paymentSessions.js'

const base = '/api/customer/payment-sessions'
const bank = { mode: 'manual', bankName: 'Ngân hàng kiểm thử', bankBin: '970436',
  accountNumber: '1234567890', accountName: 'STORE TEST' }
const product = { id: 'session-product', source: 'local', name: 'Gạo kiểm thử', category: 'food',
  price: 200000, discountPercent: 0, label: 'Kiểm thử', stockCount: 80, image: '', description: 'Kiểm thử' }
const body = { items: [{ id: product.id, quantity: 2 }], recipient: 'Khách kiểm thử', phone: '0901234567',
  address: '12 Đường kiểm thử', fulfillment: 'delivery', region: 'hcm', weightKg: 1,
  voucherCodes: [], paymentMethod: 'bank_transfer' }

async function read(root, path, session) {
  const response = await fetch(root + path, { headers: { cookie: session.cookie } })
  assert.equal(response.status, 200)
  return response.json()
}

async function setup(root, storeDb) {
  await storeDb.upsertCatalogProducts([product])
  const customer = await customerSession(root)
  const admin = await adminSession(root, storeDb)
  return { customer, admin }
}

async function preview(root, customer, changes = {}) {
  const response = await write(root, base, customer, { ...body, ...changes })
  const result = await response.json()
  assert.equal(response.status, 201, JSON.stringify(result))
  assert.equal(result.sessionId, result.order.id)
  assert.equal(result.payment.amount, result.order.total)
  return result
}

async function assertCount(root, storeDb, customer, admin, expected) {
  const count = (await storeDb.query('SELECT COUNT(*) AS count FROM customer_orders')).rows[0].count
  assert.equal(Number(count), expected)
  assert.equal((await read(root, '/api/customer/orders', customer)).orders.length, expected)
  assert.equal((await read(root, '/api/admin/customer-orders', admin)).orders.length, expected)
}

async function voucherFor(root, customer, admin) {
  const response = await write(root, '/api/admin/customers/' + customer.account.id + '/vouchers', admin,
    { type: 'percent', value: 100, scope: 'shipping', label: 'Miễn phí ship',
      expiresAt: '2026-10-20T00:00:00.000Z' })
  assert.equal(response.status, 201)
  return (await response.json()).voucher
}

test('QR chỉ xem trước: DB và hai danh sách trống, thoát hoặc hết 02:00 vẫn giữ voucher', () =>
  withCommerceServer(async ({ root, storeDb, setNow }) => {
    const { customer, admin } = await setup(root, storeDb)
    const voucher = await voucherFor(root, customer, admin)
    const first = await preview(root, customer, { voucherCodes: [voucher.code] })
    assert.equal(PAYMENT_WINDOW_MS, 120000)
    assert.equal(first.expiresAt, '2026-10-02T02:02:00.000Z')
    await assertCount(root, storeDb, customer, admin, 0)
    assert.equal((await read(root, '/api/customer/vouchers', customer)).vouchers.length, 1)
    assert.equal((await write(root, base + '/' + first.sessionId, customer, {}, 'DELETE')).status, 200)
    assert.equal((await write(root, base + '/' + first.sessionId + '/simulate-pay', customer)).status, 404)
    await assertCount(root, storeDb, customer, admin, 0)
    const second = await preview(root, customer, { voucherCodes: [voucher.code] })
    setNow(second.expiresAt)
    assert.equal((await write(root, base + '/' + second.sessionId + '/simulate-pay', customer)).status, 410)
    const expired = await fetch(root + base + '/' + second.sessionId, { headers: { cookie: customer.cookie } })
    assert.equal(expired.status, 410)
    await assertCount(root, storeDb, customer, admin, 0)
    assert.equal((await read(root, '/api/customer/vouchers', customer)).vouchers[0].code, voucher.code)
    assert.equal((await read(root, '/api/customer/session', customer)).account.points, 0)
  }))

test('xác nhận demo đồng thời chỉ tạo một đơn, tiêu voucher và cộng thưởng đúng một lần', async () => {
  const events = []
  await withCommerceServer(async ({ root, storeDb }) => {
    const { customer, admin } = await setup(root, storeDb)
    const voucher = await voucherFor(root, customer, admin)
    const session = await preview(root, customer, { voucherCodes: [voucher.code] })
    assert.equal(events.length, 0)
    await assertCount(root, storeDb, customer, admin, 0)
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      write(root, base + '/' + session.sessionId + '/simulate-pay', customer)))
    for (const response of results) {
      assert.equal(response.status, 200)
      assert.equal((await response.json()).order.status, 'paid')
    }
    await assertCount(root, storeDb, customer, admin, 1)
    assert.equal((await read(root, '/api/customer/vouchers', customer)).vouchers.length, 0)
    const receipt = await read(root, '/api/customer/orders/' + session.sessionId + '/receipt', customer)
    const account = (await read(root, '/api/customer/session', customer)).account
    assert.equal(account.points, receipt.order.pointsEarned)
    assert.equal(account.spinCredits, Math.floor(receipt.order.goodsTotal / 100000))
    assert.equal(events.filter(item => item === 'order:created').length, 1)
    assert.equal(events.filter(item => item === 'order:paid').length, 1)
    const count = await storeDb.query('SELECT COUNT(*) AS count FROM customer_order_events')
    assert.equal(Number(count.rows[0].count), 2)
    assert.equal((await read(root, base + '/' + session.sessionId, customer)).order.status, 'paid')
    assert.equal((await write(root, base + '/' + session.sessionId, customer, {}, 'DELETE')).status, 409)
  }, { eventBroadcaster: { emit: type => events.push(type) } })
})

test('phiên kiểm tra đăng nhập, chủ sở hữu, CSRF, giá và phương thức trước khi tạo đơn', () =>
  withCommerceServer(async ({ root, storeDb }) => {
    const { customer, admin } = await setup(root, storeDb)
    const other = await customerSession(root, 'other')
    assert.equal((await fetch(root + base, { method: 'POST' })).status, 401)
    assert.equal((await write(root, base, { ...customer, csrfToken: '' }, body)).status, 403)
    assert.equal((await write(root, base, customer, { ...body, paymentMethod: 'cod' })).status, 400)
    assert.equal((await write(root, base, customer, { ...body, expectedTotal: 1 })).status, 409)
    const session = await preview(root, customer)
    const path = base + '/' + session.sessionId
    assert.equal((await fetch(root + path, { headers: { cookie: other.cookie } })).status, 404)
    for (const suffix of ['/simulate-pay', '/payment-report']) {
      assert.equal((await write(root, path + suffix, other, { reference: 'BANK-001' })).status, 404)
      assert.equal((await write(root, path + suffix, { ...customer, csrfToken: '' })).status, 403)
    }
    assert.equal((await write(root, path, other, {}, 'DELETE')).status, 404)
    assert.equal((await write(root, path, { ...customer, csrfToken: '' }, {}, 'DELETE')).status, 403)
    await assertCount(root, storeDb, customer, admin, 0)
  }))

test('reprice trước xác nhận và rollback khi hết giờ giữa transaction giữ nguyên voucher', () =>
  withCommerceServer(async ({ root, storeDb, setNow }) => {
    const { customer, admin } = await setup(root, storeDb)
    const voucher = await voucherFor(root, customer, admin)
    const session = await preview(root, customer, { voucherCodes: [voucher.code] })
    await storeDb.upsertCatalogProducts([{ ...product, price: 210000 }])
    assert.equal((await write(root, base + '/' + session.sessionId + '/simulate-pay', customer)).status, 409)
    await assertCount(root, storeDb, customer, admin, 0)
    assert.equal((await read(root, '/api/customer/vouchers', customer)).vouchers.length, 1)
    await storeDb.upsertCatalogProducts([product])
    const original = storeDb.query.bind(storeDb)
    storeDb.query = async (sql, params) => {
      const result = await original(sql, params)
      if (sql.startsWith("UPDATE customer_orders SET status = 'paid'")) setNow(session.expiresAt)
      return result
    }
    assert.equal((await write(root, base + '/' + session.sessionId + '/simulate-pay', customer)).status, 410)
    await assertCount(root, storeDb, customer, admin, 0)
    assert.equal((await read(root, '/api/customer/vouchers', customer)).vouchers.length, 1)
    assert.equal((await read(root, '/api/customer/session', customer)).account.points, 0)
    assert.equal(Number((await storeDb.query('SELECT COUNT(*) AS count FROM customer_order_events')).rows[0].count), 0)
  }))

test('manual report tạo một đơn pending, chưa cộng điểm khi chưa đối soát', () =>
  withCommerceServer(async ({ root, storeDb }) => {
    const { customer, admin } = await setup(root, storeDb)
    await write(root, '/api/admin/payment-settings', admin, bank, 'PUT')
    const session = await preview(root, customer)
    const path = base + '/' + session.sessionId
    assert.equal((await write(root, path + '/simulate-pay', customer)).status, 403)
    for (const reference of ['', 'ab', 'a'.repeat(101)]) {
      assert.equal((await write(root, path + '/payment-report', customer, { reference })).status, 400)
    }
    await assertCount(root, storeDb, customer, admin, 0)
    const results = await Promise.all([1, 2, 3].map(() =>
      write(root, path + '/payment-report', customer, { reference: 'BANK-001' })))
    for (const result of results) assert.equal(result.status, 200)
    await assertCount(root, storeDb, customer, admin, 1)
    const { order } = await read(root, path, customer)
    assert.equal(order.status, 'pending')
    assert.ok(order.paymentReportedAt)
    assert.equal(order.paymentReference, 'BANK-001')
    assert.equal((await read(root, '/api/customer/session', customer)).account.points, 0)
  }))

test('webhook xử lý trực tiếp phiên QR với khóa, số tiền, callback lặp và phiên bị hủy', async () => {
  const events = []
  const secret = 'session-webhook-test-secret'
  await withCommerceServer(async ({ root, storeDb }) => {
    const { customer, admin } = await setup(root, storeDb)
    await write(root, '/api/admin/payment-settings', admin, bank, 'PUT')
    const session = await preview(root, customer)
    const webhook = (changes = {}, token = secret) => fetch(root + '/api/customer/payments/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ orderId: session.sessionId, amount: session.order.total,
        transactionCode: 'BANK-002', ...changes }),
    })
    assert.equal((await webhook({}, 'wrong')).status, 401)
    assert.equal((await webhook({ amount: session.order.total - 1 })).status, 400)
    assert.equal((await webhook({ transactionCode: '' })).status, 400)
    await assertCount(root, storeDb, customer, admin, 0)
    const results = await Promise.all([webhook(), webhook(),
      write(root, base + '/' + session.sessionId + '/payment-report', customer, { reference: 'BANK-002' })])
    for (const result of results) assert.equal(result.status, 200)
    await assertCount(root, storeDb, customer, admin, 1)
    assert.equal((await read(root, base + '/' + session.sessionId, customer)).order.status, 'paid')
    const account = (await read(root, '/api/customer/session', customer)).account
    assert.ok(account.points > 0)
    assert.equal(account.spinCredits, 4)
    assert.equal(events.filter(type => type === 'order:created').length, 1)
    assert.equal(events.filter(type => type === 'order:paid').length, 1)
    const cancelled = await preview(root, customer)
    await write(root, base + '/' + cancelled.sessionId, customer, {}, 'DELETE')
    assert.equal((await webhook({ orderId: cancelled.sessionId })).status, 404)
    await assertCount(root, storeDb, customer, admin, 1)
  }, { paymentWebhookSecret: secret, eventBroadcaster: { emit: type => events.push(type) } })
})

test('DELETE trong lúc xác nhận chưa commit làm transaction rollback, không phát sự kiện', async () => {
  const handlers = new Map()
  const app = Object.fromEntries(['post', 'get', 'delete'].map(method =>
    [method, (path, ...callbacks) => handlers.set(method + path, callbacks.at(-1))]))
  const previewOrder = { id: 'ST-RACE', customer_id: 1, payment_mode: 'demo', total: 100 }
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const rows = []
  const events = []
  const storeDb = { transaction: async action => {
    const before = rows.length
    try {
      return await action()
    } catch (error) {
      rows.splice(before)
      throw error
    }
  } }
  registerPaymentSessions(app, {
    storeDb, now: () => new Date('2026-10-02T02:00:00.000Z'),
    route: handler => handler, requireCustomer() {}, customerCsrf() {},
    fail: code => { throw new Error(code) }, settings: async () => ({ mode: 'demo' }),
    checkout: { prepare: async () => previewOrder, insert: async row => rows.push(row) },
    publicOrder: row => row, paymentInfo: async () => ({ mode: 'demo' }),
    orderFor: async () => previewOrder,
    markPaid: async () => {
      entered.resolve()
      await release.promise
      return { alreadyPaid: false }
    },
    notifyPaid: () => events.push('paid'), notifyCreated: () => events.push('created'),
  })
  const response = { status() { return this }, json() {} }
  const request = { customer: { id: 1 }, params: { id: previewOrder.id }, body }
  await handlers.get('post' + base)(request, response)
  const payment = handlers.get('post' + base + '/:id/simulate-pay')(request, response)
  const rejected = assert.rejects(payment, /PAYMENT_SESSION_CANCELLED/)
  await entered.promise
  const cancellation = handlers.get('delete' + base + '/:id')(request, response)
  release.resolve()
  await cancellation
  await rejected
  assert.equal(rows.length, 0)
  assert.equal(events.length, 0)
})
