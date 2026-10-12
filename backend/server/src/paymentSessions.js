export const PAYMENT_WINDOW_MS = 120000

export function registerPaymentSessions(app, dependencies) {
  const { storeDb, now, requireCustomer, customerCsrf, route, fail, settings, checkout,
    publicOrder, paymentInfo, orderFor, markPaid, notifyPaid, notifyCreated } = dependencies
  const sessions = new Map()
  const base = '/api/customer/payment-sessions'

  function sessionFor(id, customerId) {
    const session = sessions.get(id)
    if (!session || (customerId !== undefined && session.preview.customer_id !== customerId)) {
      fail('PAYMENT_SESSION_NOT_FOUND', 404)
    }
    return session
  }

  function assertActive(session) {
    if (session.cancelled) fail('PAYMENT_SESSION_CANCELLED', 409)
    if (now().getTime() >= session.expiresAt) fail('PAYMENT_SESSION_EXPIRED', 410)
  }

  async function payload(session) {
    if (!session.committed) assertActive(session)
    const row = session.committed ? await orderFor(session.preview.id) : session.preview
    return { sessionId: row.id, expiresAt: new Date(session.expiresAt).toISOString(),
      order: publicOrder(row), payment: session.payment }
  }

  async function finalize(session, kind, reference, amount) {
    // Xếp hàng theo phiên để callback đồng thời chỉ tạo đơn và tiêu voucher một lần.
    const previous = session.inFlight || Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      let created = false
      let paid = null
      try {
        const order = await storeDb.transaction(async () => {
          if (!session.committed) assertActive(session)
          const currentMode = (await settings()).mode
          if (kind === 'demo' && (session.preview.payment_mode !== 'demo' || currentMode !== 'demo')) {
            fail('DEMO_ONLY', 403)
          }
          if (kind !== 'demo' && (session.preview.payment_mode !== 'manual' || currentMode !== 'manual')) {
            fail('ACTION_NOT_ALLOWED', 409)
          }
          if (kind === 'webhook' && amount < Number(session.preview.total)) fail('INVALID_PAYMENT_AMOUNT')
          let row
          if (session.committed) row = await orderFor(session.preview.id, undefined, true)
          else {
            row = await checkout.prepare(session.preview.customer_id, session.body, session.preview.id)
            if (row.payment_mode !== session.preview.payment_mode) fail('ACTION_NOT_ALLOWED', 409)
            assertActive(session)
            await checkout.insert(row)
            created = true
          }
          if (kind === 'report') {
            if (row.status === 'pending' && !row.payment_reported_at) {
              await storeDb.query(
                'UPDATE customer_orders SET payment_reported_at = $1, payment_reference = $2 WHERE id = $3',
                [now().toISOString(), reference, row.id],
              )
            }
          } else paid = await markPaid(row, reference, kind === 'demo' ? 'customer-demo' : 'bank-webhook')
          const result = await orderFor(row.id)
          if (!session.committed) assertActive(session)
          // DELETE sau mốc này đợi COMMIT; trước mốc này có thể hủy và rollback toàn bộ.
          session.committing = true
          return publicOrder(result)
        })
        session.committed = true
        if (created) notifyCreated(order, session.preview.username)
        if (paid) await notifyPaid(order.id, paid, kind === 'webhook' ? reference : undefined)
        return { order, success: true, ...(kind === 'report' ? { reported: true } : paid) }
      } finally {
        session.committing = false
      }
    })
    session.inFlight = task
    try {
      return await task
    } finally {
      if (session.inFlight === task) session.inFlight = null
    }
  }

  app.post(base, requireCustomer, customerCsrf, route(async (req, res) => {
    if (req.body?.paymentMethod !== 'bank_transfer') fail('INVALID_ORDER')
    for (const [id, session] of sessions) {
      if (!session.inFlight && now().getTime() >= session.expiresAt) sessions.delete(id)
    }
    const preview = await storeDb.transaction(() => checkout.prepare(req.customer.id, req.body))
    const payment = await paymentInfo(preview)
    const session = { preview, payment, body: { ...req.body, expectedTotal: Number(preview.total) },
      expiresAt: now().getTime() + PAYMENT_WINDOW_MS, committed: false, cancelled: false }
    sessions.set(preview.id, session)
    res.status(201).json(await payload(session))
  }))

  app.get(base + '/:id', requireCustomer, route(async (req, res) => {
    res.json(await payload(sessionFor(req.params.id, req.customer.id)))
  }))

  app.delete(base + '/:id', requireCustomer, customerCsrf, route(async (req, res) => {
    const session = sessionFor(req.params.id, req.customer.id)
    if (session.committing) await session.inFlight
    if (session.committed) fail('ACTION_NOT_ALLOWED', 409)
    session.cancelled = true
    sessions.delete(req.params.id)
    if (session.inFlight) await session.inFlight.catch(() => {})
    res.json({ cancelled: true })
  }))

  app.post(base + '/:id/simulate-pay', requireCustomer, customerCsrf, route(async (req, res) => {
    const session = sessionFor(req.params.id, req.customer.id)
    res.json(await finalize(session, 'demo', 'DEMO-' + session.preview.id))
  }))

  app.post(base + '/:id/payment-report', requireCustomer, customerCsrf, route(async (req, res) => {
    const session = sessionFor(req.params.id, req.customer.id)
    const reference = String(req.body?.reference || '').trim()
    if (reference.length < 3 || reference.length > 100) fail('PAYMENT_REFERENCE_REQUIRED')
    res.json(await finalize(session, 'report', reference))
  }))

  return {
    has: id => sessions.has(id),
    webhook: (id, reference, amount) => finalize(sessionFor(id), 'webhook', reference, amount),
  }
}
