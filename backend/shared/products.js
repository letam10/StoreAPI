/**
 * @codex-vn-doc
 * Tệp: shared/products.js
 * Mục đích: Nguồn dữ liệu sản phẩm demo dùng chung giữa storefront và backend.
 * Thành phần chính: products, productDataMeta.
 * Liên kết trực tiếp: không có import/using trực tiếp được phát hiện.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
// Nguồn dữ liệu sản phẩm dùng chung cho frontend và backend.
// Đây là dữ liệu demo; không chứa tồn kho hoặc dữ liệu nghiệp vụ thời gian thực.
export const products = Object.freeze([
  {
    id: 1, name: 'Tai nghe Everyday', category: 'Công nghệ', price: 890000, symbol: '🎧', tone: 'green', label: 'Được yêu thích',
    description: 'Tai nghe gọn nhẹ cho nhu cầu nghe hằng ngày, tập trung vào thao tác đơn giản và thiết kế tối giản.',
    features: ['Thiết kế gọn nhẹ', 'Điều khiển trực quan', 'Phù hợp sử dụng hằng ngày'],
  },
  {
    id: 2, name: 'Túi Everyday Tote', category: 'Phụ kiện', price: 249000, symbol: '👜', tone: 'sand', label: 'Mới',
    description: 'Túi tote tối giản cho đồ dùng cá nhân, phù hợp đi học, đi làm hoặc mua sắm ngắn ngày.',
    features: ['Khoang chính rộng', 'Phong cách trung tính', 'Dễ phối đồ'],
  },
  {
    id: 3, name: 'Đồng hồ Minimal', category: 'Phụ kiện', price: 1290000, symbol: '⌚', tone: 'blue', label: 'Tối giản',
    description: 'Đồng hồ phong cách tối giản với mặt hiển thị rõ ràng, phù hợp nhiều hoàn cảnh sử dụng.',
    features: ['Mặt số dễ đọc', 'Thiết kế tối giản', 'Phong cách linh hoạt'],
  },
  {
    id: 4, name: 'Ly cà phê Morning', category: 'Đời sống', price: 159000, symbol: '☕', tone: 'rose', label: 'Mỗi ngày',
    description: 'Ly dùng hằng ngày cho cà phê, trà và đồ uống nóng, ưu tiên cảm giác cầm thoải mái.',
    features: ['Dùng cho đồ uống hằng ngày', 'Kiểu dáng đơn giản', 'Dễ vệ sinh'],
  },
])

export const productDataMeta = Object.freeze({
  mode: 'demo',
  currency: 'VND',
  hasInventory: false,
})
