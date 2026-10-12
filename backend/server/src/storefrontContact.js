export function registerStorefrontContact(app, { storeDb }) {
  app.post('/api/storefront/contact', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim()
      const email = String(req.body?.email || '').trim().toLowerCase()
      const message = String(req.body?.message || '').trim()
      const topic = String(req.body?.topic || 'Hỗ trợ mua hàng').trim()
      if (name.length < 2 || name.length > 100 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length < 10 || message.length > 2000 || topic.length > 80) {
        return res.status(400).json({ error: 'INVALID_CONTACT', message: 'Kiểm tra tên, email và nội dung từ 10 đến 2.000 ký tự.' })
      }
      // Yêu cầu liên hệ được lưu cùng danh sách CSKH để nhân viên xử lý.
      const record = await storeDb.createAdminRecord({ module: 'support', title: (name + ' · ' + topic).slice(0, 160),
        status: 'Chờ phản hồi', data: { customer: name, email, topic, message, assignee: '' } })
      res.set('Cache-Control', 'no-store').status(201).json({ requestId: record.id, message: 'Đã gửi yêu cầu đến cửa hàng.' })
    } catch (failure) { next(failure) }
  })
}
