import { randomUUID } from 'node:crypto'

export function checkoutOrderData({ storeDb, now, quote, settings, fail, futureDate, event }) {
  async function prepare(customerId, body, id = 'ST-' + randomUUID().slice(0, 12).toUpperCase()) {
    const account = (await storeDb.query(
      'SELECT * FROM customers WHERE id = $1 FOR UPDATE', [customerId],
    )).rows[0]
    const data = await quote(account, body)
    if (!Number.isSafeInteger(data.total)) fail('INVALID_ORDER')
    if (body.expectedTotal !== undefined && body.expectedTotal !== data.total) fail('QUOTE_CHANGED', 409)
    const recipient = String(body.recipient || '').trim()
    const phone = String(body.phone || '').trim()
    const address = String(body.address || '').trim()
    if (recipient.length < 2 || recipient.length > 100 || !/^[+\d\s().-]{8,24}$/.test(phone) ||
      address.length > 500 || (data.fulfillment === 'delivery' && address.length < 5)) fail('INVALID_ORDER')
    const method = body.paymentMethod || (data.fulfillment === 'pickup' ? 'cash' : 'cod')
    if (!['bank_transfer', 'cash', 'cod'].includes(method) ||
      (method === 'cash' && data.fulfillment !== 'pickup') ||
      (method === 'cod' && data.fulfillment !== 'delivery')) fail('INVALID_ORDER')
    const schedule = body.scheduledAt ? futureDate(body.scheduledAt, now()) : null
    const config = await settings()
    const snapshot = []
    for (const code of data.voucherCodes) {
      snapshot.push((await storeDb.query(
        'SELECT * FROM customer_vouchers WHERE code = $1 AND customer_id = $2 FOR UPDATE', [code, account.id],
      )).rows[0])
    }
    return {
      id, customer_id: account.id, username: account.username, items_json: JSON.stringify(data.items),
      recipient, phone, address, fulfillment: data.fulfillment, region: data.region,
      distance_km: data.distanceKm, weight_kg: data.weightKg, subtotal: data.subtotal, discount: data.discount,
      goods_total: data.goodsTotal, shipping_fee: data.shippingFee, total: data.total,
      voucher_codes_json: JSON.stringify(data.voucherCodes), tier: data.tier, status: 'pending',
      created_at: now().toISOString(), shipping_base: data.shippingFeeBeforeDiscount, payment_method: method,
      payment_mode: method === 'bank_transfer' ? config.mode : 'counter', scheduled_at: schedule,
      voucher_snapshot_json: JSON.stringify(snapshot), points_earned: 0, paid_at: null,
      payment_reference: null, payment_confirmation: null, payment_reported_at: null,
      delivery_status: 'processing', delivered_at: null, refund_amount: 0, extra_paid: 0, late_compensated_at: null,
    }
  }

  async function insert(order) {
    const columns = [
      'id', 'customer_id', 'items_json', 'recipient', 'phone', 'address', 'fulfillment', 'region',
      'distance_km', 'weight_kg', 'subtotal', 'discount', 'goods_total', 'shipping_fee', 'total',
      'voucher_codes_json', 'tier', 'status', 'created_at', 'shipping_base', 'payment_method',
      'payment_mode', 'scheduled_at', 'voucher_snapshot_json',
    ]
    const placeholders = columns.map((_, index) => '$' + (index + 1)).join(',')
    await storeDb.query(
      'INSERT INTO customer_orders (' + columns.join(',') + ') VALUES (' + placeholders + ')',
      columns.map(key => order[key]),
    )
    for (const code of JSON.parse(order.voucher_codes_json)) {
      await storeDb.query('DELETE FROM customer_vouchers WHERE code = $1 AND customer_id = $2',
        [code, order.customer_id])
    }
    const label = order.payment_method === 'bank_transfer' ? 'chuyển khoản'
      : order.payment_method === 'cash' ? 'thanh toán tại quầy' : 'thu tiền khi giao'
    await event(order.id, 'Tạo đơn ' + label, 'customer')
    return order
  }

  return { prepare, insert }
}
