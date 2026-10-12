import { registerStorefrontContact } from './storefrontContact.js'
import { registerOrderWorkflow } from './orderWorkflow.js'
/**
 * @codex-vn-doc
 * Tệp: server/src/customer.js
 * Mục đích: Đăng ký các route customer, phiên đăng nhập, voucher, yêu thích, đánh giá và checkout.
 * Thành phần chính: tierForPoints, rewardPrizes, pointsForPaidGoods, SHIPPING_DESTINATIONS, shippingFee, registerCustomerRoutes.
 * Liên kết trực tiếp: node:crypto, ../../shared/products.js, ./security.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { randomBytes, randomInt } from 'node:crypto'
import { products as baseProducts } from '../../shared/products.js'
import { clearCookie, hashPassword, hashToken, normalizeUsername, parseCookies, randomToken, setCookie, verifyPassword } from './security.js'

const COOKIE = 'store_customer_session'
const SESSION_SECONDS = 60 * 60 * 24 * 30
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PRIZES = Object.freeze([
  { kind: 'none', label: 'Chúc bạn may mắn lần sau' },
  { kind: 'none', label: 'Chúc bạn may mắn lần sau' },
  { kind: 'amount', label: 'Voucher 100K', value: 100000 },
  { kind: 'none', label: 'Chúc bạn may mắn lần sau' },
  { kind: 'percent', label: 'Voucher giảm 20%', value: 20 },
  { kind: 'none', label: 'Chúc bạn may mắn lần sau' },
  { kind: 'amount', label: 'Voucher 100K', value: 100000 },
  { kind: 'none', label: 'Chúc bạn may mắn lần sau' },
  { kind: 'amount', label: 'Voucher 100K', value: 100000 },
  { kind: 'none', label: 'Chúc bạn may mắn lần sau' },
])

// Chức năng tierForPoints: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function tierForPoints(points) {
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (points >= 10000) return 'diamond'
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (points >= 1000) return 'gold'
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (points >= 100) return 'silver'
  return 'bronze'
}

// Chức năng rewardPrizes: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
const SHIPPING_PRIZES = Object.freeze(PRIZES.map(prize => prize.kind === 'none' ? prize : {
  kind: 'percent', value: prize.kind === 'amount' ? 50 : 100,
  label: prize.kind === 'amount' ? 'Voucher giảm 50% phí ship' : 'Voucher miễn phí ship',
}))

export function rewardPrizes(wheel = 'goods') { return wheel === 'shipping' ? SHIPPING_PRIZES : PRIZES }

function voucherLabel(scope, type, value) {
  if (scope === 'shipping' && type === 'percent' && value === 100) return 'Miễn phí ship'
  const discount = type === 'amount' ? new Intl.NumberFormat('vi-VN').format(value) + ' ₫' : value + '%'
  return (scope === 'shipping' ? 'Giảm phí ship ' : 'Giảm ') + discount
}

// Chức năng pointsForPaidGoods: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function pointsForPaidGoods(amount, tier) {
  const basePoints = Math.floor(Math.max(0, amount) / 1000)
  return Math.floor(basePoints * (tier === 'diamond' ? 1.5 : tier === 'gold' ? 1.2 : 1))
}

export const SHIPPING_DESTINATIONS = Object.freeze([
  ['hanoi', 'Hà Nội'], ['haiphong', 'Hải Phòng'], ['quang-ninh', 'Quảng Ninh'], ['bac-giang', 'Bắc Giang'],
  ['phu-tho', 'Phú Thọ'], ['vinh-phuc', 'Vĩnh Phúc'], ['bac-ninh', 'Bắc Ninh'], ['hai-duong', 'Hải Dương'],
  ['hung-yen', 'Hưng Yên'], ['thai-binh', 'Thái Bình'], ['nam-dinh', 'Nam Định'], ['ninh-binh', 'Ninh Bình'],
  ['ha-nam', 'Hà Nam'], ['lao-cai', 'Lào Cai'], ['yen-bai', 'Yên Bái'], ['tuyen-quang', 'Tuyên Quang'],
  ['ha-giang', 'Hà Giang'], ['cao-bang', 'Cao Bằng'], ['bac-kan', 'Bắc Kạn'], ['lang-son', 'Lạng Sơn'],
  ['thai-nguyen', 'Thái Nguyên'], ['dien-bien', 'Điện Biên'], ['lai-chau', 'Lai Châu'], ['son-la', 'Sơn La'],
  ['hoa-binh', 'Hòa Bình'], ['thanh-hoa', 'Thanh Hóa'], ['nghe-an', 'Nghệ An'], ['ha-tinh', 'Hà Tĩnh'],
  ['quang-binh', 'Quảng Bình'], ['quang-tri', 'Quảng Trị'], ['thua-thien-hue', 'Thừa Thiên Huế'],
  ['da-nang', 'Đà Nẵng'], ['quang-nam', 'Quảng Nam'], ['quang-ngai', 'Quảng Ngãi'], ['binh-dinh', 'Bình Định'],
  ['phu-yen', 'Phú Yên'], ['khanh-hoa', 'Khánh Hòa'], ['ninh-thuan', 'Ninh Thuận'], ['binh-thuan', 'Bình Thuận'],
  ['kon-tum', 'Kon Tum'], ['gia-lai', 'Gia Lai'], ['dak-lak', 'Đắk Lắk'], ['dak-nong', 'Đắk Nông'],
  ['lam-dong', 'Lâm Đồng'], ['binh-phuoc', 'Bình Phước'], ['tay-ninh', 'Tây Ninh'], ['dong-nai', 'Đồng Nai'],
  ['long-an', 'Long An'], ['tien-giang', 'Tiền Giang'], ['ben-tre', 'Bến Tre'], ['tra-vinh', 'Trà Vinh'],
  ['vinh-long', 'Vĩnh Long'], ['dong-thap', 'Đồng Tháp'], ['an-giang', 'An Giang'], ['kien-giang', 'Kiên Giang'],
  ['can-tho', 'Cần Thơ'], ['hau-giang', 'Hậu Giang'], ['soc-trang', 'Sóc Trăng'], ['bac-lieu', 'Bạc Liêu'],
  ['ca-mau', 'Cà Mau'],
])

const SHIPPING_DESTINATION_IDS = new Set(SHIPPING_DESTINATIONS.map(([id]) => id))

// Chức năng shippingFee: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function shippingFee({ region, distanceKm = 0, weightKg = 1, fulfillment = 'delivery' }) {
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (fulfillment === 'pickup') return 0
  const normalizedWeightKg = Number(weightKg)
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (!Number.isFinite(normalizedWeightKg) || normalizedWeightKg <= 0 || normalizedWeightKg > 1000) throw new Error('INVALID_DELIVERY_REGION')
  if (region === 'international') {
    return normalizedWeightKg <= 1 ? 200000 : Math.ceil(normalizedWeightKg / 5) * 400000
  }
  const provinceId = typeof region === 'string' && region.startsWith('province:') ? region.slice(9) : ''
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (provinceId && !SHIPPING_DESTINATION_IDS.has(provinceId)) throw new Error('INVALID_DELIVERY_REGION')
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (!['hcm', 'binh-duong', 'ba-ria-vung-tau', 'nearby', 'far'].includes(region) && !provinceId) throw new Error('INVALID_DELIVERY_REGION')
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (region === 'hcm' || region === 'binh-duong' || region === 'ba-ria-vung-tau') return 30000
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (provinceId) return 60000
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (region === 'nearby') return 60000
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (region === 'far' && Number.isInteger(distanceKm) && distanceKm >= 0 && distanceKm <= 3000) return 60000 + distanceKm * 1000
  throw new Error('INVALID_DELIVERY_REGION')
}

// Chức năng publicVoucher: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function publicVoucher(row) {
  return { code: row.code, label: row.label, type: row.type, value: Number(row.value), scope: row.scope || 'goods', expiresAt: row.expires_at, source: row.source }
}

// Chức năng cleanExpired: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function cleanExpired(storeDb, time) {
  // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
  await storeDb.query('DELETE FROM customer_vouchers WHERE expires_at <= $1', [time])
}

// Chức năng createCode: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function createCode() {
  const bytes = randomBytes(10)
  return Array.from(bytes, (byte) => CODE_CHARS[byte % CODE_CHARS.length]).join('')
}

// Chức năng registerCustomerRoutes: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function registerCustomerRoutes(app, { storeDb, config, now, requireAdmin, requireCsrf, eventBroadcaster, paymentWebhookSecret }) {
  const customerLimiter = new Map()
  // Chức năng limited: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  function limited(ip) {
    const time = Date.now()
    const entries = (customerLimiter.get(ip) || []).filter((stamp) => time - stamp < 600000)
    entries.push(time)
    customerLimiter.set(ip, entries)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (customerLimiter.size > 5000) customerLimiter.clear()
    return entries.length > 30
  }

  // Chức năng customer: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  async function customer(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!token) return null
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const resRow = await storeDb.query(
      `SELECT c.*, s.expires_at FROM customer_sessions s
       JOIN customers c ON c.id = s.customer_id WHERE s.token_hash = $1`,
      [hashToken(token)],
    )
    const row = resRow.rows[0]
    if (!row || row.expires_at <= now().toISOString()) {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await storeDb.query('DELETE FROM customer_sessions WHERE token_hash = $1', [hashToken(token)])
      clearCookie(res, COOKIE, { secure: config.cookieSecure })
      return null
    }
    return { ...row, rawToken: token, csrfToken: hashToken('customer-csrf:' + token) }
  }

  // Chức năng requireCustomer: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  async function requireCustomer(req, res, next) {
    const row = await customer(req, res)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!row) return res.status(401).json({ error: 'LOGIN_REQUIRED' })
    req.customer = row
    next()
  }

  // Chức năng customerCsrf: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  function customerCsrf(req, res, next) {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (req.get('x-csrf-token') !== req.customer.csrfToken) return res.status(403).json({ error: 'CSRF_INVALID' })
    next()
  }

  // Chức năng publicCustomer: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  function publicCustomer(row) {
    return {
      id: Number(row.id),
      username: row.username,
      email: row.email,
      points: Number(row.points),
      tier: tierForPoints(Number(row.points)),
      spinCredits: Number(row.spin_credits),
      csrfToken: row.csrfToken,
    }
  }

  // Chức năng beginSession: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  async function beginSession(res, row) {
    const token = randomToken()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.query(
      'INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, $3)',
      [hashToken(token), row.id, new Date(now().getTime() + SESSION_SECONDS * 1000).toISOString()],
    )
    setCookie(res, COOKIE, token, { maxAge: SESSION_SECONDS, secure: config.cookieSecure })
    return publicCustomer({ ...row, csrfToken: hashToken('customer-csrf:' + token) })
  }

  // Chức năng productById: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  async function productById(id) {
    const strId = String(id)
    const basic = baseProducts.find((item) => String(item.id) === strId)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (basic) return { ...basic, stockCount: 20, discountPercent: 0 }
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await storeDb.query(
      'SELECT id, name, category, price, image, symbol, discount_percent AS "discountPercent", stock_count AS "stockCount" FROM catalog_products WHERE id = $1',
      [strId],
    )
    const item = res.rows[0]
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!item) return null
    return {
      ...item,
      price: Number(item.price),
      discountPercent: Number(item.discountPercent || 0),
      stockCount: Number.isInteger(item.stockCount) && item.stockCount >= 0 ? item.stockCount : 20,
    }
  }

  // Chức năng issueVoucher: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  async function issueVoucher(customerId, { label, type, value, scope = 'goods', expiresAt, source }) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const code = createCode()
      const reserved = await storeDb.query('INSERT INTO voucher_codes (code, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING code', [code, now().toISOString()])
      if (!reserved.rows.length) continue
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await storeDb.query(
        `INSERT INTO customer_vouchers (code, customer_id, label, type, value, scope, expires_at, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [code, customerId, label, type, value, scope, expiresAt, source, now().toISOString()],
      )
      return { code, label, type, value, scope, expiresAt, source }
    }
    throw new Error('VOUCHER_CODE_EXHAUSTED')
  }

  // Chức năng vouchersFor: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  async function vouchersFor(id) {
    await cleanExpired(storeDb, now().toISOString())
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await storeDb.query('SELECT * FROM customer_vouchers WHERE customer_id = $1 ORDER BY created_at DESC', [id])
    return res.rows.map(publicVoucher)
  }

  // Chức năng quote: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  async function quote(row, body) {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 99 ||
      !['delivery', 'pickup'].includes(body.fulfillment)) throw new Error('INVALID_ORDER')
    const ids = new Set()
    const items = []
    for (const line of body.items) {
      const id = String(line.id || '')
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (ids.has(id) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) throw new Error('INVALID_ORDER')
      ids.add(id)
      const product = await productById(id)
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!product || product.stockCount === 0 || (product.stockCount !== null && product.stockCount < line.quantity)) throw new Error('PRODUCT_UNAVAILABLE')
      const price = Math.round(product.price * (100 - product.discountPercent) / 1000) * 10
      items.push({ id, name: product.name, quantity: line.quantity, price })
    }
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
    const tier = tierForPoints(row.points)
    const codes = body.voucherCodes || []
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!Array.isArray(codes) || codes.length > 20 || new Set(codes).size !== codes.length) throw new Error('INVALID_VOUCHER')
    await cleanExpired(storeDb, now().toISOString())
    let remaining = subtotal
    const shippingCodes = []
    for (const code of codes) {
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (typeof code !== 'string' || !/^[A-Z2-9]{10}$/.test(code)) throw new Error('INVALID_VOUCHER')
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const vRes = await storeDb.query(
        'SELECT * FROM customer_vouchers WHERE code = $1 AND customer_id = $2 AND expires_at > $3',
        [code, row.id, now().toISOString()],
      )
      const voucher = vRes.rows[0]
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!voucher) throw new Error('INVALID_VOUCHER')
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if ((voucher.scope || 'goods') === 'shipping') shippingCodes.push(voucher)
      else {
        const raw = voucher.type === 'amount' ? Number(voucher.value) : Math.floor(remaining * Number(voucher.value) / 100)
        remaining -= Math.min(remaining, raw)
      }
    }
    const tierRate = { bronze: 0, silver: 1, gold: 2, diamond: 5 }[tier]
    remaining -= Math.min(remaining, Math.floor(remaining * tierRate / 100))
    const fulfillment = body.fulfillment
    const region = fulfillment === 'pickup' ? 'pickup' : String(body.region || '')
    const distanceKm = fulfillment === 'pickup' ? 0 : Number(body.distanceKm || 0)
    const weightKg = fulfillment === 'pickup' ? 0 : Number(body.weightKg || 1)
    const originalFee = shippingFee({ region, distanceKm, weightKg, fulfillment }, tier)
    let fee = originalFee
    for (const voucher of shippingCodes) {
      const raw = voucher.type === 'amount' ? Number(voucher.value) : Math.floor(fee * Number(voucher.value) / 100)
      fee -= Math.min(fee, raw)
    }
    const discountTotal = subtotal - remaining + originalFee - fee
    return {
      items,
      subtotal,
      discount: discountTotal,
      goodsTotal: remaining,
      shippingFee: fee,
      shippingFeeBeforeDiscount: originalFee,
      shippingDiscount: originalFee - fee,
      total: remaining + fee,
      tier,
      voucherCodes: codes,
      fulfillment,
      region,
      distanceKm,
      weightKg,
    }
  }

  // Chức năng fail: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  function fail(res, error) {
    const code = error.message
    const status = ['INVALID_ORDER', 'PRODUCT_UNAVAILABLE', 'INVALID_VOUCHER', 'INVALID_DELIVERY_REGION'].includes(code) ? 400 : 500
    return res.status(status).json({ error: status === 400 ? code : 'INTERNAL_ERROR' })
  }

  app.use('/api/customer', (req, res, next) => { res.set('Cache-Control', 'no-store'); next() })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.post('/api/customer/register', async (req, res) => {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (limited(req.ip)) return res.status(429).json({ error: 'RATE_LIMITED' })
    const username = String(req.body?.username || '').trim()
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = req.body?.password
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (username.length < 2 || username.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      typeof password !== 'string' || password.length < 8 || password.length > 256) return res.status(400).json({ error: 'INVALID_REGISTRATION' })
    const { salt, hash } = hashPassword(password)
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const result = await storeDb.query(
        'INSERT INTO customers (username, email, password_salt, password_hash, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [username, email, salt, hash, now().toISOString()],
      )
      const newId = result.rows[0].id
      const sessionAccount = await beginSession(res, { id: newId, username, email, points: 0, spin_credits: 0 })
      res.status(201).json({ account: sessionAccount })
    } catch (error) {
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (error.code === '23505' || error.message?.includes('duplicate key') || error.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: 'ACCOUNT_EXISTS' })
      }
      throw error
    }
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.post('/api/customer/login', async (req, res) => {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (limited(req.ip)) return res.status(429).json({ error: 'RATE_LIMITED' })
    const login = normalizeUsername(req.body?.username)
    const password = req.body?.password
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!login || typeof password !== 'string' || password.length > 256) return res.status(400).json({ error: 'INVALID_CREDENTIALS' })
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const resRow = await storeDb.query(
      'SELECT * FROM customers WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
      [login, login],
    )
    const row = resRow.rows[0]
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) return res.status(401).json({ error: 'INVALID_CREDENTIALS' })
    res.json({ account: await beginSession(res, row) })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.get('/api/customer/session', async (req, res) => {
    const row = await customer(req, res)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!row) return res.status(401).json({ authenticated: false })
    res.json({ authenticated: true, account: publicCustomer(row) })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.post('/api/customer/logout', requireCustomer, customerCsrf, async (req, res) => {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.query('DELETE FROM customer_sessions WHERE token_hash = $1', [hashToken(req.customer.rawToken)])
    clearCookie(res, COOKIE, { secure: config.cookieSecure })
    res.json({ ok: true })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.get('/api/customer/vouchers', requireCustomer, async (req, res) => {
    res.json({ vouchers: await vouchersFor(req.customer.id) })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.get('/api/customer/favorites', requireCustomer, async (req, res) => {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const resFav = await storeDb.query('SELECT product_id FROM customer_favorites WHERE customer_id = $1 ORDER BY created_at DESC', [req.customer.id])
    res.json({ ids: resFav.rows.map((item) => item.product_id) })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.put('/api/customer/favorites/:id', requireCustomer, customerCsrf, async (req, res) => {
    const id = String(req.params.id)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!(await productById(id))) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND' })
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.query(
      'INSERT INTO customer_favorites (customer_id, product_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [req.customer.id, id, now().toISOString()],
    )
    res.json({ saved: true })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.delete('/api/customer/favorites/:id', requireCustomer, customerCsrf, async (req, res) => {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.query('DELETE FROM customer_favorites WHERE customer_id = $1 AND product_id = $2', [req.customer.id, req.params.id])
    res.json({ saved: false })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.get('/api/storefront/products/:id/reviews', async (req, res) => {
    const id = String(req.params.id)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!(await productById(id))) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND' })
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const rowsRes = await storeDb.query(
      `SELECT r.id, r.rating, r.comment, r.admin_reply AS "adminReply",
              r.created_at AS "createdAt", r.replied_at AS "repliedAt", c.username
       FROM product_reviews r JOIN customers c ON c.id = r.customer_id
       WHERE r.product_id = $1 ORDER BY r.created_at DESC LIMIT 200`,
      [id],
    )
    res.json({ reviews: rowsRes.rows, total: rowsRes.rows.length })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.post('/api/storefront/products/:id/reviews', requireCustomer, customerCsrf, async (req, res) => {
    const id = String(req.params.id)
    const rating = req.body?.rating
    const comment = String(req.body?.comment || '').trim()
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!(await productById(id))) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND' })
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length > 2000) return res.status(400).json({ error: 'INVALID_REVIEW' })
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.query(
      `INSERT INTO product_reviews (customer_id, product_id, rating, comment, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(customer_id, product_id) DO UPDATE SET
         rating = EXCLUDED.rating, comment = EXCLUDED.comment, admin_reply = '', replied_at = NULL, created_at = EXCLUDED.created_at`,
      [req.customer.id, id, rating, comment, now().toISOString()],
    )
    eventBroadcaster?.emit('review:created', { productId: id, rating, customer: req.customer.username, comment })
    res.json({ ok: true })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.post('/api/customer/spin', requireCustomer, customerCsrf, async (req, res) => {
    const wheel = req.body?.wheel ?? 'goods'
    if (!['goods', 'shipping'].includes(wheel)) return res.status(400).json({ error: 'INVALID_WHEEL' })
    const prizes = rewardPrizes(wheel)
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const outcome = await storeDb.transaction(async (tx) => {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const curRes = await tx.query('UPDATE customers SET spin_credits = spin_credits - 1 WHERE id = $1 AND spin_credits > 0 RETURNING spin_credits', [req.customer.id])
      const current = curRes.rows[0]
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!current) return null
      const index = randomInt(prizes.length)
      const prize = prizes[index]
      let voucher = null
      if (prize.kind !== 'none') {
        const code = createCode()
        const exp = new Date(now().getTime() + 30 * 86400000).toISOString()
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query('INSERT INTO voucher_codes (code, created_at) VALUES ($1, $2)', [code, now().toISOString()])
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          `INSERT INTO customer_vouchers (code, customer_id, label, type, value, scope, expires_at, source, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [code, req.customer.id, prize.label, prize.kind, prize.value, wheel, exp, wheel === 'shipping' ? 'shipping-wheel' : 'wheel', now().toISOString()],
        )
        voucher = { code, label: prize.label, type: prize.kind, value: prize.value, scope: wheel, expiresAt: exp, source: wheel === 'shipping' ? 'shipping-wheel' : 'wheel' }
      }
      return { wheel, index, prize: prize.label, voucher, spinCredits: Number(current.spin_credits) }
    })
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!outcome) return res.status(409).json({ error: 'NO_SPIN_CREDITS' })
    res.json(outcome)
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.post('/api/customer/quote', requireCustomer, customerCsrf, async (req, res) => {
    try {
      const q = await quote(req.customer, req.body)
      res.json(q)
    } catch (error) {
      fail(res, error)
    }
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.get('/api/admin/customers', requireAdmin, async (req, res) => {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const resCust = await storeDb.query(
      `SELECT id, username, email, points, paid_goods_total AS "paidGoodsTotal",
              spin_credits AS "spinCredits", created_at AS "createdAt"
       FROM customers ORDER BY points DESC, id ASC`,
    )
    const customers = resCust.rows.map((item) => ({
      ...item,
      id: Number(item.id),
      points: Number(item.points),
      paidGoodsTotal: Number(item.paidGoodsTotal),
      spinCredits: Number(item.spinCredits),
      tier: tierForPoints(Number(item.points)),
    }))
    res.json({ customers })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.post('/api/admin/customers/:id/vouchers', requireAdmin, requireCsrf, async (req, res) => {
    const customerId = Number(req.params.id)
    const type = req.body?.type
    const scope = req.body?.scope === undefined ? 'goods' : req.body.scope
    const value = req.body?.value
    const date = new Date(req.body?.expiresAt)
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const custExists = await storeDb.query('SELECT id FROM customers WHERE id = $1', [customerId])
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!custExists.rows.length) return res.status(404).json({ error: 'CUSTOMER_NOT_FOUND' })
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!['amount', 'percent'].includes(type) || !['goods', 'shipping'].includes(scope) || !Number.isInteger(value) || value < 1 || value > (type === 'percent' ? 100 : 10000000) ||
      !Number.isFinite(date.getTime()) || date <= now() || date.getTime() > now().getTime() + 365 * 86400000) return res.status(400).json({ error: 'INVALID_VOUCHER' })
    const label = voucherLabel(scope, type, value)
    const voucher = await issueVoucher(customerId, { label, type, value, scope, expiresAt: date.toISOString(), source: 'admin' })
    res.status(201).json({ voucher })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.get('/api/admin/vouchers', requireAdmin, async (req, res) => {
    await cleanExpired(storeDb, now().toISOString())
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const resVouchers = await storeDb.query(
      `SELECT v.code, v.label, v.type, v.value, v.scope, v.expires_at AS "expiresAt",
              v.source, v.created_at AS "createdAt", c.id AS "customerId", c.username, c.email
       FROM customer_vouchers v JOIN customers c ON c.id = v.customer_id
       ORDER BY v.created_at DESC`,
    )
    res.json({ vouchers: resVouchers.rows })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.post('/api/admin/vouchers', requireAdmin, requireCsrf, async (req, res) => {
    const customerId = Number(req.body?.customerId)
    const type = req.body?.type
    const scope = req.body?.scope === undefined ? 'goods' : req.body.scope
    const value = req.body?.value
    const date = new Date(req.body?.expiresAt)
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const custExists = await storeDb.query('SELECT id FROM customers WHERE id = $1', [customerId])
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!Number.isInteger(customerId) || customerId < 1 || !custExists.rows.length ||
      !['amount', 'percent'].includes(type) || !['goods', 'shipping'].includes(scope) || !Number.isInteger(value) || value < 1 || value > (type === 'percent' ? 100 : 10000000) ||
      !Number.isFinite(date.getTime()) || date <= now() || date.getTime() > now().getTime() + 365 * 86400000) {
      return res.status(400).json({ error: 'INVALID_VOUCHER', message: 'Voucher khong hop le.' })
    }
    const label = String(req.body?.label || '').trim()
    const generatedLabel = voucherLabel(scope, type, value)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (label.length > 120) return res.status(400).json({ error: 'INVALID_VOUCHER', message: 'Ten voucher qua dai.' })
    const voucher = await issueVoucher(customerId, { label: label || generatedLabel, type, value, scope, expiresAt: date.toISOString(), source: 'admin' })
    res.status(201).json({ voucher })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.patch('/api/admin/vouchers/:code', requireAdmin, requireCsrf, async (req, res) => {
    const code = String(req.params.code || '').toUpperCase()
    const { type, value, scope } = req.body || {}
    const expires = new Date(req.body?.expiresAt)
    const label = String(req.body?.label || '').trim()
    if (!/^[A-Z2-9]{10}$/.test(code) || !['amount', 'percent'].includes(type) || !['goods', 'shipping'].includes(scope) ||
      !Number.isInteger(value) || value < 1 || value > (type === 'percent' ? 100 : 10000000) || label.length > 120 ||
      !Number.isFinite(expires.getTime()) || expires <= now() || expires.getTime() > now().getTime() + 365 * 86400000) {
      return res.status(400).json({ error: 'INVALID_VOUCHER' })
    }
    // Chỉ sửa voucher còn trong ví; mã và người sở hữu không đổi.
    const updated = await storeDb.query(`UPDATE customer_vouchers SET label = $1, type = $2, value = $3, scope = $4, expires_at = $5
      WHERE code = $6 RETURNING *`, [label || voucherLabel(scope, type, value), type, value, scope, expires.toISOString(), code])
    if (!updated.rows.length) return res.status(404).json({ error: 'VOUCHER_NOT_FOUND' })
    res.json({ voucher: publicVoucher(updated.rows[0]) })
  })

  app.delete('/api/admin/vouchers/:code', requireAdmin, requireCsrf, async (req, res) => {
    const code = String(req.params.code || '').toUpperCase()
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!/^[A-Z2-9]{10}$/.test(code)) return res.status(400).json({ error: 'INVALID_VOUCHER', message: 'Ma voucher khong hop le.' })
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const removed = await storeDb.transaction(async (tx) => {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const existsRes = await tx.query('SELECT code FROM voucher_codes WHERE code = $1', [code])
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!existsRes.rows.length) return false
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await tx.query('DELETE FROM customer_vouchers WHERE code = $1', [code])
      return true
    })
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!removed) return res.status(404).json({ error: 'VOUCHER_NOT_FOUND' })
    res.json({ ok: true, code })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.get('/api/admin/favorites', requireAdmin, async (req, res) => {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const favRes = await storeDb.query('SELECT product_id AS id, COUNT(*) AS count FROM customer_favorites GROUP BY product_id ORDER BY count DESC, product_id')
    const favorites = []
    for (const item of favRes.rows) {
      const product = await productById(item.id)
      favorites.push({ ...item, count: Number(item.count), name: product?.name || item.id, image: product?.image || null, symbol: product?.symbol || '✦' })
    }
    res.json({ favorites })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const revRes = await storeDb.query(
      `SELECT r.id, r.product_id AS "productId", r.rating, r.comment,
              r.admin_reply AS "adminReply", r.created_at AS "createdAt", c.username
       FROM product_reviews r JOIN customers c ON c.id = r.customer_id ORDER BY r.created_at DESC`,
    )
    const reviews = []
    for (const item of revRes.rows) {
      const product = await productById(item.productId)
      reviews.push({ ...item, productName: product?.name || item.productId })
    }
    res.json({ reviews })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  app.patch('/api/admin/reviews/:id/reply', requireAdmin, requireCsrf, async (req, res) => {
    const reply = String(req.body?.reply || '').trim()
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (reply.length < 1 || reply.length > 2000) return res.status(400).json({ error: 'INVALID_REPLY' })
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const result = await storeDb.query('UPDATE product_reviews SET admin_reply = $1, replied_at = $2 WHERE id = $3', [reply, now().toISOString(), Number(req.params.id)])
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!result.rowCount) return res.status(404).json({ error: 'REVIEW_NOT_FOUND' })
    res.json({ ok: true, reply })
  })

  // Route API: nhận request, kiểm tra quyền/dữ liệu rồi gọi nghiệp vụ tương ứng.
  registerStorefrontContact(app, { storeDb })
  registerOrderWorkflow(app, { storeDb, now, requireCustomer, customerCsrf, requireAdmin, requireCsrf, quote, issueVoucher, tierForPoints, pointsForPaidGoods, eventBroadcaster, paymentWebhookSecret })

  return { requireCustomer, customerCsrf }
}
