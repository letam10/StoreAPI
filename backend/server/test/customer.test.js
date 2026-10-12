/**
 * @codex-vn-doc
 * Tệp: server/test/customer.test.js
 * Mục đích: Tệp kiểm thử tự động cho các luồng chính và tình huống biên của module này.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:assert/strict, node:fs, node:os, node:path, node:test, ../src/app.js, ../src/customer.js, ../src/db.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { tierForPoints, shippingFee, rewardPrizes, pointsForPaidGoods } from '../src/customer.js'
import { StoreDb } from '../src/db.js'
import { hashPassword } from '../src/security.js'

// Chức năng harness: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function harness(run) {
  const dir = mkdtempSync(join(tmpdir(), 'store-customer-test-'))
  const storeDb = new StoreDb(join(dir, 'test.pgdata'))
  await storeDb.ready
  const { app } = createApp({ storeDb, now: () => new Date('2026-09-24T10:00:00.000Z') })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const root = 'http://127.0.0.1:' + server.address().port
  try { await run({ root, storeDb }) }
  finally {
    await new Promise((resolve) => server.close(resolve))
    await storeDb.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// Chức năng cookies: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function cookies(response) { return response.headers.get('set-cookie')?.split(';')[0] || '' }
// Chức năng write: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function write(root, path, cookie, csrf, body, method = 'POST') {
  return fetch(root + path, { method, headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) })
}

// Kiểm thử edge case: membership thresholds, shipping bands and wheel weights are exact.
test('membership thresholds, shipping bands and wheel weights are exact', () => {
  assert.deepEqual([0, 99, 100, 999, 1000, 9999, 10000].map(tierForPoints),
    ['bronze', 'bronze', 'silver', 'silver', 'gold', 'gold', 'diamond'])
  assert.equal(shippingFee({ region: 'binh-duong' }, 'bronze'), 30000)
  assert.equal(shippingFee({ region: 'ba-ria-vung-tau' }, 'gold'), 30000)
  assert.equal(shippingFee({ region: 'nearby' }, 'silver'), 60000)
  assert.equal(shippingFee({ region: 'far', distanceKm: 20 }, 'silver'), 80000)
  assert.equal(shippingFee({ region: 'far', distanceKm: 20 }, 'diamond'), 80000)
  assert.equal(shippingFee({ region: 'province:hanoi' }), 60000)
  assert.equal(shippingFee({ region: 'international', weightKg: 1 }), 200000)
  assert.equal(shippingFee({ region: 'international', weightKg: 5 }), 400000)
  assert.equal(shippingFee({ region: 'international', weightKg: 5.1 }), 800000)
  assert.throws(() => shippingFee({ region: 'international', weightKg: 0 }), /INVALID_DELIVERY_REGION/)
  assert.throws(() => shippingFee({ region: 'hanoi' }), /INVALID_DELIVERY_REGION/)
  assert.deepEqual(rewardPrizes().reduce((counts, prize) => ({ ...counts, [prize.kind]: (counts[prize.kind] || 0) + 1 }), {}),
    { none: 6, amount: 3, percent: 1 })
  assert.equal(pointsForPaidGoods(999, 'bronze'), 0)
  assert.equal(pointsForPaidGoods(1999, 'bronze'), 1)
  assert.equal(pointsForPaidGoods(5000, 'gold'), 6)
  assert.equal(pointsForPaidGoods(5000, 'diamond'), 7)
})

// Kiểm thử edge case: customer rewards require recorded payment, accumulate exact points and consume vouchers once.
test('customer rewards require recorded payment, accumulate exact points and consume vouchers once', async () => {
  await harness(async ({ root, storeDb }) => {
    const guestChat = await fetch(root + '/api/support/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Xin chào', requestId: 'request_guest_001' }) })
    assert.equal(guestChat.status, 401)
    const register = await fetch(root + '/api/customer/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Tam', email: 'tam@example.com', password: 'very-secure-password' }) })
    assert.equal(register.status, 201)
    const cookie = cookies(register)
    const account = (await register.json()).account
    assert.equal((await fetch(root + '/api/customer/favorites')).status, 401)
    assert.equal((await write(root, '/api/customer/favorites/1', cookie, '', {}, 'PUT')).status, 403)
    assert.equal((await write(root, '/api/customer/favorites/1', cookie, account.csrfToken, {}, 'PUT')).status, 200)
    const review = await write(root, '/api/storefront/products/1/reviews', cookie, account.csrfToken, { rating: 5, comment: 'Sản phẩm rất tốt' })
    assert.equal(review.status, 200)
    const adminPassword = hashPassword('correct-horse-battery-staple')
    await storeDb.createAdmin({ username: 'owner', passwordSalt: adminPassword.salt, passwordHash: adminPassword.hash })
    const login = await fetch(root + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct-horse-battery-staple' }),
    })
    const adminCookie = cookies(login)
    const admin = await login.json()
    const issue = await write(root, '/api/admin/customers/' + account.id + '/vouchers', adminCookie, admin.csrfToken,
      { type: 'amount', value: 100000, expiresAt: '2026-10-24T10:00:00.000Z' })
    assert.equal(issue.status, 201)
    const code = (await issue.json()).voucher.code
    assert.match(code, /^[A-Z2-9]{10}$/)
    const second = await write(root, '/api/admin/customers/' + account.id + '/vouchers', adminCookie, admin.csrfToken,
      { type: 'percent', value: 20, expiresAt: '2026-10-24T10:00:00.000Z' })
    const secondCode = (await second.json()).voucher.code
    assert.notEqual(secondCode, code)
    const body = { items: [{ id: 1, quantity: 1 }], fulfillment: 'delivery', region: 'hcm', voucherCodes: [code, secondCode],
      recipient: 'Tam', phone: '0901234567', address: '123 Nguyễn Huệ, Quận 1' }
    const quote = await write(root, '/api/customer/quote', cookie, account.csrfToken, body)
    assert.equal(quote.status, 200)
    assert.deepEqual(((await quote.json()).total), 662000)
    const created = await write(root, '/api/customer/orders', cookie, account.csrfToken, body)
    assert.equal(created.status, 201)
    const order = (await created.json()).order
    assert.equal(order.goodsTotal, 632000)
    assert.equal((await (await fetch(root + '/api/customer/session', { headers: { cookie } })).json()).account.points, 0)
    assert.equal((await write(root, '/api/customer/quote', cookie, account.csrfToken, body)).status, 400)
    assert.deepEqual((await (await fetch(root + '/api/customer/vouchers', { headers: { cookie } })).json()).vouchers, [])
    const paid = await write(root, '/api/admin/customer-orders/' + order.id + '/paid', adminCookie, admin.csrfToken, { receivedConfirmed: true })
    assert.deepEqual(await paid.json(), { alreadyPaid: false, pointsEarned: 632, spinCreditsAdded: 6 })
    assert.equal((await (await fetch(root + '/api/customer/session', { headers: { cookie } })).json()).account.tier, 'silver')
    const again = await write(root, '/api/admin/customer-orders/' + order.id + '/paid', adminCookie, admin.csrfToken, { receivedConfirmed: true })
    assert.equal((await again.json()).alreadyPaid, true)
    assert.equal((await (await fetch(root + '/api/customer/session', { headers: { cookie } })).json()).account.points, 632)
    const favorites = await (await fetch(root + '/api/admin/favorites', { headers: { cookie: adminCookie } })).json()
    assert.equal(favorites.favorites[0].count, 1)
    const reviews = await (await fetch(root + '/api/admin/reviews', { headers: { cookie: adminCookie } })).json()
    assert.equal(reviews.reviews[0].comment, 'Sản phẩm rất tốt')
    assert.equal((await write(root, '/api/admin/reviews/' + reviews.reviews[0].id + '/reply', adminCookie, admin.csrfToken, { reply: 'Cảm ơn bạn.' }, 'PATCH')).status, 200)
    const publicReviews = await (await fetch(root + '/api/storefront/products/1/reviews')).json()
    assert.equal(publicReviews.reviews[0].adminReply, 'Cảm ơn bạn.')
    const large = await write(root, '/api/admin/customers/' + account.id + '/vouchers', adminCookie, admin.csrfToken,
      { type: 'amount', value: 1000000, expiresAt: '2026-10-24T10:00:00.000Z' })
    const largeCode = (await large.json()).voucher.code
    const zeroQuote = await write(root, '/api/customer/quote', cookie, account.csrfToken, { ...body, voucherCodes: [largeCode] })
    assert.equal((await zeroQuote.json()).goodsTotal, 0)
  })
})
