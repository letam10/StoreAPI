/**
 * @codex-vn-doc
 * Tệp: server/src/config.js
 * Mục đích: Đọc biến môi trường và tạo cấu hình runtime cho Node API.
 * Thành phần chính: ALLOWED_CONTEXT_SIZES, config.
 * Liên kết trực tiếp: node:fs, node:path, node:url.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(serverRoot, '.env')

// Chức năng loadLocalEnv: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function loadLocalEnv() {
  if (!existsSync(envPath)) return
  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    const key = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadLocalEnv()

export const ALLOWED_CONTEXT_SIZES = Object.freeze([8192, 16384, 32768, 65536])

// Chức năng integerEnv: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function integerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

// Chức năng allowedContext: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function allowedContext(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return ALLOWED_CONTEXT_SIZES.includes(parsed) ? parsed : fallback
}

const configuredDbPath = process.env.DB_PATH || 'data/store.sqlite'

export const config = Object.freeze({
  serverRoot,
  port: integerEnv('PORT', 3011, { min: 1, max: 65535 }),
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.5:4b',
  databaseUrl: process.env.DATABASE_URL || '',
  pgHost: process.env.PGHOST || '',
  pgPort: integerEnv('PGPORT', 5432, { min: 1, max: 65535 }),
  pgUser: process.env.PGUSER || '',
  pgPassword: process.env.PGPASSWORD || '',
  pgDatabase: process.env.PGDATABASE || '',
  pgDataPath: process.env.PGDATA_PATH ? resolve(serverRoot, process.env.PGDATA_PATH) : resolve(serverRoot, 'data/pgdata'),
  dbPath: resolve(serverRoot, configuredDbPath),
  supportContextSize: allowedContext(process.env.SUPPORT_NUM_CTX, 8192),
  adminDefaultContextSize: allowedContext(process.env.ADMIN_DEFAULT_NUM_CTX, 16384),
  supportNumPredict: integerEnv('SUPPORT_NUM_PREDICT', 384, { min: 64, max: 4096 }),
  adminNumPredict: integerEnv('ADMIN_NUM_PREDICT', 1024, { min: 64, max: 8192 }),
  ollamaTimeoutMs: integerEnv('OLLAMA_TIMEOUT_MS', 120000, { min: 5000, max: 600000 }),
  generationQueueMax: integerEnv('GENERATION_QUEUE_MAX', 4, { min: 0, max: 50 }),
  generationQueueWaitMs: integerEnv('GENERATION_QUEUE_WAIT_MS', 30000, { min: 1000, max: 300000 }),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || '',
  // Keep a small, clearly labelled dataset available for local development
  // unless the operator explicitly disables it in server/.env.
  enableDemoData: process.env.ENABLE_DEMO_DATA === undefined ? true : process.env.ENABLE_DEMO_DATA === 'true',
})
