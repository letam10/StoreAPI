import { storeRoot, adminRoot } from './projectPaths.js'
/*
 * @codex-vn-doc
 * Tệp: server/scripts/import-more-products.js
 * Mục đích: Nhập đúng 1.000 sản phẩm mới từ Amazon Berkeley Objects qua API dữ liệu mẫu, phân vào năm nhóm yêu cầu.
 * Thành phần chính: lấy dữ liệu có giới hạn tốc độ, lọc trùng, phân loại, tải ảnh, cập nhật snapshot và đồng bộ catalog DB.
 * Liên kết trực tiếp: Store/src/data/imported-products.json, Store/public/products/imported, server/data/catalog-products.json và StoreDb.
 * Cẩn trọng: script có side effect lên hai repo và database local; chỉ chạy khi đã kiểm tra branch, nguồn, dung lượng ảnh và kết quả đếm.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { products as featuredProducts } from '../../shared/products.js'
import { config } from '../src/config.js'
import { StoreDb } from '../src/db.js'

const SOURCE_API = 'https://store.halukaksoy.dev/api/products'
const SOURCE_IMAGE_ROOT = 'https://amazon-berkeley-objects.s3.amazonaws.com/images/small/'
const SOURCE_LICENSE = 'Amazon Berkeley Objects (CC BY 4.0)'
const TARGET_ADDITIONS = 1000
const TARGET_IMPORTED = 1996
const REQUEST_DELAY_MS = 1400
const sourceCategories = ['electronics', 'lifestyle']
const categoryTargets = Object.freeze({
  'Điện tử': 392,
  'Trang phục': 300,
  'Trang sức': 200,
  Laptop: 8,
  'Làm đẹp': 100,
})

const serverRoot = config.serverRoot
const storeSnapshotPath = resolve(storeRoot, 'src', 'data', 'imported-products.json')
const adminSnapshotPath = resolve(serverRoot, 'data', 'catalog-products.json')
const storeImageDir = resolve(storeRoot, 'public', 'products', 'imported')
const adminImageDir = resolve(adminRoot, 'public', 'products', 'imported')
const stageRoot = resolve(serverRoot, 'work', 'import-more-products')
const stageImageDir = resolve(stageRoot, 'images')

// Chức năng wait: tạm dừng giữa các request để không vượt giới hạn nguồn dữ liệu.
function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

// Chức năng normalizeName: chuẩn hóa tên để loại sản phẩm trùng do khác hoa thường/ký tự Unicode.
function normalizeName(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US')
}

// Chức năng fetchJson: tải JSON với timeout, retry và xử lý HTTP 429/5xx.
async function fetchJson(url) {
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) })
      if (response.ok) return await response.json()
      const retryAfter = Number(response.headers.get('retry-after') || 0)
      const delay = response.status === 429 ? Math.max(8000, retryAfter * 1000) : Math.min(12000, 1500 * (attempt + 1))
      lastError = new Error(`Nguồn trả HTTP ${response.status}: ${url}`)
      if (attempt < 5) await wait(delay)
    } catch (error) {
      lastError = error
      if (attempt < 5) await wait(Math.min(12000, 1500 * (attempt + 1)))
    }
  }
  throw lastError || new Error(`Không tải được nguồn: ${url}`)
}

// Chức năng sourceType: lấy loại sản phẩm do nguồn gắn trong mô tả dữ liệu.
function sourceType(item) {
  return String(item.description || '').match(/Source type:\s*([A-Z0-9_]+)/i)?.[1]?.toUpperCase() || ''
}

// Chức năng categoryFor: quy đổi source type/tên sản phẩm về đúng năm nhóm storefront.
function categoryFor(item) {
  const type = sourceType(item)
  const text = `${item.name || ''} ${item.description || ''} ${type}`.toLocaleLowerCase('en-US')
  if (/laptop|notebook|chromebook|macbook|ultrabook|netbook|notebook_computer|personal_computer/.test(text)) return 'Laptop'
  if (/beauty|health_personal_care|skin_|shampoo|conditioner|cosmetic|deodor|mouthwash|toothbrush|hair_|facial|lotion|moistur|makeup|perfume|fragrance|soap|vitamin|supplement|drugstore/.test(text)) return 'Làm đẹp'
  if (/jewel|earring|necklace|bracelet|anklet|pendant|gemstone|sapphire|aquamarine|topaz|diamond|gold|ring|watch|handbag|backpack|tote_bag|wallet|fashion|accessory/.test(text)) return 'Trang sức'
  if (/shoe|sandal|boot|apparel|clothing|shirt|dress|jacket|coat|pants|jean|skirt|sock|hat|glove|scarf|sneaker|footwear/.test(text)) return 'Trang phục'
  if (/electronic|computer|adapter|cable|charger|usb|hdmi|keyboard|mouse|speaker|headphone|tablet|smartphone|phone|monitor|router|printer|webcam|battery|camera|cellular|wireless|screen_protector/.test(text)) return 'Điện tử'
  return null
}

// Chức năng toneFor: chọn màu thẻ sản phẩm theo nhóm danh mục.
function toneFor(category) {
  return { 'Điện tử': 'blue', 'Trang phục': 'sand', 'Trang sức': 'rose', Laptop: 'blue', 'Làm đẹp': 'green' }[category] || 'green'
}

// Chức năng symbolFor: chọn biểu tượng đại diện theo nhóm danh mục.
function symbolFor(category) {
  return { 'Điện tử': '⌘', 'Trang phục': '✦', 'Trang sức': '◇', Laptop: '▣', 'Làm đẹp': '✿' }[category] || '✦'
}

// Chức năng validCandidate: chặn UUID/tên/giá/ảnh không hợp lệ và nội dung không phù hợp để nhập.
function validCandidate(item, existingIds, existingNames, seenIds, seenNames) {
  const name = normalizeName(item.name)
  const id = String(item.uuid || '')
  const forbidden = /(renewed|diaper|incontinence|condom|pregnancy test|marijuana|drug test)/i
  return /^[a-f0-9-]{36}$/i.test(id) && !existingIds.has(id) && !seenIds.has(id)
    && typeof item.name === 'string' && item.name.trim().length >= 5 && item.name.trim().length <= 160
    && !existingNames.has(name) && !seenNames.has(name) && !forbidden.test(item.name)
    && Number.isFinite(Number(item.price)) && Number(item.price) > 0
    && typeof item.image_url === 'string' && item.image_url.startsWith(SOURCE_IMAGE_ROOT)
}

// Chức năng loadCandidates: tải toàn bộ hai phân trang nguồn cần thiết rồi lọc thành các pool danh mục.
async function loadCandidates(existing) {
  const existingIds = new Set(existing.map((item) => String(item.sourceId || '')))
  const existingNames = new Set(existing.map((item) => normalizeName(item.name)))
  const seenIds = new Set()
  const seenNames = new Set()
  const pools = Object.fromEntries(Object.keys(categoryTargets).map((category) => [category, []]))

  for (const slug of sourceCategories) {
    const first = await fetchJson(`${SOURCE_API}?category=${slug}&page=1&per_page=100`)
    const totalPages = Number(first.meta?.total_pages || 1)
    const pages = [first]
    for (let page = 2; page <= totalPages; page += 1) {
      await wait(REQUEST_DELAY_MS)
      pages.push(await fetchJson(`${SOURCE_API}?category=${slug}&page=${page}&per_page=100`))
    }
    for (const item of pages.flatMap((payload) => Array.isArray(payload.data) ? payload.data : [])) {
      if (!validCandidate(item, existingIds, existingNames, seenIds, seenNames)) continue
      const category = categoryFor(item)
      if (!category) continue
      seenIds.add(String(item.uuid))
      seenNames.add(normalizeName(item.name))
      pools[category].push(item)
    }
  }

  for (const category of Object.keys(pools)) {
    pools[category].sort((left, right) => String(left.uuid).localeCompare(String(right.uuid)))
    if (pools[category].length < categoryTargets[category]) {
      throw new Error(`Nguồn chỉ còn ${pools[category].length}/${categoryTargets[category]} sản phẩm hợp lệ cho nhóm ${category}`)
    }
  }
  return pools
}

// Chức năng downloadImage: tải ảnh nhỏ hợp lệ và giới hạn kích thước để tránh commit file lỗi/quá lớn.
async function downloadImage(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    const contentType = response.headers.get('content-type') || ''
    if (!response.ok || !contentType.startsWith('image/')) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 100 || bytes.length > 1000000) return null
    return { bytes, extension: contentType.includes('png') ? '.png' : '.jpg' }
  } catch {
    return null
  }
}

// Chức năng priceVnd: quy đổi giá nguồn USD sang giá minh họa VND, làm tròn 1.000 đồng.
function priceVnd(price) {
  return Math.max(1000, Math.round(Number(price) * 25000 / 1000) * 1000)
}

// Chức năng makeRecord: tạo bản ghi ổn định cho snapshot Store và catalog DB.
function makeRecord(item, category, importedAt, imagePath) {
  const type = sourceType(item)
  const features = [
    item.brand ? `Thương hiệu nguồn: ${item.brand}` : '',
    type ? `Loại nguồn: ${type}` : '',
    item.marketplace ? `Marketplace: ${item.marketplace}` : '',
    SOURCE_LICENSE,
  ].filter(Boolean).slice(0, 4)
  return {
    id: `abo-more-${item.uuid}`,
    source: 'amazon-berkeley-objects',
    sourceId: item.uuid,
    name: item.name.trim(),
    category,
    price: priceVnd(item.price),
    description: `${String(item.description || '').trim()} Dữ liệu mẫu dùng cho kiểm thử giao diện; giá VND và tồn kho không phải giá bán thực tế.`,
    image: imagePath,
    images: [imagePath],
    features,
    tone: toneFor(category),
    symbol: symbolFor(category),
    label: 'Nguồn mẫu',
    sourceUrl: `${SOURCE_API}/${item.uuid}`,
    sourcePriceCents: Math.round(Number(item.price) * 100),
    sourceCurrency: String(item.currency || 'USD'),
    importedAt,
    discountPercent: 0,
    stockCount: 20,
  }
}

// Chức năng featuredRecords: chuyển bốn sản phẩm dùng chung sang snapshot DB admin.
function featuredRecords() {
  const asset = { 1: 'headphones', 2: 'bag', 3: 'watch', 4: 'cup' }
  return featuredProducts.map((item) => ({
    id: String(item.id), source: 'store-featured', sourceId: `featured-${item.id}`, name: item.name, category: item.category,
    price: item.price, description: item.description, image: `/products/${asset[item.id]}.svg`, features: item.features,
    tone: item.tone, symbol: item.symbol, label: item.label, sourceUrl: 'local://store-featured',
    sourcePriceCents: Math.round(item.price / 250), sourceCurrency: 'VND', importedAt: new Date().toISOString(), discountPercent: 0, stockCount: 20,
  }))
}

// Chức năng importProducts: điều phối tải nguồn, tải ảnh, ghi snapshot, upsert DB và dọn stage.
async function importProducts() {
  const existing = JSON.parse(readFileSync(storeSnapshotPath, 'utf8'))
  if (!Array.isArray(existing) || existing.length !== TARGET_IMPORTED - TARGET_ADDITIONS) {
    throw new Error(`Snapshot hiện có ${Array.isArray(existing) ? existing.length : 'không hợp lệ'} mục; cần đúng 996 mục trước khi thêm.`)
  }

  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(stageImageDir, { recursive: true })
  try {
    const pools = await loadCandidates(existing)
    const importedAt = new Date().toISOString()
    const additions = []
    for (const [category, quota] of Object.entries(categoryTargets)) {
      let accepted = 0
      for (let start = 0; start < pools[category].length && accepted < quota; start += 24) {
        const batch = pools[category].slice(start, start + 24)
        const results = await Promise.all(batch.map(async (item) => ({ item, category, image: await downloadImage(item.image_url) })))
        for (const result of results) {
          if (!result.image || accepted >= quota) continue
          const extension = result.image.extension
          const fileName = `abo-more-${result.item.uuid}${extension}`
          const stageFile = resolve(stageImageDir, fileName)
          writeFileSync(stageFile, result.image.bytes)
          additions.push({ item: result.item, category: result.category, fileName })
          accepted += 1
        }
      }
      if (accepted !== quota) throw new Error(`Tải ảnh chỉ đạt ${accepted}/${quota} cho nhóm ${category}; không ghi snapshot dở dang.`)
    }
    if (additions.length !== TARGET_ADDITIONS) {
      throw new Error(`Tải ảnh chỉ đạt ${additions.length}/${TARGET_ADDITIONS}; không ghi snapshot dở dang.`)
    }

    const records = additions.map(({ item, category, fileName }) => makeRecord(item, category, importedAt, `/products/imported/${fileName}`))
    const snapshot = [...existing, ...records]
    if (snapshot.length !== TARGET_IMPORTED) throw new Error(`Snapshot sau nhập có ${snapshot.length} thay vì ${TARGET_IMPORTED}.`)

    mkdirSync(storeImageDir, { recursive: true })
    mkdirSync(adminImageDir, { recursive: true })
    for (const { fileName } of additions) {
      const stageFile = resolve(stageImageDir, fileName)
      copyFileSync(stageFile, resolve(storeImageDir, fileName))
      copyFileSync(stageFile, resolve(adminImageDir, fileName))
    }

    writeFileSync(storeSnapshotPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
    writeFileSync(adminSnapshotPath, JSON.stringify([...featuredRecords(), ...snapshot], null, 2) + '\n', 'utf8')

    const defaultTarget = config.databaseUrl || (config.pgHost && config.pgUser && config.pgDatabase
      ? { host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, database: config.pgDatabase }
      : config.pgDataPath)
    const db = new StoreDb(defaultTarget)
    try {
      await db.ready
      await db.upsertCatalogProducts([...featuredRecords(), ...snapshot])
    } finally {
      await db.close()
    }

    const summary = Object.fromEntries(Object.entries(categoryTargets).map(([category, quota]) => [category, quota]))
    console.log(JSON.stringify({ added: additions.length, importedSnapshot: snapshot.length, apiCatalog: snapshot.length + featuredProducts.length, categories: summary, source: SOURCE_LICENSE }))
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
  }
}

importProducts().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})

