import { storeRoot, adminRoot } from './projectPaths.js'
/**
 * @codex-vn-doc
 * Tệp: server/scripts/import-extra-products.js
 * Mục đích: Lệnh quản trị/import dữ liệu; có thể ghi database hoặc file ảnh nên phải chạy đúng môi trường.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:fs, node:path, node:crypto, ../src/config.js, ../src/db.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomInt } from 'node:crypto'
import { config } from '../src/config.js'
import { StoreDb } from '../src/db.js'

const root = storeRoot
const snapshot = resolve(root, 'src', 'data', 'imported-products.json')
const storeImages = resolve(root, 'public', 'products', 'imported')
const adminImages = resolve(adminRoot, 'public', 'products', 'imported')
const api = 'https://store.halukaksoy.dev/api/products'
const existing = JSON.parse(readFileSync(snapshot, 'utf8'))
const existingIds = new Set(existing.map((item) => item.sourceId))
const existingNames = new Set(existing.map((item) => item.name.toLowerCase()))
const computer = /\b(laptop|notebook|desktop|computer|monitor|keyboard|mouse|ssd|hard drive|processor|motherboard|graphics card|printer|webcam|cable|charger|adapter|usb|headphone|speaker|storage|memory|router|tablet|hdmi|vga)\b/i
const household = /\b(lamp|light|table|chair|shelf|cabinet|sofa|blanket|pillow|mirror|curtain|rug|storage|organizer|clock|bed|mattress|bath|towel|vacuum|fan|air purifier|humidifier|iron|kettle|coffee maker|blender|toaster|cookware|dish|mug|bottle|cleaner|basket)\b/i
const groups = [
  { slug: 'electronics', quota: 65, category: 'Điện tử', tone: 'blue', symbol: '⌘', match: () => true },
  { slug: 'home', quota: 150, category: 'Đồ gia dụng', tone: 'sand', symbol: '⌂', match: () => true },
  { slug: 'lifestyle', quota: 85, category: 'Đồ gia dụng', tone: 'green', symbol: '✿', match: (item) => household.test(item.name) },
]

// Chức năng fetchPage: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function fetchPage(slug, page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const response = await fetch(`${api}?category=${slug}&page=${page}&per_page=100`, { signal: AbortSignal.timeout(45000) })
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!response.ok) throw new Error(`Nguồn sản phẩm ${slug} trả HTTP ${response.status}`)
      return (await response.json()).data
    } catch (error) { if (attempt === 2) throw error }
  }
}

// Chức năng usable: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function usable(item, group) {
  return item && /^[a-f0-9-]{36}$/i.test(item.uuid || '') && !existingIds.has(item.uuid)
    && typeof item.name === 'string' && item.name.length >= 8 && item.name.length <= 100
    && Array.from(item.name).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126)
    && !existingNames.has(item.name.toLowerCase()) && Number.isInteger(item.price) && item.price > 0
    && item.image_url?.startsWith('https://amazon-berkeley-objects.s3.amazonaws.com/images/small/')
    && group.match(item)
}

// Chức năng shuffle: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

// Chức năng image: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function image(item) {
  // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
  const response = await fetch(item.image_url, { signal: AbortSignal.timeout(20000) })
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) return null
  const bytes = Buffer.from(await response.arrayBuffer())
  return bytes.length > 100 && bytes.length < 1000000 ? bytes : null
}

// Chức năng select: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function select(group) {
  const pages = group.slug === 'electronics' ? 24 : group.slug === 'home' ? 5 : 21
  const candidates = []
  for (let start = 1; start <= pages; start += 3) {
    const loaded = await Promise.all(Array.from({ length: Math.min(3, pages - start + 1) }, (_, index) => fetchPage(group.slug, start + index)))
    candidates.push(...loaded.flat().filter((item) => usable(item, group)))
  }
  const seen = new Set()
  const unique = shuffle(candidates.filter((item) => {
    const key = item.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }))
  if (group.slug === 'electronics') unique.sort((a, b) => Number(computer.test(b.name)) - Number(computer.test(a.name)))
  const selected = []
  for (let index = 0; index < unique.length && selected.length < group.quota; index += 12) {
    const images = await Promise.all(unique.slice(index, index + 12).map(async (item) => ({ item, bytes: await image(item).catch(() => null) })))
    for (const result of images) if (result.bytes && selected.length < group.quota) selected.push(result)
  }
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (selected.length !== group.quota) throw new Error(`Chỉ tìm được ${selected.length}/${group.quota} sản phẩm có ảnh trong ${group.slug}`)
  return selected
}

// Chức năng record: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function record(group, item, importedAt) {
  const brand = typeof item.brand === 'string' && item.brand.trim() ? item.brand.trim() : 'Không ghi'
  const features = Array.isArray(item.bullet_points) ? item.bullet_points.filter((point) => typeof point === 'string' && point.length < 250).slice(0, 3) : []
  return {
    id: `demo-${item.uuid}`, source: 'mock-store-api', sourceId: item.uuid,
    name: item.name.trim(), category: group.category,
    price: Math.max(1000, Math.round(item.price * 25000 / 100000) * 1000),
    description: `Sản phẩm mẫu nhóm ${group.category}. Tên và ảnh từ Amazon Berkeley Objects; giá VND quy đổi cố định để thử giao diện, không phải giá bán thực tế.`,
    image: `/products/imported/${item.uuid}.jpg`,
    features: features.length ? features : [`Thương hiệu dữ liệu mẫu: ${brand}`, 'Giá và tồn kho chỉ minh họa', 'Ảnh: Amazon Berkeley Objects (CC BY 4.0)'],
    tone: group.tone, symbol: group.symbol, label: 'Demo', sourceUrl: `${api}/${item.uuid}`,
    sourcePriceCents: item.price, sourceCurrency: 'USD', importedAt,
  }
}

// Chức năng main: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function main() {
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (existing.length !== 200) throw new Error('Danh mục gốc không còn đúng 200 sản phẩm; dừng để tránh ghi đè dữ liệu.')
  const selected = []
  for (const group of groups) selected.push({ group, items: await select(group) })
  const importedAt = new Date().toISOString()
  const extra = selected.flatMap(({ group, items }) => items.map(({ item }) => record(group, item, importedAt)))
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (extra.length !== 300 || new Set(extra.map((item) => item.id)).size !== 300) throw new Error('Không đủ 300 sản phẩm duy nhất')
  const defaultTarget = config.databaseUrl ||
    (config.pgHost && config.pgUser && config.pgDatabase ? { host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, database: config.pgDatabase } : config.pgDataPath)
  const db = new StoreDb(defaultTarget)
  try {
    await db.ready
    await db.upsertCatalogProducts(extra)
  } finally {
    await db.close()
  }
  mkdirSync(storeImages, { recursive: true })
  mkdirSync(adminImages, { recursive: true })
  for (const { items } of selected) for (const { item, bytes } of items) {
    writeFileSync(resolve(storeImages, `${item.uuid}.jpg`), bytes)
    writeFileSync(resolve(adminImages, `${item.uuid}.jpg`), bytes)
  }
  writeFileSync(snapshot, JSON.stringify([...existing, ...extra], null, 2) + '\n', 'utf8')
  console.log(`Đã thêm đúng ${extra.length} sản phẩm, tổng ${existing.length + extra.length} mục nhập.`)
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })

