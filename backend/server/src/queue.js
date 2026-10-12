/**
 * @codex-vn-doc
 * Tệp: server/src/queue.js
 * Mục đích: Hàng đợi giới hạn lượt AI, timeout, abort và giải phóng slot.
 * Thành phần chính: GenerationQueue.
 * Liên kết trực tiếp: không có import/using trực tiếp được phát hiện.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
// Chức năng queueError: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function queueError(code, message) {
  const error = new Error(message)
  error.code = code
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (code === 'ABORTED') error.name = 'AbortError'
  return error
}

export class GenerationQueue {
  constructor({ concurrency = 1, maxQueued = 4 } = {}) {
    this.concurrency = concurrency
    this.maxQueued = maxQueued
    this.active = 0
    this.waiting = []
  }

  get snapshot() {
    return { active: this.active, queued: this.waiting.length }
  }

  run(task, signal, { waitTimeoutMs = 30000 } = {}) {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (signal?.aborted) return Promise.reject(queueError('ABORTED', 'Tác vụ đã bị hủy.'))
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (this.active >= this.concurrency && this.waiting.length >= this.maxQueued) {
      return Promise.reject(queueError('QUEUE_FULL', 'Hàng đợi AI đang đầy.'))
    }

    return new Promise((resolve, reject) => {
      const item = { task, signal, resolve, reject, onAbort: null, waitTimer: null, started: false }
      // Chức năng cleanupWaiting: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
      const cleanupWaiting = () => {
        if (item.waitTimer) clearTimeout(item.waitTimer)
        item.waitTimer = null
        signal?.removeEventListener('abort', item.onAbort)
      }
      item.onAbort = () => {
        if (item.started) return
        const index = this.waiting.indexOf(item)
        // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
        if (index >= 0) this.waiting.splice(index, 1)
        cleanupWaiting()
        reject(queueError('ABORTED', 'Tác vụ đã bị hủy khi đang chờ.'))
      }
      signal?.addEventListener('abort', item.onAbort, { once: true })

      if (this.active < this.concurrency) {
        cleanupWaiting()
        this.#start(item)
      } else {
        // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
        if (Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0) {
          item.waitTimer = setTimeout(() => {
            if (item.started) return
            const index = this.waiting.indexOf(item)
            // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
            if (index >= 0) this.waiting.splice(index, 1)
            cleanupWaiting()
            reject(queueError('QUEUE_TIMEOUT', 'Tác vụ chờ AI quá lâu.'))
          }, waitTimeoutMs)
        }
        this.waiting.push(item)
      }
    })
  }

  #start(item) {
    item.started = true
    if (item.waitTimer) clearTimeout(item.waitTimer)
    item.waitTimer = null
    item.signal?.removeEventListener('abort', item.onAbort)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (item.signal?.aborted) {
      item.reject(queueError('ABORTED', 'Tác vụ đã bị hủy.'))
      this.#drain()
      return
    }

    this.active += 1
    Promise.resolve()
      .then(() => item.task(item.signal))
      .then(item.resolve, item.reject)
      .finally(() => {
        this.active -= 1
        this.#drain()
      })
  }

  #drain() {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      this.#start(this.waiting.shift())
    }
  }
}
