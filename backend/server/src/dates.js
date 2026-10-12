/**
 * @codex-vn-doc
 * Tệp: server/src/dates.js
 * Mục đích: Phân tích ngày, khoảng báo cáo và các mốc tương đối tiếng Việt.
 * Thành phần chính: STORE_TIMEZONE, MAX_REPORT_RANGE_DAYS, normalizeVietnamese, parseIsoDate, validateDateRange, resolveReportRange.
 * Liên kết trực tiếp: không có import/using trực tiếp được phát hiện.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
export const STORE_TIMEZONE = 'Asia/Ho_Chi_Minh'
export const MAX_REPORT_RANGE_DAYS = 366

// Chức năng normalizeVietnamese: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function normalizeVietnamese(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, (match) => match === 'Đ' ? 'D' : 'd')
    .toLocaleLowerCase('vi')
}

// Chức năng datePartsInTimeZone: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function datePartsInTimeZone(date, timeZone = STORE_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) }
}

// Chức năng toIso: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function toIso({ year, month, day }) {
  return [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-')
}

// Chức năng fromUtcDate: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function fromUtcDate(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

// Chức năng shiftCalendar: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function shiftCalendar(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return fromUtcDate(date)
}

// Chức năng parseIsoDate: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function parseIsoDate(value) {
  const text = String(value || '')
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return null
  return { year, month, day, epochDay: Math.floor(date.getTime() / 86400000) }
}

// Chức năng validateDateRange: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function validateDateRange(from, to, { maxDays = MAX_REPORT_RANGE_DAYS } = {}) {
  const start = parseIsoDate(from)
  const end = parseIsoDate(to)
  if (!start || !end) return { ok: false, code: 'INVALID_DATE' }
  if (start.epochDay > end.epochDay) return { ok: false, code: 'REVERSED_DATE_RANGE' }
  const spanDays = end.epochDay - start.epochDay + 1
  if (spanDays > maxDays) return { ok: false, code: 'DATE_RANGE_TOO_LARGE', spanDays }
  return { ok: true, from, to, spanDays }
}

// Chức năng fullMonthRange: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function fullMonthRange(parts) {
  const first = { year: parts.year, month: parts.month, day: 1 }
  const nextMonth = new Date(Date.UTC(parts.year, parts.month, 1))
  const last = shiftCalendar(fromUtcDate(nextMonth), -1)
  return { from: toIso(first), to: toIso(last) }
}

// Chức năng resolveReportRange: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function resolveReportRange(message, { now = new Date(), timeZone = STORE_TIMEZONE } = {}) {
  const raw = String(message || '')
  const normalized = normalizeVietnamese(raw)
  const isoTokens = raw.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []

  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (isoTokens.length > 2) return { status: 'clarify', reason: 'TOO_MANY_DATES' }
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (isoTokens.some((value) => !parseIsoDate(value))) {
    return { status: 'invalid', reason: 'INVALID_DATE' }
  }
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (isoTokens.length === 2) {
    const validation = validateDateRange(isoTokens[0], isoTokens[1])
    return validation.ok
      ? { status: 'resolved', from: isoTokens[0], to: isoTokens[1], source: 'explicit' }
      : { status: 'invalid', reason: validation.code }
  }
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (isoTokens.length === 1) {
    return { status: 'resolved', from: isoTokens[0], to: isoTokens[0], source: 'explicit' }
  }

  const today = datePartsInTimeZone(now, timeZone)
  if (/\bhom nay\b/.test(normalized)) {
    const value = toIso(today)
    return { status: 'resolved', from: value, to: value, source: 'relative_today' }
  }
  if (/\bhom qua\b/.test(normalized)) {
    const value = toIso(shiftCalendar(today, -1))
    return { status: 'resolved', from: value, to: value, source: 'relative_yesterday' }
  }
  if (/\bthang nay\b/.test(normalized)) {
    return {
      status: 'resolved',
      from: toIso({ year: today.year, month: today.month, day: 1 }),
      to: toIso(today),
      source: 'relative_this_month',
    }
  }
  if (/\bthang truoc\b/.test(normalized)) {
    const previous = fromUtcDate(new Date(Date.UTC(today.year, today.month - 2, 1)))
    return { status: 'resolved', ...fullMonthRange(previous), source: 'relative_previous_month' }
  }

  return { status: 'clarify', reason: 'RANGE_NOT_SPECIFIED' }
}
