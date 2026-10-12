import assert from 'node:assert/strict'
import test from 'node:test'
import { withCommerceServer, customerSession, adminSession, write } from './commerceTestHelpers.js'
import { calculateAfterSales } from '../src/orderWorkflow.js'
import { renderReceipt } from '../src/receipt.js'

async function read(root, path, session) {
  const response = await fetch(root + path, { headers: { cookie: session.cookie } })
  assert.equal(response.status, 200)
  return response.json()
}
async function createOrder(root, storeDb, customer, changes = {}) {
  await storeDb.upsertCatalogProducts([{ id: 'workflow-product', source: 'local', name: 'Gạo kiểm thử', category: 'food', price: 200000, discountPercent: 0, label: 'Hàng thiết yếu', stockCount: 80, image: '', description: 'Sản phẩm của kiểm thử tự động' }])
  const { rows } = await storeDb.query('SELECT id FROM catalog_products WHERE price > 0 LIMIT 1')
  const response = await write(root, '/api/customer/orders', customer, { items: [{ id: rows[0].id, quantity: 2 }],
    recipient: 'Khách kiểm thử', phone: '0901234567', address: '12 Đường kiểm thử', fulfillment: 'delivery', region: 'hcm',
    weightKg: 1, voucherCodes: [], paymentMethod: 'bank_transfer', scheduledAt: schedule, ...changes })
  const result = await response.json()
  assert.equal(response.status, 201, JSON.stringify(result))
  return result.order
}
const schedule = '2026-10-03T02:00:00.000Z'
const rescheduled = '2026-10-04T02:00:00.000Z'
const realBank = { mode: 'manual', bankName: 'Ngân hàng kiểm thử', bankBin: '970436', accountNumber: '1234567890', accountName: 'STORE TEST' }

test('VietQR trên main dùng chung biên nhận, quyền sở hữu và xác nhận mô phỏng đúng một lần', async () => {
  const events = []
  await withCommerceServer(async ({ root, storeDb }) => {
    const customer = await customerSession(root), other = await customerSession(root, 'other'), admin = await adminSession(root, storeDb)
    const order = await createOrder(root, storeDb, customer)
    const info = await read(root, '/api/customer/orders/' + order.id + '/payment-info', customer)
    assert.equal(info.amount, order.total)
    assert.equal(info.qrCodeUrl, info.payment.qrImage)
    assert.equal(info.transferContent, info.payment.reference)
    assert.equal((await fetch(root + '/api/customer/orders/' + order.id + '/payment-info', { headers: { cookie: other.cookie } })).status, 404)
    const payments = await Promise.all(Array.from({ length: 4 }, () => write(root, '/api/customer/orders/' + order.id + '/simulate-pay', customer)))
    for (const response of payments) assert.equal(response.status, 200)
    const receipt = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
    const account = (await read(root, '/api/customer/session', customer)).account
    assert.equal(receipt.order.status, 'paid')
    assert.equal(receipt.order.paymentConfirmation, 'demo_transfer')
    assert.equal(account.points, receipt.order.pointsEarned)
    assert.equal(events.filter(event => event.type === 'order:created').length, 1)
    assert.equal(events.filter(event => event.type === 'order:paid').length, 1)
    const cash = await createOrder(root, storeDb, customer, { paymentMethod: 'cash', fulfillment: 'pickup', address: '' })
    assert.equal((await write(root, '/api/customer/orders/' + cash.id + '/simulate-pay', customer)).status, 403)
    await write(root, '/api/admin/payment-settings', admin, realBank, 'PUT')
    const manual = await createOrder(root, storeDb, customer)
    assert.equal((await write(root, '/api/customer/orders/' + manual.id + '/simulate-pay', customer)).status, 403)
    assert.equal((await fetch(root + '/api/customer/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: manual.id, amount: manual.total }) })).status, 503)
  }, { paymentWebhookSecret: '', eventBroadcaster: { emit: (type, data) => events.push({ type, data }) } })
})

test('webhook VietQR xác thực khóa và số tiền, cạnh tranh với admin không cộng điểm trùng', async () => {
  const events = [], secret = 'webhook-secret-chi-dung-trong-test'
  await withCommerceServer(async ({ root, storeDb }) => {
    const customer = await customerSession(root), admin = await adminSession(root, storeDb)
    await write(root, '/api/admin/payment-settings', admin, realBank, 'PUT')
    const order = await createOrder(root, storeDb, customer)
    const info = await read(root, '/api/customer/orders/' + order.id + '/payment-info', customer)
    assert.match(info.qrCodeUrl, /970436-1234567890/)
    const webhook = (body, token = secret) => fetch(root + '/api/customer/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ orderId: order.id, amount: order.total, transactionCode: 'BANK-001', ...body }) })
    assert.equal((await webhook({}, 'khong-hop-le')).status, 401)
    for (const amount of [undefined, null, '', 'không phải tiền', -1, 1.5, order.total - 1]) assert.equal((await webhook({ amount })).status, 400)
    assert.equal((await webhook({ transactionCode: '' })).status, 400)
    assert.equal((await read(root, '/api/customer/session', customer)).account.points, 0)
    const results = await Promise.all([webhook({ amount: String(order.total) }), webhook({}), write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin, { reference: 'BANK-001' })])
    for (const response of results) assert.equal(response.status, 200)
    const account = (await read(root, '/api/customer/session', customer)).account
    const receipt = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
    assert.equal(receipt.order.paymentReference, 'BANK-001')
    assert.equal(account.points, receipt.order.pointsEarned)
    assert.equal(account.spinCredits, Math.floor(order.goodsTotal / 100000))
    assert.equal(events.filter(event => event.type === 'order:paid').length, 1)
    const cancelled = await createOrder(root, storeDb, customer)
    await write(root, '/api/customer/orders/' + cancelled.id + '/cancel-unpaid', customer)
    assert.equal((await webhook({ orderId: cancelled.id, amount: cancelled.total })).status, 409)
  }, { paymentWebhookSecret: secret, eventBroadcaster: { emit: (type, data) => events.push({ type, data }) } })
})

test('chuyển khoản phải đối soát; xác nhận đồng thời chỉ cộng điểm và lượt một lần', () => withCommerceServer(async ({ root, storeDb }) => {
  const customer = await customerSession(root), other = await customerSession(root, 'other'), admin = await adminSession(root, storeDb)
  assert.equal((await write(root, '/api/admin/payment-settings', admin, realBank, 'PUT')).status, 200)
  const order = await createOrder(root, storeDb, customer)
  const payment = await read(root, '/api/customer/orders/' + order.id + '/payment', customer)
  assert.equal(payment.payment.amount, order.total)
  assert.match(payment.payment.qrImage, /970436-1234567890/)
  assert.match(payment.payment.qrImage, new RegExp('amount=' + order.total))
  assert.equal((await fetch(root + '/api/customer/orders/' + order.id + '/receipt', { headers: { cookie: other.cookie } })).status, 404)
  assert.equal((await write(root, '/api/customer/orders/' + order.id + '/payment-report', customer, { reference: 'BANK-123' })).status, 200)
  const reported = (await read(root, '/api/customer/orders', customer)).orders.find(item => item.id === order.id)
  assert.ok(reported.paymentReportedAt)
  assert.equal(reported.paymentReference, 'BANK-123')
  assert.equal(reported.status, 'pending')
  assert.equal((await read(root, '/api/customer/session', customer)).account.points, 0)
  assert.equal((await write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin)).status, 400)
  const results = await Promise.all(Array.from({ length: 4 }, () => write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin, { reference: 'BANK-123' })))
  for (const response of results) assert.equal(response.status, 200)
  const account = (await read(root, '/api/customer/session', customer)).account
  const receipt = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
  assert.equal(receipt.order.status, 'paid')
  assert.ok(receipt.order.paidAt)
  const persisted = (await read(root, '/api/customer/orders', customer)).orders.find(item => item.id === order.id)
  assert.equal(persisted.paidAt, receipt.order.paidAt)
  assert.equal(persisted.paymentReportedAt, reported.paymentReportedAt)
  assert.equal(account.points, receipt.order.pointsEarned)
  assert.equal(account.spinCredits, Math.floor(order.goodsTotal / 100000))
  const printed = await fetch(root + '/api/customer/orders/' + order.id + '/receipt?format=html', { headers: { cookie: customer.cookie } })
  assert.equal(printed.status, 200)
  assert.match(await printed.text(), /BIÊN NHẬN THANH TOÁN/)
}))

test('nhận tại cửa hàng cần xác nhận thu tiền; không giao đơn chưa trả tiền', () => withCommerceServer(async ({ root, storeDb }) => {
  const customer = await customerSession(root), admin = await adminSession(root, storeDb)
  const order = await createOrder(root, storeDb, customer, { paymentMethod: 'cash', fulfillment: 'pickup', address: '' })
  assert.equal(order.shippingFee, 0)
  assert.equal((await write(root, '/api/admin/customer-orders/' + order.id + '/fulfillment', admin, { status: 'delivered' }, 'PATCH')).status, 409)
  assert.equal((await write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin)).status, 400)
  assert.equal((await write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin, { counterConfirmed: true })).status, 200)
  assert.equal((await write(root, '/api/admin/customer-orders/' + order.id + '/fulfillment', admin, { status: 'delivered' }, 'PATCH')).status, 200)
  const receipt = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
  assert.equal(receipt.order.paymentConfirmation, 'counter')
  assert.equal(receipt.order.status, 'completed')
  assert.equal((await write(root, '/api/admin/customer-orders/' + order.id + '/fulfillment', admin, { status: 'processing' }, 'PATCH')).status, 409)
}))

test('hoãn lịch báo phí trước; hủy trước giao hoàn tiền một lần; yêu cầu có kiểm tra chủ đơn', () => withCommerceServer(async ({ root, storeDb }) => {
  const customer = await customerSession(root), other = await customerSession(root, 'other'), admin = await adminSession(root, storeDb)
  await write(root, '/api/admin/payment-settings', admin, realBank, 'PUT')
  const order = await createOrder(root, storeDb, customer)
  await write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin, { reference: 'PAID-1' })
  const response = await write(root, '/api/customer/orders/' + order.id + '/after-sales', customer, { kind: 'reschedule', reason: 'Tôi cần đổi ngày nhận hàng', scheduledAt: rescheduled })
  assert.equal(response.status, 201)
  const { request } = await response.json()
  assert.equal(request.status, 'awaiting_confirmation')
  assert.ok(request.quote.breakdown.length)
  assert.equal((await write(root, '/api/customer/after-sales/' + request.id + '/action', other, { action: 'confirm' })).status, 404)
  assert.equal((await write(root, '/api/admin/after-sales/' + request.id + '/action', admin, { action: 'approve' })).status, 409)
  assert.equal((await write(root, '/api/customer/after-sales/' + request.id + '/action', customer, { action: 'confirm' })).status, 200)
  assert.equal((await write(root, '/api/admin/after-sales/' + request.id + '/action', admin, { action: 'approve' })).status, 200)
  if (request.quote.additionalDue > 0) assert.equal((await write(root, '/api/admin/after-sales/' + request.id + '/action', admin, { action: 'fee_paid', reference: 'FEE-1' })).status, 200)
  const updated = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
  assert.equal(updated.order.scheduledAt, rescheduled)
  const cancellation = await write(root, '/api/customer/orders/' + order.id + '/after-sales', customer, { kind: 'cancel', reason: 'Tôi cần hủy trước khi giao' })
  const cancel = (await cancellation.json()).request
  assert.equal(cancellation.status, 201)
  await write(root, '/api/customer/after-sales/' + cancel.id + '/action', customer, { action: 'confirm' })
  const path = '/api/admin/after-sales/' + cancel.id + '/action'
  assert.equal((await write(root, path, admin, { action: 'approve' })).status, 400)
  assert.equal((await write(root, path, admin, { action: 'approve', refundConfirmed: true, refundReference: 'REFUND-1' })).status, 200)
  assert.equal((await write(root, path, admin, { action: 'approve', refundConfirmed: true, refundReference: 'REFUND-1' })).status, 409)
  const result = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
  assert.equal(result.order.status, 'refunded')
  assert.equal(result.order.refundAmount, cancel.quote.refundAmount)
  assert.equal((await read(root, '/api/customer/session', customer)).account.points, 0)
}))

test('phí trả hàng, giới hạn 7 ngày và biên nhận chống chèn HTML', () => {
  const now = new Date('2026-10-02T02:00:00Z')
  const order = { id: 'ST-TEST', status: 'completed', payment_method: 'bank_transfer', delivery_status: 'delivered', goods_total: 200000, shipping_fee: 30000, shipping_base: 30000, total: 230000, fulfillment: 'delivery', delivered_at: now.toISOString(), scheduled_at: now.toISOString() }
  const quote = calculateAfterSales(order, 'return', now)
  assert.equal(quote.feeAmount, 60000)
  assert.equal(quote.refundAmount, 170000)
  assert.throws(() => calculateAfterSales(order, 'return', new Date('2026-10-10T02:00:00Z')))
  const html = renderReceipt({ order: { id: 'ST-X', items: [{ name: '<script>alert(1)</script>', quantity: 1, price: 10 }], recipient: '<img onerror=x>', status: 'pending', total: 10, extraPaid: 0, refundAmount: 0 }, afterSales: [], store: { name: 'Store', address: '' } }, 'customer')
  assert.ok(!html.includes('<script>'))
  assert.match(html, /&lt;img onerror=x&gt;/)
  assert.match(html, /@media print/)
  assert.match(html, /PHIẾU ĐẶT HÀNG/)
  assert.match(html, /<title>Biên nhận ST-X<\/title>/)
  assert.match(html, /In biên nhận \/ Lưu PDF/)
  assert.equal(html.includes('Bill'), false)
  assert.equal(html.includes('In bill'), false)
})


test('trả hàng chỉ hoàn sau kiểm tra hàng; xử lý lặp không hoàn thêm lần nữa', () => withCommerceServer(async ({ root, storeDb }) => {
  const customer = await customerSession(root), admin = await adminSession(root, storeDb)
  await write(root, '/api/admin/payment-settings', admin, realBank, 'PUT')
  const order = await createOrder(root, storeDb, customer)
  await write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin, { reference: 'RETURN-PAID' })
  assert.equal((await write(root, '/api/admin/customer-orders/' + order.id + '/fulfillment', admin, { status: 'delivered' }, 'PATCH')).status, 200)
  const response = await write(root, '/api/customer/orders/' + order.id + '/after-sales', customer, { kind: 'return', reason: 'Tôi muốn trả lại hàng đã nhận' })
  assert.equal(response.status, 201)
  const { request } = await response.json()
  assert.equal(request.quote.feeAmount, 60000)
  assert.equal(request.quote.refundAmount, order.total - 60000)
  await write(root, '/api/customer/after-sales/' + request.id + '/action', customer, { action: 'confirm' })
  const path = '/api/admin/after-sales/' + request.id + '/action'
  assert.equal((await write(root, path, admin, { action: 'approve' })).status, 200)
  assert.equal((await write(root, path, admin, { action: 'complete_return', refundConfirmed: true, refundReference: 'RETURN-REFUND' })).status, 400)
  assert.equal((await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)).order.refundAmount, 0)
  assert.equal((await write(root, path, admin, { action: 'complete_return', received: true, refundConfirmed: true, refundReference: 'RETURN-REFUND' })).status, 200)
  assert.equal((await write(root, path, admin, { action: 'complete_return', received: true, refundConfirmed: true, refundReference: 'RETURN-REFUND' })).status, 409)
  const result = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
  assert.equal(result.order.status, 'refunded')
  assert.equal(result.order.refundAmount, order.total - 60000)
  assert.equal(result.afterSales[0].refundReference, 'RETURN-REFUND')
}))


test('hủy đơn chưa thu tiền khôi phục voucher và không tạo điểm hay hoàn tiền', () => withCommerceServer(async ({ root, storeDb }) => {
  const customer = await customerSession(root), admin = await adminSession(root, storeDb)
  const issued = await write(root, '/api/admin/customers/' + customer.account.id + '/vouchers', admin, { type: 'percent', value: 100, scope: 'shipping', label: 'Miễn phí ship', expiresAt: new Date(Date.now() + 864000000).toISOString() })
  assert.equal(issued.status, 201)
  const voucher = (await issued.json()).voucher
  const order = await createOrder(root, storeDb, customer, { voucherCodes: [voucher.code] })
  assert.equal(order.shippingFee, 0)
  assert.equal((await read(root, '/api/customer/vouchers', customer)).vouchers.length, 0)
  assert.equal((await write(root, '/api/customer/orders/' + order.id + '/cancel-unpaid', customer)).status, 200)
  const restored = (await read(root, '/api/customer/vouchers', customer)).vouchers
  assert.equal(restored.length, 1)
  assert.equal(restored[0].code, voucher.code)
  assert.equal((await write(root, '/api/customer/orders/' + order.id + '/cancel-unpaid', customer)).status, 409)
  const result = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
  assert.equal(result.order.status, 'cancelled')
  assert.equal(result.order.refundAmount, 0)
  assert.equal((await read(root, '/api/customer/session', customer)).account.points, 0)
}))

test('khách trả tại quầy vẫn quản lý hủy trực tuyến với phí được xác nhận trước', () => withCommerceServer(async ({ root, storeDb }) => {
  const customer = await customerSession(root), admin = await adminSession(root, storeDb)
  await write(root, '/api/admin/payment-settings', admin, realBank, 'PUT')
  const order = await createOrder(root, storeDb, customer, { paymentMethod: 'cash', fulfillment: 'pickup', address: '' })
  await write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin, { counterConfirmed: true })
  const response = await write(root, '/api/customer/orders/' + order.id + '/after-sales', customer, { kind: 'cancel', reason: 'Tôi cần hủy trước khi nhận hàng' })
  assert.equal(response.status, 201)
  const { request } = await response.json()
  assert.equal(request.quote.feeAmount, Math.round(order.goodsTotal * 0.01))
  await write(root, '/api/customer/after-sales/' + request.id + '/action', customer, { action: 'confirm' })
  assert.equal((await write(root, '/api/admin/after-sales/' + request.id + '/action', admin, { action: 'approve', refundConfirmed: true, refundReference: 'CASH-REFUND' })).status, 200)
  assert.equal((await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)).order.refundAmount, request.quote.refundAmount)
}))

test('lỡ lịch báo phí ship mới; ghi nhận thu phí không cộng lại điểm hoặc lượt', () => withCommerceServer(async ({ root, storeDb }) => {
  const customer = await customerSession(root), admin = await adminSession(root, storeDb)
  await write(root, '/api/admin/payment-settings', admin, realBank, 'PUT')
  const order = await createOrder(root, storeDb, customer)
  await write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin, { reference: 'MISSED-PAID' })
  const before = (await read(root, '/api/customer/session', customer)).account
  await storeDb.query('UPDATE customer_orders SET scheduled_at = $1 WHERE id = $2', ['2026-10-02T01:00:00.000Z',order.id])
  const response = await write(root, '/api/customer/orders/' + order.id + '/after-sales', customer, { kind: 'reschedule', reason: 'Tôi đã lỡ lịch và muốn nhận lại', scheduledAt: rescheduled })
  assert.equal(response.status, 201)
  const { request } = await response.json()
  assert.ok(request.quote.additionalDue > 0)
  await write(root, '/api/customer/after-sales/' + request.id + '/action', customer, { action: 'confirm' })
  const path = '/api/admin/after-sales/' + request.id + '/action'
  assert.equal((await write(root, path, admin, { action: 'approve' })).status, 200)
  const payment = (await read(root, '/api/customer/after-sales/' + request.id + '/payment', customer)).payment
  assert.equal(payment.amount, request.quote.additionalDue)
  assert.equal((await write(root, path, admin, { action: 'fee_paid' })).status, 400)
  assert.equal((await write(root, path, admin, { action: 'fee_paid', reference: 'MISSED-FEE' })).status, 200)
  assert.equal((await write(root, path, admin, { action: 'fee_paid', reference: 'MISSED-FEE' })).status, 409)
  const result = await read(root, '/api/customer/orders/' + order.id + '/receipt', customer)
  assert.equal(result.order.scheduledAt, rescheduled)
  assert.equal(result.order.extraPaid, request.quote.additionalDue)
  const after = (await read(root, '/api/customer/session', customer)).account
  assert.equal(after.points, before.points)
  assert.equal(after.spinCredits, before.spinCredits)
}))


test('phí của đơn thu tiền khi nhận không được tự xác nhận qua thanh toán thử', () => withCommerceServer(async ({ root, storeDb }) => {
  const customer = await customerSession(root), admin = await adminSession(root, storeDb)
  const order = await createOrder(root, storeDb, customer, { paymentMethod: 'cod', fulfillment: 'delivery' })
  assert.equal((await write(root, '/api/admin/customer-orders/' + order.id + '/paid', admin, { receivedConfirmed: true })).status, 200)
  await storeDb.query('UPDATE customer_orders SET scheduled_at = $1 WHERE id = $2', ['2026-10-02T01:00:00.000Z', order.id])
  const response = await write(root, '/api/customer/orders/' + order.id + '/after-sales', customer, { kind: 'reschedule', reason: 'Không đến cửa hàng kịp giờ nhận', scheduledAt: rescheduled })
  const { request } = await response.json()
  assert.equal(response.status, 201)
  await write(root, '/api/customer/after-sales/' + request.id + '/action', customer, { action: 'confirm' })
  const path = '/api/admin/after-sales/' + request.id + '/action'
  assert.equal((await write(root, path, admin, { action: 'approve' })).status, 200)
  const { payment } = await read(root, '/api/customer/after-sales/' + request.id + '/payment', customer)
  assert.equal(payment.mode, 'counter')
  assert.equal(payment.qrImage, null)
  assert.equal((await write(root, '/api/customer/after-sales/' + request.id + '/demo-paid', customer, {})).status, 403)
  assert.equal((await write(root, path, admin, { action: 'fee_paid', reference: 'COUNTER-FEE' })).status, 400)
  assert.equal((await write(root, path, admin, { action: 'fee_paid', reference: 'COUNTER-FEE', counterConfirmed: true })).status, 200)
}))
