export function adminResponseKeyPrompt(scope) {
  // Model chỉ chọn mã; backend kiểm tra mã và xuất câu tiếng Việt từ dữ liệu đã xác minh.
  const task = scope === 'product'
    ? 'For a request about available Store products use product_summary; for unclear requests use clarify.'
    : scope === 'report'
      ? 'For a request about the supplied backend report use report_summary; for unclear requests use clarify.'
      : 'For a greeting use greeting; for unclear requests use clarify; for missing Store data use missing_data.'
  return 'Choose the responseKey for the user request. ' + task +
    ' Your final answer must be only JSON with exactly one property responseKey.'
}
