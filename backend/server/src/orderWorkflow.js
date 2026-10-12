import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import QRCode from 'qrcode'
import { renderReceipt } from './receipt.js'
import { checkoutOrderData } from './checkoutOrderData.js'
import { registerPaymentSessions } from './paymentSessions.js'

const DAY = 86400000
export const AFTER_SALES_POLICY = Object.freeze({ cancellationPercent: 1, returnDays: 7, rescheduleDays: 7,
  returnShippingRefunded: false, faultCompensationMin: 2, faultCompensationMax: 3 })
const DEMO_PAYMENT = Object.freeze({ mode: 'demo', bankName: 'NGÂN HÀNG MÔ PHỎNG', bankBin: '000000',
  accountNumber: '0000000000', accountName: 'STORE KIEM THU' })
const closedCases = ['resolved', 'rejected', 'cancelled']
const messages = {
  PAYMENT_SESSION_NOT_FOUND: 'Không tìm thấy phiên thanh toán.',
  PAYMENT_SESSION_CANCELLED: 'Phiên thanh toán đã bị hủy.',
  PAYMENT_SESSION_EXPIRED: 'Phiên thanh toán đã hết hạn. Vui lòng thử lại.',
  ORDER_NOT_FOUND: 'Không tìm thấy đơn hàng.', CASE_NOT_FOUND: 'Không tìm thấy yêu cầu.',
  INVALID_ORDER: 'Thông tin đơn hàng chưa hợp lệ.', PRODUCT_UNAVAILABLE: 'Sản phẩm không còn đủ hàng.', INVALID_VOUCHER: 'Voucher không còn áp dụng được.',
  INVALID_SCHEDULE: 'Chọn thời gian giao hoặc nhận hợp lệ trong tương lai.', QUOTE_CHANGED: 'Giá đơn đã thay đổi. Vui lòng kiểm tra lại tổng tiền.',
  PAYMENT_REQUIRED: 'Đơn phải được xác nhận thanh toán trước.', PAYMENT_REFERENCE_REQUIRED: 'Cần nhập mã giao dịch đã đối soát.',
  ACTION_NOT_ALLOWED: 'Trạng thái hiện tại không cho phép thao tác này.', DEMO_ONLY: 'Chức năng này chỉ dành cho thanh toán thử nghiệm.',
  ONLINE_PAYMENT_REQUIRED: 'Đơn thanh toán trực tiếp cần được xử lý tại cửa hàng.', RETURN_WINDOW_EXPIRED: 'Đã quá hạn gửi yêu cầu trả hàng 7 ngày.',
  DELIVERY_REQUIRED: 'Chỉ yêu cầu trả hàng sau khi đã nhận hàng.', ALREADY_SHIPPED: 'Đơn đã chuyển giao, không thể hủy theo diện chưa giao.',
  CASE_ALREADY_OPEN: 'Đơn đang có một yêu cầu cần xử lý.', RESCHEDULE_WINDOW_EXPIRED: 'Lịch mới phải trong vòng 7 ngày kể từ lịch hẹn cũ.',
  INVALID_REASON: 'Nhập lý do từ 5 đến 1.000 ký tự.', RETURN_NOT_RECEIVED: 'Cần xác nhận đã nhận lại hàng trước khi hoàn tiền.',
  REFUND_REFERENCE_REQUIRED: 'Cần xác nhận chuyển tiền hoàn và nhập mã giao dịch.', CASE_PENDING: 'Đơn đang có yêu cầu sau bán hàng cần xử lý.',
  COUNTER_CONFIRMATION_REQUIRED: 'Cần xác nhận đã thu tiền trực tiếp tại quầy.', DELIVERY_PAYMENT_CONFIRMATION_REQUIRED: 'Cần xác nhận đã thu tiền khi giao hàng.',
  INVALID_PAYMENT_SETTINGS: 'Kiểm tra chế độ, ngân hàng, số tài khoản và tên người nhận.',
  WEBHOOK_NOT_CONFIGURED: 'Chưa cấu hình khóa xác thực webhook thanh toán.', INVALID_PAYMENT_AMOUNT: 'Số tiền thanh toán chưa hợp lệ.',
}
function fail(code, status = 400) { throw Object.assign(new Error(code), { status }) }
function futureDate(value, now) {
  const date = new Date(value)
  if (typeof value !== 'string' || !Number.isFinite(date.getTime()) || date <= now || date.toISOString() !== value) fail('INVALID_SCHEDULE')
  return date.toISOString()
}

export function calculateAfterSales(order, kind, now, requestedSchedule) {
  if (!['paid', 'completed'].includes(order.status)) fail('PAYMENT_REQUIRED', 409)
  if (!['cancel', 'return', 'reschedule', 'merchant_fault'].includes(kind)) fail('ACTION_NOT_ALLOWED')
  const total = Number(order.total)
  const baseShip = Number(order.shipping_base || 0)
  const paidShip = Number(order.shipping_fee || 0)
  let breakdown
  let scheduledAt = null
  if (kind === 'cancel') {
    if (['shipped', 'delivered'].includes(order.delivery_status)) fail('ALREADY_SHIPPED', 409)
    breakdown = [{ label: 'Phí hủy 1% tiền hàng sau giảm', amount: Math.round(Number(order.goods_total) / 100) }, { label: 'Phí ship ban đầu không hoàn', amount: paidShip }]
  } else if (kind === 'reschedule') {
    if (order.delivery_status === 'delivered') fail('ACTION_NOT_ALLOWED', 409)
    scheduledAt = futureDate(requestedSchedule, now)
    const original = new Date(order.scheduled_at || order.created_at)
    if (new Date(scheduledAt).getTime() > original.getTime() + 7 * DAY) fail('RESCHEDULE_WINDOW_EXPIRED')
    breakdown = [{ label: order.fulfillment === 'pickup' ? 'Hẹn lại nhận tại quầy' : 'Phí giao lại theo mức ship gốc', amount: baseShip }]
  } else {
    if (order.delivery_status !== 'delivered' || !order.delivered_at) fail('DELIVERY_REQUIRED', 409)
    if (now.getTime() > new Date(order.delivered_at).getTime() + 7 * DAY) fail('RETURN_WINDOW_EXPIRED')
    if (kind === 'return') breakdown = [{ label: 'Phí ship ban đầu không hoàn', amount: paidShip }, { label: order.fulfillment === 'pickup' ? 'Trả tại quầy' : 'Phí ship trả hàng', amount: baseShip }]
    else breakdown = [{ label: 'Cửa hàng chịu toàn bộ phí khi xác nhận giao sai hoặc hàng lỗi', amount: 0 }]
  }
  const feeAmount = breakdown.reduce((sum, item) => sum + item.amount, 0)
  return { breakdown, feeAmount, refundAmount: kind === 'reschedule' ? 0 : Math.max(0, total - feeAmount),
    additionalDue: kind === 'reschedule' ? feeAmount : Math.max(0, feeAmount - total), scheduledAt,
    returnRequired: kind === 'return' || kind === 'merchant_fault', merchantFault: kind === 'merchant_fault' }
}

export function publicOrder(row) {
  const items = JSON.parse(row.items_json)
  return { id: row.id, customerId: row.customer_id, username: row.username, items,
    itemCount: items.reduce((sum, item) => sum + Number(item.quantity), 0), recipient: row.recipient, phone: row.phone,
    address: row.address, fulfillment: row.fulfillment, region: row.region, subtotal: Number(row.subtotal),
    discount: Number(row.discount), goodsTotal: Number(row.goods_total), goodsDiscount: Number(row.subtotal) - Number(row.goods_total),
    shippingFee: Number(row.shipping_fee), shippingFeeBeforeDiscount: Number(row.shipping_base), total: Number(row.total),
    voucherCodes: JSON.parse(row.voucher_codes_json), tier: row.tier, status: row.status, pointsEarned: Number(row.points_earned),
    createdAt: row.created_at, paidAt: row.paid_at, paymentMethod: row.payment_method, paymentMode: row.payment_mode,
    paymentReference: row.payment_reference, paymentConfirmation: row.payment_confirmation, paymentReportedAt: row.payment_reported_at,
    deliveryStatus: row.delivery_status, scheduledAt: row.scheduled_at, deliveredAt: row.delivered_at,
    refundAmount: Number(row.refund_amount), extraPaid: Number(row.extra_paid), lateCompensatedAt: row.late_compensated_at }
}
function publicCase(row) {
  return { id: row.id, orderId: row.order_id, customerId: row.customer_id, username: row.username, kind: row.kind,
    status: row.status, reason: row.reason, quote: JSON.parse(row.fee_json), scheduledAt: row.scheduled_at,
    feePaidAt: row.fee_paid_at, refundReference: row.refund_reference, note: row.note,
    compensation: JSON.parse(row.compensation_json), createdAt: row.created_at, updatedAt: row.updated_at }
}

export function registerOrderWorkflow(app, { storeDb, now, requireCustomer, customerCsrf, requireAdmin, requireCsrf,
  quote, issueVoucher, tierForPoints, pointsForPaidGoods, eventBroadcaster, paymentWebhookSecret = '' }) {
  const route = handler => async (req, res, next) => {
    try { res.set('Cache-Control', 'no-store'); await handler(req, res) } catch (error) {
      if (error.status || messages[error.message]) res.status(error.status || 400).json({ error: error.message, message: messages[error.message] || 'Không thực hiện được thao tác.' })
      else next(error)
    }
  }
  const settings = async () => ({ ...DEMO_PAYMENT, ...JSON.parse(await storeDb.getSetting('commerce.payment', '{}')) })
  const event = (orderId, message, actor = 'system') => storeDb.query('INSERT INTO customer_order_events (order_id, message, actor, created_at) VALUES ($1,$2,$3,$4)', [orderId, message, actor, now().toISOString()])
  async function orderFor(id, customerId, lock = false) {
    const result = await storeDb.query('SELECT * FROM customer_orders WHERE id = $1' + (customerId === undefined ? '' : ' AND customer_id = $2') + (lock ? ' FOR UPDATE' : ''), customerId === undefined ? [id] : [id, customerId])
    if (!result.rows[0]) fail('ORDER_NOT_FOUND', 404)
    return result.rows[0]
  }
  async function paymentInfo(order, request) {
    const config = await settings()
    const amount = request ? JSON.parse(request.fee_json).additionalDue : Number(order.total)
    const reference = (request ? request.id : order.id).replace(/[^A-Z0-9]/gi, '').toUpperCase()
    // Tiền thu tại quầy cần nhân viên xác nhận, không dùng thanh toán thử.
    const mode = order.payment_method !== 'bank_transfer' && config.mode === 'demo' ? 'counter' : order.payment_mode === 'demo' && order.payment_method === 'bank_transfer' ? 'demo' : config.mode
    if (mode === 'counter') return { mode, amount, reference, qrImage: null, purpose: 'Thanh toán phí tại cửa hàng' }
    const qrImage = mode === 'demo'
      ? await QRCode.toDataURL('STORE DEMO - KHONG CHUYEN TIEN THAT\n' + reference + '\n' + amount + ' VND', { width: 280, margin: 3, errorCorrectionLevel: 'M' })
      : 'https://img.vietqr.io/image/' + encodeURIComponent(config.bankBin) + '-' + encodeURIComponent(config.accountNumber) + '-compact2.png?' + new URLSearchParams({ amount: String(amount), addInfo: reference, accountName: config.accountName })
    return { ...(mode === 'demo' ? DEMO_PAYMENT : config), mode, amount, reference, qrImage, purpose: request ? 'Phí xử lý yêu cầu ' + request.id : 'Thanh toán đơn ' + order.id }
  }
  async function markPaid(order, reference, actor) {
    if (['paid', 'completed'].includes(order.status)) return { alreadyPaid: true }
    if (order.status !== 'pending') fail('ACTION_NOT_ALLOWED', 409)
    const account = (await storeDb.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [order.customer_id])).rows[0]
    const goods = Number(order.goods_total), previous = Number(account.paid_goods_total)
    const pointsEarned = pointsForPaidGoods(goods, tierForPoints(Number(account.points)))
    const spins = Math.floor((previous + goods) / 100000) - Math.floor(previous / 100000)
    const confirmation = order.payment_method === 'cash' ? 'counter' : order.payment_method === 'cod' ? 'cod' : order.payment_mode === 'demo' ? 'demo_transfer' : 'bank_transfer'
    await storeDb.query('UPDATE customers SET points = points + $1, paid_goods_total = paid_goods_total + $2, spin_credits = spin_credits + $3 WHERE id = $4', [pointsEarned, goods, spins, account.id])
    await storeDb.query("UPDATE customer_orders SET status = 'paid', paid_at = $1, points_earned = $2, payment_reference = $3, payment_confirmation = $4 WHERE id = $5", [now().toISOString(), pointsEarned, reference, confirmation, order.id])
    await event(order.id, confirmation === 'counter' ? 'Xác nhận thu tiền trực tiếp tại cửa hàng.' : 'Đã ghi nhận thanh toán: ' + reference, actor)
    return { alreadyPaid: false, pointsEarned, spinCreditsAdded: spins }
  }
  // Chỉ phát realtime sau khi giao dịch đã commit; callback lặp không cộng điểm hoặc phát sự kiện lần nữa.
  async function notifyPaid(orderId, result, transactionCode) {
    if (result.alreadyPaid) return
    const order = await orderFor(orderId)
    eventBroadcaster?.emit('order:paid', { orderId, ...result, total: Number(order.total), transactionCode })
  }
  async function compensate(customerId, count, source, shippingOnly = false) {
    const vouchers = []
    for (let index = 0; index < count; index++) {
      const pick = randomInt(shippingOnly ? 2 : 3)
      const gift = shippingOnly ? { scope: 'shipping', type: 'percent', value: pick ? 100 : 50 }
        : pick === 0 ? { scope: 'shipping', type: 'percent', value: 100 } : pick === 1 ? { scope: 'goods', type: 'percent', value: 20 } : { scope: 'goods', type: 'amount', value: 100000 }
      const label = gift.scope === 'shipping' ? gift.value === 100 ? 'Miễn phí ship · Store xin lỗi' : 'Giảm 50% ship · Store xin lỗi' : 'Ưu đãi xin lỗi · ' + (gift.type === 'percent' ? 'giảm 20%' : 'giảm 100.000 ₫')
      vouchers.push(await issueVoucher(customerId, { ...gift, label, source, expiresAt: new Date(now().getTime() + 30 * DAY).toISOString() }))
    }
    return vouchers
  }
  async function refund(order, request, body) {
    const fees = JSON.parse(request.fee_json)
    const reference = order.payment_mode === 'demo' ? 'DEMO-REFUND-' + request.id : String(body.refundReference || '').trim()
    if (order.payment_mode !== 'demo' && fees.refundAmount > 0 && (reference.length < 3 || reference.length > 100 || body.refundConfirmed !== true)) fail('REFUND_REFERENCE_REQUIRED')
    const account = (await storeDb.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [order.customer_id])).rows[0]
    const previous = Number(account.paid_goods_total), next = Math.max(0, previous - Number(order.goods_total))
    const removeSpins = Math.floor(previous / 100000) - Math.floor(next / 100000)
    await storeDb.query('UPDATE customers SET points = GREATEST(0, points - $1), paid_goods_total = $2, spin_credits = GREATEST(0, spin_credits - $3) WHERE id = $4', [Number(order.points_earned), next, removeSpins, account.id])
    await storeDb.query("UPDATE customer_orders SET status = 'refunded', refund_amount = $1, delivery_status = 'cancelled' WHERE id = $2", [fees.refundAmount, order.id])
    const gifts = fees.merchantFault ? await compensate(order.customer_id, 2 + randomInt(2), 'merchant-fault:' + request.id) : []
    await storeDb.query("UPDATE customer_after_sales SET status = 'resolved', refund_reference = $1, compensation_json = $2, updated_at = $3 WHERE id = $4", [reference, JSON.stringify(gifts), now().toISOString(), request.id])
    await event(order.id, 'Đã hoàn ' + fees.refundAmount + ' ₫; phí giữ lại ' + fees.feeAmount + ' ₫.' + (gifts.length ? ' Đã tặng ' + gifts.length + ' voucher xin lỗi.' : ''), 'admin')
  }
  async function finishFeePayment(order, request) {
    const fees = JSON.parse(request.fee_json)
    if (request.status !== 'awaiting_payment') fail('ACTION_NOT_ALLOWED', 409)
    if (request.kind === 'reschedule') futureDate(request.scheduled_at, now())
    await storeDb.query('UPDATE customer_orders SET extra_paid = extra_paid + $1 WHERE id = $2', [fees.additionalDue, order.id])
    await storeDb.query('UPDATE customer_after_sales SET fee_paid_at = $1, status = $2, updated_at = $1 WHERE id = $3', [now().toISOString(), fees.returnRequired ? 'awaiting_return' : 'resolved', request.id])
    if (request.kind === 'reschedule') await storeDb.query("UPDATE customer_orders SET scheduled_at = $1, delivery_status = 'processing' WHERE id = $2", [request.scheduled_at, order.id])
    await event(order.id, 'Đã thu phí phát sinh ' + fees.additionalDue + ' ₫' + (request.kind === 'reschedule' ? '; hẹn lại ' + request.scheduled_at : '.'), 'payment')
  }

  app.get('/api/storefront/commerce', route(async (req, res) => res.json({ mode: (await settings()).mode, policy: AFTER_SALES_POLICY })))
  app.get('/api/admin/payment-settings', requireAdmin, route(async (req, res) => res.json({ settings: await settings(), policy: AFTER_SALES_POLICY })))
  app.put('/api/admin/payment-settings', requireAdmin, requireCsrf, route(async (req, res) => {
    const values = Object.fromEntries(['mode','bankName','bankBin','accountNumber','accountName'].map(key => [key, String(req.body?.[key] || '').trim()]))
    if (!['demo','manual'].includes(values.mode) || (values.mode === 'manual' && (!/^\d{6}$/.test(values.bankBin) || values.bankBin === '000000' || !/^\d{6,24}$/.test(values.accountNumber) || /^0+$/.test(values.accountNumber) || values.accountName.length < 3 || values.accountName.length > 100 || values.bankName.length < 2 || values.bankName.length > 100))) fail('INVALID_PAYMENT_SETTINGS')
    await storeDb.setSetting('commerce.payment', JSON.stringify(values.mode === 'demo' ? DEMO_PAYMENT : values))
    res.json({ settings: await settings(), policy: AFTER_SALES_POLICY })
  }))

  const checkout = checkoutOrderData({ storeDb, now, quote, settings, fail, futureDate, event })
  const notifyCreated = (order, username) => eventBroadcaster?.emit('order:created', {
    orderId: order.id, total: order.total, goodsTotal: order.goodsTotal, customer: username,
    recipient: order.recipient, fulfillment: order.fulfillment, createdAt: order.createdAt,
  })
  const paymentSessions = registerPaymentSessions(app, {
    storeDb, now, requireCustomer, customerCsrf, route, fail, settings, checkout,
    publicOrder, paymentInfo, orderFor, markPaid, notifyPaid, notifyCreated,
  })
  app.post('/api/customer/orders', requireCustomer, customerCsrf, route(async (req, res) => {
    const order = await storeDb.transaction(async () => {
      const prepared = await checkout.prepare(req.customer.id, req.body)
      await checkout.insert(prepared)
      return publicOrder(await orderFor(prepared.id, req.customer.id))
    })
    notifyCreated(order, req.customer.username)
    res.status(201).json({ order })
  }))
  app.get('/api/customer/orders', requireCustomer, route(async (req, res) => {
    const rows = (await storeDb.query('SELECT * FROM customer_orders WHERE customer_id = $1 ORDER BY created_at DESC', [req.customer.id])).rows
    const requests = (await storeDb.query('SELECT * FROM customer_after_sales WHERE customer_id = $1 ORDER BY created_at DESC', [req.customer.id])).rows.map(publicCase)
    res.json({ orders: rows.map(row => ({ ...publicOrder(row), afterSales: requests.filter(item => item.orderId === row.id) })) })
  }))
  app.get('/api/admin/customer-orders', requireAdmin, route(async (req, res) => {
    const rows = (await storeDb.query('SELECT o.*, c.username FROM customer_orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.created_at DESC LIMIT 500')).rows
    res.json({ orders: rows.map(publicOrder) })
  }))
  app.get(['/api/customer/orders/:id/payment', '/api/customer/orders/:id/payment-info'], requireCustomer, route(async (req, res) => {
    const order = await orderFor(req.params.id, req.customer.id)
    const payment = await paymentInfo(order)
    res.json({ order: publicOrder(order), payment, orderId: order.id, amount: payment.amount, currency: 'VND', status: order.status,
      bankName: payment.bankName, accountNumber: payment.accountNumber, accountName: payment.accountName,
      transferContent: payment.reference, qrCodeUrl: payment.qrImage })
  }))
  for (const audience of ['customer','admin']) app.get(['/api/' + audience + '/orders/:id/receipt', '/api/' + audience + '/orders/:id/receipt.html'], audience === 'customer' ? requireCustomer : requireAdmin, route(async (req, res) => {
    const order = await orderFor(req.params.id, audience === 'customer' ? req.customer.id : undefined)
    const cases = (await storeDb.query('SELECT * FROM customer_after_sales WHERE order_id = $1 ORDER BY created_at', [order.id])).rows.map(publicCase)
    const events = (await storeDb.query('SELECT message,actor,created_at AS "createdAt" FROM customer_order_events WHERE order_id = $1 ORDER BY id', [order.id])).rows
    const receipt = { order: publicOrder(order), afterSales: cases, events, store: { name: 'Store Mini Mart', address: 'Vũng Tàu', demo: order.payment_mode === 'demo' } }
    if (req.path.endsWith('.html') || req.query.format === 'html') res.type('html').send(renderReceipt(receipt, audience))
    else res.json(receipt)
  }))
  app.post(['/api/customer/orders/:id/demo-paid', '/api/customer/orders/:id/simulate-pay'], requireCustomer, customerCsrf, route(async (req, res) => {
    const result = await storeDb.transaction(async () => {
      const order = await orderFor(req.params.id, req.customer.id, true)
      if (order.payment_mode !== 'demo' || order.payment_method !== 'bank_transfer' || (await settings()).mode !== 'demo') fail('DEMO_ONLY', 403)
      return markPaid(order, 'DEMO-' + order.id, 'customer-demo')
    })
    await notifyPaid(req.params.id, result)
    res.json({ success: true, orderId: req.params.id, ...result })
  }))
  app.post('/api/customer/payments/webhook', route(async (req, res) => {
    // Thông báo từ ngân hàng phải có khóa xác thực; không cho request công khai tự đánh dấu đã thu tiền.
    if (!paymentWebhookSecret) fail('WEBHOOK_NOT_CONFIGURED', 503)
    const supplied = Buffer.from(String(req.headers.authorization || ''))
    const expected = Buffer.from('Bearer ' + paymentWebhookSecret)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('UNAUTHORIZED', 401)
    const body = req.body || {}, orderId = String(body.orderId || body.order_id || '').trim()
    if (!/^[A-Za-z0-9_-]{3,60}$/.test(orderId)) fail('INVALID_ORDER')
    const amount = Number(body.amount)
    if (!['number', 'string'].includes(typeof body.amount) || String(body.amount).trim() === '' || !Number.isSafeInteger(amount) || amount < 0) fail('INVALID_PAYMENT_AMOUNT')
    const reference = String(body.transactionCode || body.transaction_code || '').trim()
    if (reference.length < 3 || reference.length > 100) fail('PAYMENT_REFERENCE_REQUIRED')
    if (paymentSessions.has(orderId)) {
      const result = await paymentSessions.webhook(orderId, reference, amount)
      res.json({ ...result, orderId })
      return
    }
    const result = await storeDb.transaction(async () => {
      const order = await orderFor(orderId, undefined, true)
      if (order.payment_method !== 'bank_transfer' || order.payment_mode === 'demo') fail('ACTION_NOT_ALLOWED', 409)
      if (amount < Number(order.total)) fail('INVALID_PAYMENT_AMOUNT')
      return markPaid(order, reference, 'bank-webhook')
    })
    await notifyPaid(orderId, result, reference)
    res.json({ success: true, orderId, ...result })
  }))
  app.post('/api/customer/orders/:id/payment-report', requireCustomer, customerCsrf, route(async (req, res) => {
    const order = await orderFor(req.params.id, req.customer.id)
    if (order.status !== 'pending' || order.payment_method !== 'bank_transfer') fail('ACTION_NOT_ALLOWED', 409)
    const reference = String(req.body.reference || '').trim().slice(0, 100)
    await storeDb.query('UPDATE customer_orders SET payment_reported_at = $1, payment_reference = $2 WHERE id = $3', [now().toISOString(), reference, order.id])
    res.json({ reported: true })
  }))
  app.post('/api/admin/customer-orders/:id/paid', requireAdmin, requireCsrf, route(async (req, res) => {
    const result = await storeDb.transaction(async () => {
      const order = await orderFor(req.params.id, undefined, true)
      const reference = String(req.body?.reference || '').trim().slice(0, 100)
      if (order.status === 'pending' && order.payment_method === 'cash' && req.body?.counterConfirmed !== true) fail('COUNTER_CONFIRMATION_REQUIRED')
      if (order.status === 'pending' && order.payment_method === 'cod' && req.body?.receivedConfirmed !== true) fail('DELIVERY_PAYMENT_CONFIRMATION_REQUIRED')
      if (order.status === 'pending' && order.payment_method === 'bank_transfer' && order.payment_mode !== 'demo' && reference.length < 3) fail('PAYMENT_REFERENCE_REQUIRED')
      return markPaid(order, reference || (order.payment_method === 'cash' ? 'COUNTER-' : 'ADMIN-') + order.id, 'admin')
    })
    await notifyPaid(req.params.id, result)
    res.json(result)
  }))
  app.post('/api/customer/orders/:id/cancel-unpaid', requireCustomer, customerCsrf, route(async (req, res) => {
    await storeDb.transaction(async () => {
      const order = await orderFor(req.params.id, req.customer.id, true)
      if (order.status !== 'pending' || ['shipped','delivered'].includes(order.delivery_status)) fail('ACTION_NOT_ALLOWED', 409)
      for (const voucher of JSON.parse(order.voucher_snapshot_json)) if (voucher && new Date(voucher.expires_at) > now()) {
        await storeDb.query('INSERT INTO customer_vouchers (code,customer_id,label,type,value,scope,expires_at,source,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING', [voucher.code,order.customer_id,voucher.label,voucher.type,voucher.value,voucher.scope,voucher.expires_at,voucher.source,voucher.created_at])
      }
      await storeDb.query("UPDATE customer_orders SET status = 'cancelled', delivery_status = 'cancelled' WHERE id = $1", [order.id])
      await event(order.id, 'Khách hủy đơn chưa thanh toán; voucher còn hạn được trả về ví.', 'customer')
    })
    res.json({ cancelled: true })
  }))
  app.patch('/api/admin/customer-orders/:id/fulfillment', requireAdmin, requireCsrf, route(async (req, res) => {
    const result = await storeDb.transaction(async () => {
      const order = await orderFor(req.params.id, undefined, true), status = req.body.status
      if (!['processing','ready','shipped','delivered'].includes(status) || !['pending','paid','completed'].includes(order.status)) fail('ACTION_NOT_ALLOWED', 409)
      if (order.delivery_status === 'delivered') { if (status === 'delivered') return publicOrder(order); fail('ACTION_NOT_ALLOWED', 409) }
      const open = (await storeDb.query("SELECT id FROM customer_after_sales WHERE order_id = $1 AND status IN ('pending','awaiting_payment','awaiting_return')", [order.id])).rows
      if (open.length) fail('CASE_PENDING', 409)
      if (status === 'delivered' && order.status !== 'paid') fail('PAYMENT_REQUIRED', 409)
      const rank = { processing: 0, ready: 1, shipped: 2, delivered: 3 }
      if (rank[status] < rank[order.delivery_status] || (order.fulfillment === 'pickup' && status === 'shipped')) fail('ACTION_NOT_ALLOWED', 409)
      await storeDb.query('UPDATE customer_orders SET delivery_status = $1, status = $2, delivered_at = $3 WHERE id = $4', [status,status === 'delivered' ? 'completed' : order.status,status === 'delivered' ? now().toISOString() : null,order.id])
      if (status === 'delivered' && order.fulfillment === 'delivery' && order.scheduled_at && now() > new Date(order.scheduled_at) && !order.late_compensated_at) {
        await compensate(order.customer_id, 1, 'late-delivery:' + order.id, true)
        await storeDb.query('UPDATE customer_orders SET late_compensated_at = $1 WHERE id = $2', [now().toISOString(),order.id])
        await event(order.id, 'Giao muộn lịch hẹn: đã tặng một voucher giảm hoặc miễn ship.', 'admin')
      }
      await event(order.id, 'Cập nhật giao/nhận: ' + status, 'admin')
      return publicOrder(await orderFor(order.id))
    })
    res.json({ order: result })
  }))
  app.post('/api/customer/orders/:id/after-sales', requireCustomer, customerCsrf, route(async (req, res) => {
    const request = await storeDb.transaction(async () => {
      const order = await orderFor(req.params.id, req.customer.id, true)
      const open = (await storeDb.query("SELECT id FROM customer_after_sales WHERE order_id = $1 AND status NOT IN ('resolved','rejected','cancelled')", [order.id])).rows
      if (open.length) fail('CASE_ALREADY_OPEN', 409)
      const reason = String(req.body.reason || '').trim()
      if (reason.length < 5 || reason.length > 1000) fail('INVALID_REASON')
      const fees = calculateAfterSales(order, req.body.kind, now(), req.body.scheduledAt)
      const id = 'AS-' + randomUUID().slice(0, 12).toUpperCase()
      const row = (await storeDb.query(`INSERT INTO customer_after_sales (id,order_id,customer_id,kind,status,reason,fee_json,scheduled_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'awaiting_confirmation',$5,$6,$7,$8,$8) RETURNING *`, [id,order.id,order.customer_id,req.body.kind,reason,JSON.stringify(fees),fees.scheduledAt,now().toISOString()])).rows[0]
      return publicCase(row)
    })
    res.status(201).json({ request })
  }))
  app.get('/api/admin/after-sales', requireAdmin, route(async (req, res) => {
    const rows = (await storeDb.query('SELECT a.*, c.username FROM customer_after_sales a JOIN customers c ON c.id = a.customer_id ORDER BY a.created_at DESC LIMIT 500')).rows
    res.json({ requests: rows.map(publicCase), policy: AFTER_SALES_POLICY })
  }))
  async function caseFor(id, customerId, lock = false) {
    const found = (await storeDb.query('SELECT * FROM customer_after_sales WHERE id = $1' + (customerId === undefined ? '' : ' AND customer_id = $2'), customerId === undefined ? [id] : [id,customerId])).rows[0]
    if (!found) fail('CASE_NOT_FOUND', 404)
    const order = await orderFor(found.order_id, customerId, lock)
    const request = lock ? (await storeDb.query('SELECT * FROM customer_after_sales WHERE id = $1 FOR UPDATE', [id])).rows[0] : found
    return { order, request }
  }
  app.get('/api/customer/after-sales/:id/payment', requireCustomer, route(async (req, res) => {
    const { order, request } = await caseFor(req.params.id, req.customer.id)
    if (request.status !== 'awaiting_payment') fail('ACTION_NOT_ALLOWED', 409)
    res.json({ payment: await paymentInfo(order, request), request: publicCase(request) })
  }))
  app.post('/api/customer/after-sales/:id/demo-paid', requireCustomer, customerCsrf, route(async (req, res) => {
    await storeDb.transaction(async () => {
      const { order, request } = await caseFor(req.params.id, req.customer.id, true)
      if (order.payment_mode !== 'demo' || order.payment_method !== 'bank_transfer' || (await settings()).mode !== 'demo') fail('DEMO_ONLY', 403)
      await finishFeePayment(order, request)
    })
    res.json({ paid: true })
  }))
  app.post('/api/customer/after-sales/:id/action', requireCustomer, customerCsrf, route(async (req, res) => {
    await storeDb.transaction(async () => {
      const { order, request } = await caseFor(req.params.id, req.customer.id, true), action = req.body.action
      if (closedCases.includes(request.status)) fail('ACTION_NOT_ALLOWED', 409)
      if (action === 'confirm' && request.status === 'awaiting_confirmation') {
        calculateAfterSales(order, request.kind, now(), request.scheduled_at)
        await storeDb.query("UPDATE customer_after_sales SET status = 'pending', updated_at = $1 WHERE id = $2", [now().toISOString(),request.id])
        await event(order.id, 'Khách xác nhận bảng phí yêu cầu ' + request.id, 'customer')
      } else if (action === 'cancel' && ['awaiting_confirmation','pending','awaiting_payment'].includes(request.status) && !request.fee_paid_at) {
        await storeDb.query("UPDATE customer_after_sales SET status = 'cancelled', updated_at = $1 WHERE id = $2", [now().toISOString(),request.id])
      } else if (action === 'payment_report' && request.status === 'awaiting_payment') {
        const reference = String(req.body.reference || '').trim()
        if (reference.length < 3 || reference.length > 100) fail('PAYMENT_REFERENCE_REQUIRED')
        await storeDb.query('UPDATE customer_after_sales SET note = $1, updated_at = $2 WHERE id = $3', ['Khách báo chuyển phí, cần đối soát: ' + reference, now().toISOString(), request.id])
      } else fail('ACTION_NOT_ALLOWED', 409)
    })
    res.json({ updated: true })
  }))
  app.post('/api/admin/after-sales/:id/action', requireAdmin, requireCsrf, route(async (req, res) => {
    await storeDb.transaction(async () => {
      const { order, request } = await caseFor(req.params.id, undefined, true), action = req.body.action
      const fees = JSON.parse(request.fee_json)
      if (closedCases.includes(request.status)) fail('ACTION_NOT_ALLOWED', 409)
      if (action === 'reject' && ['pending','awaiting_payment'].includes(request.status) && !request.fee_paid_at) {
        const note = String(req.body.note || '').trim()
        if (note.length < 5 || note.length > 1000) fail('INVALID_REASON')
        await storeDb.query("UPDATE customer_after_sales SET status = 'rejected', note = $1, updated_at = $2 WHERE id = $3", [note,now().toISOString(),request.id])
      } else if (action === 'approve' && request.status === 'pending') {
        if (request.kind === 'cancel') await refund(order, request, req.body)
        else if (fees.additionalDue > 0) await storeDb.query("UPDATE customer_after_sales SET status = 'awaiting_payment', updated_at = $1 WHERE id = $2", [now().toISOString(),request.id])
        else if (fees.returnRequired) await storeDb.query("UPDATE customer_after_sales SET status = 'awaiting_return', updated_at = $1 WHERE id = $2", [now().toISOString(),request.id])
        else {
          futureDate(request.scheduled_at, now())
          await storeDb.query('UPDATE customer_orders SET scheduled_at = $1 WHERE id = $2', [request.scheduled_at,order.id])
          await storeDb.query("UPDATE customer_after_sales SET status = 'resolved', updated_at = $1 WHERE id = $2", [now().toISOString(),request.id])
        }
      } else if (action === 'fee_paid' && request.status === 'awaiting_payment') {
        if (order.payment_mode !== 'demo' && String(req.body.reference || '').trim().length < 3) fail('PAYMENT_REFERENCE_REQUIRED')
        if (order.payment_method !== 'bank_transfer' && req.body.counterConfirmed !== true) fail('COUNTER_CONFIRMATION_REQUIRED')
        await finishFeePayment(order, request)
      } else if (action === 'complete_return' && request.status === 'awaiting_return') {
        if (req.body.received !== true) fail('RETURN_NOT_RECEIVED')
        await refund(order, request, req.body)
      } else fail('ACTION_NOT_ALLOWED', 409)
      await event(order.id, 'Xử lý yêu cầu ' + request.id + ': ' + action, 'admin')
    })
    res.json({ updated: true })
  }))
}
