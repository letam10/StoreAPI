/**
 * @codex-vn-doc
 * Tệp: server/test/dates.test.js
 * Mục đích: Tệp kiểm thử tự động cho các luồng chính và tình huống biên của module này.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:assert/strict, node:test, ../src/dates.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseIsoDate, resolveReportRange, validateDateRange } from '../src/dates.js'

// Kiểm thử edge case: validates real dates, leap years and range order.
test('validates real dates, leap years and range order', () => {
  assert.ok(parseIsoDate('2024-02-29'))
  assert.equal(parseIsoDate('2025-02-29'), null)
  assert.equal(validateDateRange('2026-09-02', '2026-09-01').code, 'REVERSED_DATE_RANGE')
  assert.equal(validateDateRange('2026-01-01', '2028-01-01').code, 'DATE_RANGE_TOO_LARGE')
})

// Kiểm thử edge case: resolves Vietnamese relative ranges across month/year boundaries.
test('resolves Vietnamese relative ranges across month/year boundaries', () => {
  const now = new Date('2026-01-01T00:30:00+07:00')
  assert.deepEqual(resolveReportRange('hôm qua', { now }), { status: 'resolved', from: '2025-12-31', to: '2025-12-31', source: 'relative_yesterday' })
  assert.deepEqual(resolveReportRange('tháng trước', { now }), { status: 'resolved', from: '2025-12-01', to: '2025-12-31', source: 'relative_previous_month' })
  assert.deepEqual(resolveReportRange('tháng này', { now }), { status: 'resolved', from: '2026-01-01', to: '2026-01-01', source: 'relative_this_month' })
  assert.equal(resolveReportRange('báo cáo gần đây', { now }).status, 'clarify')
})


// Kiểm thử edge case: rejects malformed ISO dates before range calculation.
test('rejects malformed ISO dates before range calculation', () => {
  assert.equal(parseIsoDate('2026-9-01'), null)
  assert.equal(parseIsoDate('2026-04-31'), null)
  assert.equal(validateDateRange('2026-02-29', '2026-03-01').code, 'INVALID_DATE')
})
