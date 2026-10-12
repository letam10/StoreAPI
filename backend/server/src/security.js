/**
 * @codex-vn-doc
 * Tệp: server/src/security.js
 * Mục đích: Hash/token, cookie, CSRF, mật khẩu và giới hạn đăng nhập.
 * Thành phần chính: randomToken, hashToken, hashPassword, verifyPassword, normalizeUsername, parseCookies, setCookie, clearCookie.
 * Liên kết trực tiếp: node:crypto.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

// Chức năng randomToken: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

// Chức năng hashToken: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function hashToken(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

// Chức năng hashPassword: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(password, salt, 64).toString('hex')
  return { salt, hash: derived }
}

// Chức năng verifyPassword: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function verifyPassword(password, salt, expectedHash) {
  try {
    const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'), 'hex')
    const expected = Buffer.from(expectedHash, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// Chức năng normalizeUsername: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function normalizeUsername(value) {
  return String(value ?? '').trim().toLocaleLowerCase('vi')
}

// Chức năng parseCookies: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function parseCookies(header = '') {
  const result = {}
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (!key) continue
    try {
      result[key] = decodeURIComponent(value)
    } catch {
      result[key] = value
    }
  }
  return result
}

// Chức năng setCookie: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function setCookie(res, name, value, {
  maxAge,
  secure = false,
  sameSite = 'Strict',
  httpOnly = true,
  path = '/',
} = {}) {
  const parts = [
    name + '=' + encodeURIComponent(value),
    'Path=' + path,
    'SameSite=' + sameSite,
  ]
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (Number.isFinite(maxAge)) parts.push('Max-Age=' + Math.max(0, Math.floor(maxAge)))
  res.append('Set-Cookie', parts.join('; '))
}

// Chức năng clearCookie: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function clearCookie(res, name, options = {}) {
  setCookie(res, name, '', { ...options, maxAge: 0 })
}

export class SlidingWindowLimiter {
  constructor({ limit, windowMs, maxKeys = 5000, sweepEvery = 100 }) {
    this.limit = limit
    this.windowMs = windowMs
    this.maxKeys = maxKeys
    this.sweepEvery = sweepEvery
    this.entries = new Map()
    this.operations = 0
  }

  get size() {
    return this.entries.size
  }

  #sweep(now) {
    const cutoff = now - this.windowMs
    for (const [key, entry] of this.entries) {
      const timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff)
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (timestamps.length === 0) this.entries.delete(key)
      else this.entries.set(key, { timestamps, touchedAt: entry.touchedAt })
    }
  }

  #evictOldest() {
    let oldestKey = null
    let oldestTouched = Infinity
    for (const [key, entry] of this.entries) {
      if (entry.touchedAt < oldestTouched) {
        oldestTouched = entry.touchedAt
        oldestKey = key
      }
    }
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (oldestKey !== null) this.entries.delete(oldestKey)
  }

  consume(key) {
    const now = Date.now()
    this.operations += 1
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (this.operations % this.sweepEvery === 0) this.#sweep(now)

    const cutoff = now - this.windowMs
    const normalizedKey = String(key)
    const existing = this.entries.get(normalizedKey)
    const timestamps = (existing?.timestamps || []).filter((timestamp) => timestamp > cutoff)

    if (!existing && this.entries.size >= this.maxKeys) {
      this.#sweep(now)
      if (this.entries.size >= this.maxKeys) this.#evictOldest()
    }

    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (timestamps.length >= this.limit) {
      this.entries.set(normalizedKey, { timestamps, touchedAt: now })
      return {
        allowed: false,
        retryAfterMs: Math.max(1000, timestamps[0] + this.windowMs - now),
      }
    }

    timestamps.push(now)
    this.entries.set(normalizedKey, { timestamps, touchedAt: now })
    return { allowed: true, retryAfterMs: 0 }
  }
}
