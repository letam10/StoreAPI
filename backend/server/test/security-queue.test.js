/**
 * @codex-vn-doc
 * Tệp: server/test/security-queue.test.js
 * Mục đích: Tệp kiểm thử tự động cho các luồng chính và tình huống biên của module này.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:assert/strict, node:test, ../src/queue.js, ../src/security.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { GenerationQueue } from '../src/queue.js'
import { SlidingWindowLimiter } from '../src/security.js'

// Kiểm thử edge case: limiter bounds key memory.
test('limiter bounds key memory', () => {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60000, maxKeys: 3, sweepEvery: 1000 })
  for (let index = 0; index < 10; index += 1) limiter.consume('key-' + index)
  assert.ok(limiter.size <= 3)
})

// Kiểm thử edge case: queue abort while waiting releases listener/slot and later task runs.
test('queue abort while waiting releases listener/slot and later task runs', async () => {
  const queue = new GenerationQueue({ concurrency: 1, maxQueued: 1 })
  let release
  const first = queue.run(() => new Promise((resolve) => { release = resolve }))
  const controller = new AbortController()
  const second = queue.run(async () => 'never', controller.signal)
  controller.abort()
  await assert.rejects(second, (error) => error.code === 'ABORTED')
  release('first')
  await first
  assert.equal(await queue.run(async () => 'next'), 'next')
})
