import { storeRoot } from './projectPaths.js'
/**
 * @codex-vn-doc
 * Tệp: server/scripts/enrich-product-galleries.js
 * Mục đích: Lệnh quản trị/import dữ liệu; có thể ghi database hoặc file ảnh nên phải chạy đúng môi trường.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:fs, node:path, node:zlib.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { gunzipSync } from 'node:zlib'

const snapshotPath = resolve(storeRoot, 'src', 'data', 'imported-products.json')
const galleryDir = resolve(storeRoot, 'public', 'products', 'gallery')
const metadataUrl = 'https://amazon-berkeley-objects.s3.us-east-1.amazonaws.com/images/metadata/images.csv.gz'
const imageRoot = 'https://amazon-berkeley-objects.s3.us-east-1.amazonaws.com/images/small/'
const apiRoot = 'https://store.halukaksoy.dev/api/products/'
const products = JSON.parse(readFileSync(snapshotPath, 'utf8'))

// Chức năng rangedMetadata: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function rangedMetadata() {
  // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
  const head = await fetch(metadataUrl, { method: 'HEAD', signal: AbortSignal.timeout(15000) })
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (!head.ok) throw new Error('Không đọc được metadata ảnh')
  const size = Number(head.headers.get('content-length'))
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (!Number.isInteger(size) || size < 1000 || size > 20000000) throw new Error('Kích thước metadata ảnh không hợp lệ')
  const chunk = 524288
  const parts = await Promise.all(Array.from({ length: Math.ceil(size / chunk) }, async (_, index) => {
    const start = index * chunk
    const end = Math.min(size - 1, start + chunk - 1)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        const response = await fetch(metadataUrl, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(45000) })
        const bytes = Buffer.from(await response.arrayBuffer())
        // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
        if (response.status !== 206 || bytes.length !== end - start + 1) throw new Error('Metadata ảnh thiếu dữ liệu')
        return bytes
      } catch (error) { if (attempt === 2) throw error }
    }
  }))
  return gunzipSync(Buffer.concat(parts)).toString('utf8')
}

// Chức năng productDetail: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function productDetail(product) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const response = await fetch(apiRoot + product.sourceId, { signal: AbortSignal.timeout(20000) })
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (response.status === 429) { await new Promise((resolve) => setTimeout(resolve, 15000)); continue }
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!response.ok) throw new Error('Không đọc được chi tiết sản phẩm')
      const data = (await response.json()).data
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (data.uuid !== product.sourceId) throw new Error('Mã sản phẩm không khớp')
      return data
    } catch { if (attempt === 2) return null }
  }
}

// Chức năng imageBytes: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function imageBytes(path) {
  try {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const response = await fetch(imageRoot + path, { signal: AbortSignal.timeout(8000) })
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length > 100 && bytes.length < 1000000 ? bytes : null
  } catch { return null }
}

// Chức năng main: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function main() {
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (products.length !== 1996) throw new Error('Cần đúng 1.996 sản phẩm nhập trước khi bổ sung ảnh')
  const needed = products.filter((product) => product.description.startsWith('Sản phẩm mẫu nhóm'))
  const details = new Map()
  for (let start = 0; start < needed.length; start += 8) {
    const batch = needed.slice(start, start + 8)
    const loaded = await Promise.all(batch.map(productDetail))
    loaded.forEach((item, index) => { if (item) details.set(batch[index].sourceId, item) })
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (start + 8 < needed.length) await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  const ids = new Set()
  for (const detail of details.values()) for (const id of (detail.other_image_ids || []).slice(0, 8)) ids.add(id)
  const paths = new Map()
  for (const line of (await rangedMetadata()).split(/\r?\n/)) {
    const [id, , , path] = line.split(',')
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (ids.has(id) && /^[0-9a-f]{2}\/[0-9a-f]{8}\.(jpg|png)$/.test(path || '')) paths.set(id, path)
  }
  // Chức năng enrich: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  async function enrich(product) {
    const detail = details.get(product.sourceId)
    if (!detail) return { ...product, images: product.images || [product.image] }
    const candidates = (detail.other_image_ids || []).filter((id) => paths.has(id)).slice(0, 3)
    const loaded = await Promise.all(candidates.map(async (id) => ({ id, bytes: await imageBytes(paths.get(id)) })))
    const gallery = loaded.filter((item) => item.bytes).slice(0, 2)
    const features = Array.isArray(detail.bullet_points)
      ? detail.bullet_points.filter((point) => typeof point === 'string' && point.trim() && point.length <= 300).slice(0, 5)
      : []
    const updated = { ...product,
      description: typeof detail.description === 'string' && detail.description.trim() ? detail.description.trim() : product.description,
      features: features.length ? features : product.features,
      images: [product.image, ...gallery.map((item, index) => `/products/gallery/${product.sourceId}-${index + 1}${extname(paths.get(item.id))}`)],
    }
    gallery.forEach((item, index) => {
      item.destination = resolve(galleryDir, `${product.sourceId}-${index + 1}${extname(paths.get(item.id))}`)
    })
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (gallery.length) updated.galleryFiles = gallery
    return updated
  }
  const updates = []
  for (let start = 0; start < products.length; start += 16) {
    updates.push(...await Promise.all(products.slice(start, start + 16).map(enrich)))
  }
  mkdirSync(galleryDir, { recursive: true })
  let imageCount = 0
  for (const item of updates) {
    for (const image of item.galleryFiles || []) { writeFileSync(image.destination, image.bytes); imageCount += 1 }
    delete item.galleryFiles
  }
  writeFileSync(snapshotPath, JSON.stringify(updates, null, 2) + '\n', 'utf8')
  console.log(`Đã bổ sung ${imageCount} ảnh phụ cho ${updates.filter((item) => item.images.length > 1).length}/1.996 sản phẩm.`)
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })

