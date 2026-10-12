/**
 * @codex-vn-doc
 * Tệp: server/src/knowledge.js
 * Mục đích: Xây knowledge đã xác minh và lọc output AI khỏi số liệu/chính sách bịa.
 * Thành phần chính: searchProducts, renderVerifiedProducts, buildSupportKnowledge, isReportRequest, buildAdminKnowledge, screenSensitiveModelText, responseContract.
 * Liên kết trực tiếp: ../../shared/products.js, ../../shared/storePolicies.js, ./dates.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { products, productDataMeta } from '../../shared/products.js'
import { approvedPolicies, missingPolicyMessage } from '../../shared/storePolicies.js'
import { normalizeVietnamese, resolveReportRange } from './dates.js'

const STOP_WORDS = new Set([
  'san', 'pham', 'gia', 'mua', 'cho', 'toi', 'minh', 'ban', 'cua', 'store', 'tu', 'van', 'cai', 'do', 'nay',
])
const PRODUCT_TERMS = ['san pham', 'gia', 'mua', 'tai nghe', 'tui', 'dong ho', 'ly', 'cong nghe', 'phu kien', 'doi song', 'tu van']
const POLICY_TERMS = ['doi tra', 'hoan tien', 'bao hanh', 'giao hang', 'van chuyen', 'chinh sach', 'noi quy']
const REPORT_TERMS = ['doanh thu', 'thong ke', 'bao cao', 'don hang', 'refund', 'hoan tien']

// Chức năng includesAny: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function includesAny(normalized, terms) {
  return terms.some((term) => normalized.includes(term))
}

// Chức năng searchProducts: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function searchProducts(message, { limit = 4, fallbackIds = [] } = {}) {
  const normalized = normalizeVietnamese(message)
  const hasProductIntent = includesAny(normalized, PRODUCT_TERMS)
  const words = normalized
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))

  const ranked = products
    .map((product) => {
      const haystack = normalizeVietnamese([product.name, product.category, product.label].join(' '))
      const score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0)
      return { product, score }
    })
    .sort((a, b) => b.score - a.score)

  const matched = ranked.filter((entry) => entry.score > 0).map((entry) => entry.product)
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (matched.length > 0) return matched.slice(0, limit)

  const followUp = /\b(cai do|no|mon do|bao nhieu|gia bao nhieu)\b/.test(normalized)
  if (followUp) {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (fallbackIds.length > 1) return []
    const hinted = fallbackIds
      .map((id) => products.find((product) => String(product.id) === String(id)))
      .filter(Boolean)
    return hinted.slice(0, limit)
  }

  return hasProductIntent ? products.slice(0, limit) : []
}

// Chức năng renderVerifiedProducts: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function renderVerifiedProducts(matchedProducts) {
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (matchedProducts.length === 0) return null
  return {
    kind: 'products',
    dataMode: productDataMeta.mode,
    text: matchedProducts.map((product) =>
      'Mã ' + product.id + ' · ' + product.name + ': ' +
      new Intl.NumberFormat('vi-VN').format(product.price) + ' ₫ (' + product.category + ').'
    ).join('\n'),
    items: matchedProducts.map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      price: product.price,
      currency: productDataMeta.currency,
      dataMode: productDataMeta.mode,
    })),
  }
}

// Chức năng buildSupportKnowledge: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function buildSupportKnowledge(message, { productHints = [] } = {}) {
  const normalized = normalizeVietnamese(message)
  const matchedProducts = searchProducts(message, { fallbackIds: productHints })
  const policyRequested = includesAny(normalized, POLICY_TERMS)
  const priceIntent = normalized.includes('gia') || normalized.includes('bao nhieu')
  const sections = []
  const sources = []

  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (matchedProducts.length > 0) {
    sections.push(
      'DỮ LIỆU SẢN PHẨM CÓ CẤU TRÚC:\n' +
      matchedProducts.map((product) =>
        '- Mã ' + product.id + ': ' + product.name + '; danh mục ' + product.category +
        '; giá ' + product.price + ' VND; nhãn ' + product.label + '.'
      ).join('\n') +
      '\nKhông có dữ liệu tồn kho trong nguồn hiện tại.',
    )
    for (const product of matchedProducts) {
      sources.push({
        kind: 'product',
        id: 'product:' + product.id,
        label: 'Dữ liệu sản phẩm demo · ' + product.name,
        dataMode: productDataMeta.mode,
      })
    }
  }

  if (policyRequested) {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (approvedPolicies.length === 0) {
      sections.push('CHÍNH SÁCH ĐÃ DUYỆT: chưa có.')
      sources.push({
        kind: 'policy',
        id: 'policy:none',
        label: 'Chính sách Store · chưa có nội dung được duyệt',
      })
    } else {
      sections.push('CHÍNH SÁCH ĐÃ DUYỆT:\n' + approvedPolicies.map((item) => '- ' + item).join('\n'))
      sources.push({ kind: 'policy', id: 'policy:approved', label: 'Chính sách Store đã duyệt' })
    }
  }

  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (sections.length === 0) {
    sections.push('Không có dữ liệu Store liên quan được tra cứu cho câu hỏi này. Không suy đoán dữ liệu quan trọng.')
  }

  let deterministic = null
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (/\b(cai do|mon do|no)\b/.test(normalized) && productHints.length > 1 && matchedProducts.length === 0) {
    deterministic = { kind: 'clarify_product', text: 'Mình đang có nhiều sản phẩm trong hội thoại. Bạn cho biết tên hoặc mã sản phẩm muốn hỏi nhé.' }
  } else if (policyRequested && approvedPolicies.length === 0) {
    deterministic = { kind: 'policy_missing', text: missingPolicyMessage }
  } else if (priceIntent && matchedProducts.length > 0) {
    deterministic = { kind: 'verified_products', text: renderVerifiedProducts(matchedProducts).text }
  }

  return {
    text: sections.join('\n\n'),
    sources,
    matchedProducts,
    verified: renderVerifiedProducts(matchedProducts),
    policyRequested,
    priceIntent,
    deterministic,
  }
}

// Chức năng isReportRequest: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function isReportRequest(message) {
  return includesAny(normalizeVietnamese(message), REPORT_TERMS)
}

export { resolveReportRange }

// Chức năng buildAdminKnowledge: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
export function buildAdminKnowledge(message, report, { productHints = [] } = {}) {
  const support = buildSupportKnowledge(message, { productHints })
  const sections = [support.text]
  const sources = [...support.sources]

  if (report) {
    sections.push(
      'BÁO CÁO BACKEND ĐÃ TÍNH:\n' +
      '- Khoảng thời gian: ' + report.from + ' đến ' + report.to + ' (' + report.timezone + ').\n' +
      '- Trạng thái tính doanh thu: ' + report.includedStatuses.join(', ') + '.\n' +
      '- Đơn bị loại: ' + report.excludedStatuses.join(', ') + '.\n' +
      '- Tổng đơn trong khoảng: ' + report.allOrders + '.\n' +
      '- Đơn được tính: ' + report.includedOrders + '.\n' +
      '- Doanh thu gộp: ' + report.grossRevenue + ' ' + report.currency + '.\n' +
      '- Hoàn tiền đã trừ: ' + report.refunds + ' ' + report.currency + '.\n' +
      '- Doanh thu ròng: ' + report.netRevenue + ' ' + report.currency + '.\n' +
      '- Chế độ dữ liệu: ' + report.dataMode + '.\n' +
      'Chỉ nhận xét định tính; không lặp lại hay tự tạo số liệu/thời gian trong phần AI.',
    )
    sources.push({
      kind: 'report',
      id: 'report:revenue:' + report.from + ':' + report.to,
      label: 'Backend PostgreSQL · doanh thu ' + report.from + ' → ' + report.to,
      dataMode: report.dataMode,
    })
  }

  return { ...support, text: sections.join('\n\n'), sources }
}

// Chức năng screenSensitiveModelText: kiểm tra JSON của model trước khi phát cho khách hàng.
export function screenSensitiveModelText(text, { scope, freeForm = false }) {
  let decision
  try { decision = JSON.parse(text) } catch { /* rejected below */ }
  if (freeForm) {
    const answer = typeof decision?.answer === 'string' ? decision.answer.trim() : ''
    const legacyChoices = responseContract(scope).choices
    if (!answer && decision && typeof decision.responseKey === 'string' &&
        legacyChoices && Object.hasOwn(legacyChoices, decision.responseKey) && Object.keys(decision).length === 1) {
      return { accepted: true, text: legacyChoices[decision.responseKey] }
    }
    if (!decision || typeof decision !== 'object' || Array.isArray(decision) || !answer ||
        answer.length > 4000 || Object.keys(decision).length !== 1) {
      return { accepted: false, text: 'Nội dung AI không đáp ứng hợp đồng dữ liệu nên đã bị ẩn. Vui lòng làm rõ yêu cầu.' }
    }
    return { accepted: true, text: answer }
  }

  const choices = responseContract(scope).choices
  if (!decision || Array.isArray(decision) || typeof decision.responseKey !== 'string' || Object.keys(decision).length !== 1 ||
      !Object.hasOwn(choices, decision.responseKey)) {
    return { accepted: false, text: 'Nội dung AI không đáp ứng hợp đồng dữ liệu nên đã bị ẩn. Vui lòng dùng dữ liệu Store được hiển thị riêng hoặc làm rõ yêu cầu.' }
  }
  return { accepted: true, text: choices[decision.responseKey] }
}

// Chức năng responseContract: mô tả định dạng model phải trả về cho từng loại hội thoại.
export function responseContract(scope, { freeForm = false } = {}) {
  if (freeForm) {
    const legacyChoices = responseContract(scope).choices
    return {
      choices: legacyChoices,
      instruction: 'Chỉ trả JSON có một trường answer. Trả lời tiếng Việt tự nhiên, ngắn gọn, dựa đúng vào dữ liệu Store trong ngữ cảnh. Không tự tạo giá, tồn kho, chính sách, trạng thái đơn hoặc cam kết ngoài dữ liệu được cung cấp.',
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string', minLength: 1, maxLength: 4000 },
          responseKey: { type: 'string', enum: Object.keys(legacyChoices) },
        },
        required: ['answer'],
        additionalProperties: false,
      },
    }
  }

  const choices = scope === 'report' ? {
    report_summary: 'Báo cáo backend hiển thị khoảng ngày, doanh thu gộp, hoàn tiền và doanh thu ròng. Chưa có báo cáo đối chiếu nên chưa kết luận tăng trưởng hoặc nguyên nhân biến động.',
    clarify: 'Bạn muốn phân tích chỉ tiêu nào trong báo cáo đang hiển thị?',
  } : scope === 'product' ? {
    product_summary: 'Các sản phẩm liên quan và giá từ nguồn Store được hiển thị riêng. Bạn ưu tiên danh mục hoặc ngân sách nào để thu hẹp lựa chọn?',
    clarify: 'Bạn cho mình biết tên sản phẩm hoặc nhu cầu cụ thể nhé. Store chưa cung cấp thông tin tồn kho hay cam kết đổi trả cho lượt này.',
  } : {
    greeting: 'Chào bạn! Mình có thể giúp tìm sản phẩm và xem thông tin Store đã cung cấp. Bạn muốn tìm sản phẩm nào?',
    clarify: 'Bạn cho mình biết sản phẩm hoặc thông tin Store cần tìm nhé. Hiện chưa có đủ dữ liệu để xác nhận yêu cầu này.',
    missing_data: 'Store chưa cung cấp thông tin này.',
  }
  return {
    choices,
    instruction: 'Chỉ trả JSON có một trường responseKey. Chọn một mã trong: ' + JSON.stringify(choices) + '. Không thêm văn bản, số liệu hoặc cam kết ngoài schema.',
    schema: { type: 'object', properties: { responseKey: { type: 'string', enum: Object.keys(choices) } }, required: ['responseKey'], additionalProperties: false },
  }
}

