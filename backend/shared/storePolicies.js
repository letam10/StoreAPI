/**
 * @codex-vn-doc
 * Tệp: shared/storePolicies.js
 * Mục đích: Danh sách chính sách đã được phê duyệt và thông báo khi thiếu chính sách.
 * Thành phần chính: approvedPolicies, missingPolicyMessage.
 * Liên kết trực tiếp: không có import/using trực tiếp được phát hiện.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
// Chỉ thêm nội quy/chính sách sau khi chủ dự án duyệt.
// Không tự suy diễn chính sách đổi trả, hoàn tiền, giao hàng hoặc bảo hành.
export const approvedPolicies = Object.freeze([])

export const missingPolicyMessage = 'Store chưa cung cấp thông tin này.'
