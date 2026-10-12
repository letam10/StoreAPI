import assert from 'node:assert/strict'
import test from 'node:test'
import { withCommerceServer, adminSession, write } from './commerceTestHelpers.js'

test('liên hệ được lưu cho CSKH; đầu vào sai không tạo yêu cầu', () => withCommerceServer(async ({ root, storeDb }) => {
  const post = body => fetch(root + '/api/storefront/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({ name: 'A', email: 'invalid', message: 'ngắn' })).status, 400)
  assert.equal((await storeDb.query("SELECT id FROM admin_records WHERE module = 'support'")).rows.length, 0)
  const message = 'Tôi cần cửa hàng hỗ trợ kiểm tra lịch nhận hàng. '.repeat(30)
  const response = await post({ name: 'K'.repeat(100), email: 'support-test@example.invalid', topic: 'C'.repeat(80), message })
  assert.equal(response.status, 201)
  const result = await response.json()
  assert.ok(result.requestId)
  const record = (await storeDb.query('SELECT * FROM admin_records WHERE id = $1', [result.requestId])).rows[0]
  assert.equal(record.module, 'support')
  assert.equal(record.title.length, 160)
  assert.equal(JSON.parse(record.data_json).email, 'support-test@example.invalid')
  const admin = await adminSession(root, storeDb)
  const data = JSON.parse(record.data_json)
  const update = { title: record.title, status: 'Đang xử lý', data: { ...data, assignee: 'CSKH' } }
  assert.equal((await write(root, '/api/admin/records/support/' + record.id, admin, update, 'PATCH')).status, 200)
  assert.equal((await write(root, '/api/admin/records/support/' + record.id, admin, { ...update, data: { ...data, message: 'x'.repeat(2001) } }, 'PATCH')).status, 400)
}))
