import { storeRoot, adminRoot } from './projectPaths.js'
/**
 * @codex-vn-doc
 * Tệp: server/scripts/import-1000-products.js
 * Mục đích: Lệnh quản trị/import dữ liệu; có thể ghi database hoặc file ảnh nên phải chạy đúng môi trường.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:fs, node:crypto, node:path, ../../shared/products.js, ../src/config.js, ../src/db.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { resolve } from 'node:path'
import { products as featuredProducts } from '../../shared/products.js'
import { config } from '../src/config.js'
import { StoreDb } from '../src/db.js'

const targetTotal = 2000
const dummyApi = 'https://dummyjson.com/products?limit=0'
const aboApi = 'https://store.halukaksoy.dev/api/products'
const aboImageRoot = 'https://amazon-berkeley-objects.s3.amazonaws.com/images/small/'
const serverRoot = config.serverRoot
const snapshotPath = resolve(storeRoot, 'src', 'data', 'imported-products.json')
const adminSnapshotPath = resolve(serverRoot, 'data', 'catalog-products.json')
const storeImageDir = resolve(storeRoot, 'public', 'products', 'imported')
const adminImageDir = resolve(adminRoot, 'public', 'products', 'imported')
const stageRoot = resolve(serverRoot, 'work', 'import-1000-products')
const stageImageDir = resolve(stageRoot, 'images')

const existing = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const existingIds = new Set(existing.map((item) => String(item.sourceId)))
const existingNames = new Set(existing.map((item) => String(item.name).toLocaleLowerCase('en')))
const usedNames = new Set(existingNames)

const laptopPattern = /\b(laptop|notebook|chromebook|macbook|ultrabook|netbook)\b/i
const componentPattern = /\b(cable|charger|adapter|connector|battery|usb|hdmi|keyboard|mouse|memory|ssd|router|phone case|mobile cover|headphone|speaker|tablet|smartphone)\b/i
const jewelryPattern = /\b(necklace|earrings?|bracelet|pendant|jewelry|gemstone|sapphire|aquamarine|watch|ring|gold|diamond)\b/i
const foodPattern = /\b(coffee|tea|cocoa|chocolate|candy|cookie|biscuit|snack|cereal|food|grocery|groceries|honey|jam|sauce|spice|rice|pasta|water|juice|drink|beverage)\b/i

// Chức năng shuffle: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function shuffle(items) {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1)
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

// Chức năng toneFor: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function toneFor(category) {
  return { 'Laptop': 'blue', 'Linh kiện': 'blue', 'Trang sức': 'rose', 'Thực phẩm': 'sand', 'Đồ gia dụng': 'green', 'Trang phục': 'sand' }[category] || 'green'
}

// Chức năng symbolFor: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function symbolFor(category) {
  return { 'Laptop': '▣', 'Linh kiện': '⌁', 'Trang sức': '◇', 'Thực phẩm': '✿', 'Đồ gia dụng': '⌂', 'Trang phục': '✦' }[category] || '✦'
}

// Chức năng dummyCategory: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function dummyCategory(item) {
  const category = String(item.category || '')
  if (category === 'groceries') return 'Thực phẩm'
  if (['laptops'].includes(category)) return 'Laptop'
  if (['mobile-accessories', 'smartphones', 'tablets'].includes(category)) return 'Linh kiện'
  if (['womens-jewellery', 'mens-watches', 'womens-watches', 'sunglasses'].includes(category)) return 'Trang sức'
  if (['furniture', 'home-decoration', 'kitchen-accessories'].includes(category)) return 'Đồ gia dụng'
  if (['mens-shirts', 'mens-shoes', 'tops', 'womens-bags', 'womens-dresses', 'womens-shoes'].includes(category)) return 'Trang phục'
  if (['beauty', 'fragrances', 'skin-care'].includes(category)) return 'Làm đẹp'
  if (['sports-accessories', 'motorcycle', 'vehicle'].includes(category)) return 'Ngoài trời'
  return 'Đồ gia dụng'
}

// Chức năng aboCategory: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function aboCategory(item) {
  const name = String(item.name || '')
  if (laptopPattern.test(name)) return 'Laptop'
  if (jewelryPattern.test(name)) return 'Trang sức'
  if (foodPattern.test(name)) return 'Thực phẩm'
  if (componentPattern.test(name)) return 'Linh kiện'
  return 'Đồ gia dụng'
}

// Chức năng validName: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function validName(name) {
  return typeof name === 'string' && name.length >= 5 && name.length <= 140 && Array.from(name).every((character) => character.charCodeAt(0) >= 32)
}

// Chức năng fetchJson: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) })
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
      return await response.json()
    } catch (error) {
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (attempt === 2) throw error
    }
  }
}

// Chức năng extension: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function extension(contentType, url) {
  if (contentType?.includes('webp') || url.toLowerCase().includes('.webp')) return '.webp'
  if (contentType?.includes('png') || url.toLowerCase().includes('.png')) return '.png'
  return '.jpg'
}

// Chức năng downloadImage: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function downloadImage(url) {
  try {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (bytes.length < 100 || bytes.length > 1000000) return null
    return { bytes, ext: extension(response.headers.get('content-type'), url) }
  } catch {
    return null
  }
}

// Chức năng loadDummyProducts: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function loadDummyProducts() {
  const payload = await fetchJson(dummyApi)
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (!Array.isArray(payload.products)) throw new Error('DummyJSON không trả về danh sách sản phẩm')
  const selected = []
  for (const item of shuffle(payload.products)) {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!validName(item.title) || !Number.isFinite(item.price) || item.price <= 0 || usedNames.has(item.title.toLocaleLowerCase('en'))) continue
    const imageUrl = item.images?.[0] || item.thumbnail
    const image = imageUrl ? await downloadImage(imageUrl) : null
    if (!image) continue
    const id = `dummyjson-${item.id}`
    const category = dummyCategory(item)
    const fileName = `${id}${image.ext}`
    const record = {
      id, source: 'dummyjson', sourceId: String(item.id), name: item.title.trim(), category,
      price: Math.max(1000, Math.round(item.price * 25000 / 1000) * 1000),
      description: `${String(item.description || '').trim()} Dữ liệu mẫu từ DummyJSON để thử giao diện; giá và tồn kho không phải giá bán thực tế.`,
      image: `/products/imported/${fileName}`,
      features: [item.brand ? `Thương hiệu dữ liệu mẫu: ${item.brand}` : `Nhóm dữ liệu: ${item.category}`, ...(Array.isArray(item.tags) ? item.tags.slice(0, 2).map((tag) => `Từ khóa: ${tag}`) : []), `Ảnh và metadata: DummyJSON · ${item.sku || 'không có SKU'}`].slice(0, 4),
      tone: toneFor(category), symbol: symbolFor(category), label: item.discountPercentage > 0 ? `Demo -${Math.round(item.discountPercentage)}%` : 'Demo',
      sourceUrl: `https://dummyjson.com/products/${item.id}`, sourcePriceCents: Math.round(item.price * 100), sourceCurrency: 'USD', importedAt: new Date().toISOString(),
      discountPercent: Math.max(0, Math.min(90, Math.round(item.discountPercentage || 0))),
      stageFile: resolve(stageImageDir, fileName),
    }
    selected.push({ record, image: image.bytes })
    usedNames.add(item.title.toLocaleLowerCase('en'))
  }
  return selected
}

// Chức năng loadAboCandidates: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function loadAboCandidates() {
  const candidates = []
  const seen = new Set()
  for (const slug of ['electronics', 'home', 'lifestyle']) {
    for (let page = 1; page <= 24; page += 3) {
      const pages = await Promise.all(Array.from({ length: 3 }, (_, offset) => fetchJson(`${aboApi}?category=${slug}&page=${page + offset}&per_page=100`)))
      for (const item of pages.flatMap((payload) => Array.isArray(payload.data) ? payload.data : [])) {
        const nameKey = String(item.name || '').toLocaleLowerCase('en')
        // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
        if (!/^[a-f0-9-]{36}$/i.test(item.uuid || '') || existingIds.has(item.uuid) || seen.has(item.uuid) || usedNames.has(nameKey) || !validName(item.name) || !Number.isInteger(item.price) || item.price <= 0 || !item.image_url?.startsWith(aboImageRoot) || /(renewed|diaper|incontinence|condom|pregnancy test)/i.test(item.name)) continue
        seen.add(item.uuid)
        candidates.push(item)
      }
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (pages.every((payload) => !Array.isArray(payload.data) || payload.data.length < 100)) break
    }
  }
  return shuffle(candidates)
}

// Chức năng loadAboProducts: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function loadAboProducts(needed) {
  const candidates = await loadAboCandidates()
  const selected = []
  for (let start = 0; start < candidates.length && selected.length < needed; start += 12) {
    const batch = await Promise.all(candidates.slice(start, start + 12).map(async (item) => ({ item, image: await downloadImage(item.image_url) })))
    for (const result of batch) {
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!result.image || selected.length >= needed) continue
      const item = result.item
      const category = aboCategory(item)
      const fileName = `abo-${item.uuid}.jpg`
      const bulletPoints = Array.isArray(item.bullet_points) ? item.bullet_points.filter((point) => typeof point === 'string' && point.trim() && point.length < 240).slice(0, 3) : []
      const record = {
        id: `demo-${item.uuid}`, source: 'mock-store-api', sourceId: item.uuid, name: item.name.trim(), category,
        price: Math.max(1000, Math.round(item.price * 25000 / 100000) * 1000),
        description: `Sản phẩm mẫu nhóm ${category}. Tên và ảnh từ Amazon Berkeley Objects; giá VND quy đổi cố định để thử giao diện, không phải giá bán thực tế.`,
        image: `/products/imported/${fileName}`, features: bulletPoints.length ? bulletPoints : ['Giá và tồn kho chỉ minh họa', 'Ảnh sản phẩm thuộc nguồn dữ liệu mẫu', `Phân loại: ${category}`],
        tone: toneFor(category), symbol: symbolFor(category), label: 'Demo', sourceUrl: `${aboApi}/${item.uuid}`, sourcePriceCents: item.price, sourceCurrency: 'USD', importedAt: new Date().toISOString(), discountPercent: 0,
        stageFile: resolve(stageImageDir, fileName),
      }
      selected.push({ record, image: result.image.bytes })
      usedNames.add(item.name.toLocaleLowerCase('en'))
    }
  }
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (selected.length !== needed) throw new Error(`ABO chỉ cung cấp ${selected.length}/${needed} sản phẩm mới có ảnh hợp lệ`)
  return selected
}

// Chức năng featuredRecords: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function featuredRecords() {
  const asset = { 1: 'headphones', 2: 'bag', 3: 'watch', 4: 'cup' }
  return featuredProducts.map((item) => ({
    id: String(item.id), source: 'store-featured', sourceId: `featured-${item.id}`, name: item.name, category: item.category, price: item.price,
    description: item.description, image: `/products/${asset[item.id]}.svg`, features: item.features, tone: item.tone, symbol: item.symbol, label: item.label,
    sourceUrl: 'local://store-featured', sourcePriceCents: Math.round(item.price / 250), sourceCurrency: 'VND', importedAt: new Date().toISOString(), discountPercent: 0,
  }))
}

// Chức năng main: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function main() {
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (existing.length > targetTotal - featuredProducts.length) throw new Error(`Snapshot đã có ${existing.length} mục; không tự ý ghi đè dữ liệu vượt mục tiêu.`)
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (existing.length === targetTotal - featuredProducts.length) {
    const snapshot = [...featuredRecords(), ...existing]
    mkdirSync(resolve(serverRoot, 'data'), { recursive: true })
    const defaultTarget = config.databaseUrl ||
      (config.pgHost && config.pgUser && config.pgDatabase ? { host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, database: config.pgDatabase } : config.pgDataPath)
    const db = new StoreDb(defaultTarget)
    try {
      await db.ready
      await db.upsertCatalogProducts(snapshot)
    } finally {
      await db.close()
    }
    console.log(`Đã xác nhận snapshot đồng bộ ${snapshot.length} sản phẩm.`)
    return
  }
  const needed = targetTotal - featuredProducts.length - existing.length
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(stageImageDir, { recursive: true })
  try {
    const dummy = await loadDummyProducts()
    const abo = await loadAboProducts(needed - dummy.length)
    const additions = [...dummy, ...abo]
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (additions.length !== needed || new Set(additions.map(({ record }) => record.id)).size !== needed) throw new Error(`Không tạo đủ ${needed} sản phẩm duy nhất`)
    for (const { record, image } of additions) writeFileSync(record.stageFile, image)
    mkdirSync(storeImageDir, { recursive: true })
    mkdirSync(adminImageDir, { recursive: true })
    for (const { record } of additions) {
      const storeDestination = resolve(storeImageDir, record.stageFile.split(/[/\\]/).pop())
      const adminDestination = resolve(adminImageDir, record.stageFile.split(/[/\\]/).pop())
      copyFileSync(record.stageFile, storeDestination)
      copyFileSync(record.stageFile, adminDestination)
      delete record.stageFile
    }
    for (const file of ['bag.svg', 'cup.svg', 'headphones.svg', 'watch.svg']) {
      const source = resolve(storeRoot, 'public', 'products', file)
      const destination = resolve(adminRoot, 'public', 'products', file)
      mkdirSync(resolve(adminRoot, 'public', 'products'), { recursive: true })
      copyFileSync(source, destination)
    }
    const snapshot = [...existing, ...additions.map(({ record }) => record)]
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
    writeFileSync(adminSnapshotPath, JSON.stringify([...featuredRecords(), ...snapshot], null, 2) + '\n', 'utf8')
    const defaultTarget = config.databaseUrl ||
      (config.pgHost && config.pgUser && config.pgDatabase ? { host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, database: config.pgDatabase } : config.pgDataPath)
    const db = new StoreDb(defaultTarget)
    try {
      await db.ready
      await db.upsertCatalogProducts([...featuredRecords(), ...snapshot])
    } finally {
      await db.close()
    }
    console.log(`Đã đồng bộ ${snapshot.length + featuredProducts.length} sản phẩm: ${featuredProducts.length} sản phẩm Store + ${snapshot.length} sản phẩm nhập.`)
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })

