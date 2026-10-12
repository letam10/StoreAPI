/**
 * @codex-vn-doc
 * Tệp: server/scripts/migrate-sqlite-to-postgres.js
 * Mục đích: Lệnh quản trị/import dữ liệu; có thể ghi database hoặc file ảnh nên phải chạy đúng môi trường.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:fs, better-sqlite3, ../src/config.js, ../src/db.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { config } from '../src/config.js'
import { StoreDb } from '../src/db.js'

// Chức năng migrate: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function migrate() {
  const sqlitePath = config.dbPath
  if (!existsSync(sqlitePath)) {
    console.log(`[Migration] File SQLite nguồn không tồn tại: ${sqlitePath}. Bỏ qua sao chép dữ liệu.`)
    return
  }

  console.log(`[Migration] Bắt đầu chuyển dữ liệu từ SQLite (${sqlitePath}) sang PostgreSQL...`)
  const sqlite = new Database(sqlitePath, { readonly: true })

  const defaultTarget = config.databaseUrl ||
    (config.pgHost && config.pgUser && config.pgDatabase ? { host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, database: config.pgDatabase } : config.pgDataPath)
  console.log(`[Migration] Đang kết nối tới PostgreSQL (${typeof defaultTarget === 'string' ? defaultTarget : 'pool'})...`)
  const storeDb = new StoreDb(defaultTarget)
  await storeDb.ready
  console.log('[Migration] Khởi tạo schema PostgreSQL hoàn tất.')

  // Chức năng tableExists: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
  function tableExists(name) {
    const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name)
    return Boolean(row)
  }

  let totalRows = 0

  // 1. admins
  if (tableExists('admins')) {
    const rows = sqlite.prepare('SELECT * FROM admins').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO admins (id, username, password_salt, password_hash, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, password_salt=EXCLUDED.password_salt, password_hash=EXCLUDED.password_hash',
          [row.id, row.username, row.password_salt, row.password_hash, row.created_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} admin(s)`)
    totalRows += rows.length
  }

  // 2. admin_sessions
  if (tableExists('admin_sessions')) {
    const rows = sqlite.prepare('SELECT * FROM admin_sessions').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (token_hash) DO NOTHING',
          [row.token_hash, row.admin_id, row.expires_at, row.created_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} admin session(s)`)
    totalRows += rows.length
  }

  // 3. settings
  if (tableExists('settings')) {
    const rows = sqlite.prepare('SELECT * FROM settings').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at',
          [row.key, row.value, row.updated_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} cài đặt (settings)`)
    totalRows += rows.length
  }

  // 4. conversations
  if (tableExists('conversations')) {
    const rows = sqlite.prepare('SELECT * FROM conversations').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          `INSERT INTO conversations (id, kind, owner_key, summary, memory_json, compact_status, last_compacted_message_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [row.id, row.kind, row.owner_key, row.summary || '', row.memory_json || '{}', row.compact_status || 'not_needed', row.last_compacted_message_id || 0, row.created_at, row.updated_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} cuộc hội thoại (conversations)`)
    totalRows += rows.length
  }

  // 5. messages
  if (tableExists('messages')) {
    const rows = sqlite.prepare('SELECT * FROM messages').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO messages (id, conversation_id, role, content, completed, sources_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
          [row.id, row.conversation_id, row.role, row.content, row.completed ?? 1, row.sources_json || '[]', row.created_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} tin nhắn (messages)`)
    totalRows += rows.length
  }

  // 6. chat_turns
  if (tableExists('chat_turns')) {
    const rows = sqlite.prepare('SELECT * FROM chat_turns').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          `INSERT INTO chat_turns (id, request_id, owner_key, kind, conversation_id, user_message_id, assistant_message_id, user_content, status, assistant_content, sources_json, report_json, verified_json, error_code, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (owner_key, request_id) DO NOTHING`,
          [
            row.id, row.request_id, row.owner_key, row.kind, row.conversation_id, row.user_message_id, row.assistant_message_id,
            row.user_content, row.status, row.assistant_content || '', row.sources_json || '[]', row.report_json || 'null',
            row.verified_json || 'null', row.error_code, row.created_at, row.updated_at,
          ],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} chat turns`)
    totalRows += rows.length
  }

  // 7. orders
  if (tableExists('orders')) {
    const rows = sqlite.prepare('SELECT * FROM orders').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO orders (id, business_date, status, total_amount, refund_amount, is_demo) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
          [row.id, row.business_date, row.status, row.total_amount, row.refund_amount || 0, row.is_demo || 0],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} đơn hàng demo/legacy (orders)`)
    totalRows += rows.length
  }

  // 8. catalog_products
  if (tableExists('catalog_products')) {
    const rows = sqlite.prepare('SELECT * FROM catalog_products').all()
    await storeDb.upsertCatalogProducts(rows)
    console.log(` - Đã chuyển ${rows.length} sản phẩm (catalog_products)`)
    totalRows += rows.length
  }

  // 9. product_views
  if (tableExists('product_views')) {
    const rows = sqlite.prepare('SELECT * FROM product_views').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO product_views (product_id, view_count) VALUES ($1, $2) ON CONFLICT (product_id) DO UPDATE SET view_count=EXCLUDED.view_count',
          [row.product_id, row.view_count],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} lượt xem sản phẩm (product_views)`)
    totalRows += rows.length
  }

  // 10. admin_records
  if (tableExists('admin_records')) {
    const rows = sqlite.prepare('SELECT * FROM admin_records').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO admin_records (id, module, title, data_json, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
          [row.id, row.module, row.title, row.data_json || '{}', row.status || 'Đang dùng', row.created_at, row.updated_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} bản ghi quản trị (admin_records)`)
    totalRows += rows.length
  }

  // 11. customers
  if (tableExists('customers')) {
    const rows = sqlite.prepare('SELECT * FROM customers').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO customers (id, username, email, password_salt, password_hash, points, paid_goods_total, spin_credits, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING',
          [row.id, row.username, row.email, row.password_salt, row.password_hash, row.points || 0, row.paid_goods_total || 0, row.spin_credits || 0, row.created_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} tài khoản khách hàng (customers)`)
    totalRows += rows.length
  }

  // 12. customer_sessions
  if (tableExists('customer_sessions')) {
    const rows = sqlite.prepare('SELECT * FROM customer_sessions').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING',
          [row.token_hash, row.customer_id, row.expires_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} phiên khách hàng (customer_sessions)`)
    totalRows += rows.length
  }

  // 13. voucher_codes
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (tableExists('voucher_codes')) {
    const rows = sqlite.prepare('SELECT * FROM voucher_codes').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO voucher_codes (code, created_at) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING',
          [row.code, row.created_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} mã voucher đã cấp (voucher_codes)`)
    totalRows += rows.length
  }

  // 14. customer_vouchers
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (tableExists('customer_vouchers')) {
    const rows = sqlite.prepare('SELECT * FROM customer_vouchers').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO customer_vouchers (code, customer_id, label, type, value, scope, expires_at, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (code) DO NOTHING',
          [row.code, row.customer_id, row.label, row.type, row.value, row.scope || 'goods', row.expires_at, row.source, row.created_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} voucher khách hàng (customer_vouchers)`)
    totalRows += rows.length
  }

  // 15. customer_favorites
  if (tableExists('customer_favorites')) {
    const rows = sqlite.prepare('SELECT * FROM customer_favorites').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO customer_favorites (customer_id, product_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [row.customer_id, row.product_id, row.created_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} mục yêu thích (customer_favorites)`)
    totalRows += rows.length
  }

  // 16. product_reviews
  if (tableExists('product_reviews')) {
    const rows = sqlite.prepare('SELECT * FROM product_reviews').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          'INSERT INTO product_reviews (id, customer_id, product_id, rating, comment, admin_reply, created_at, replied_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING',
          [row.id, row.customer_id, row.product_id, row.rating, row.comment, row.admin_reply || '', row.created_at, row.replied_at],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} đánh giá sản phẩm (product_reviews)`)
    totalRows += rows.length
  }

  // 17. customer_orders
  if (tableExists('customer_orders')) {
    const rows = sqlite.prepare('SELECT * FROM customer_orders').all()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await storeDb.transaction(async (tx) => {
      for (const row of rows) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          `INSERT INTO customer_orders (
             id, customer_id, items_json, recipient, phone, address, fulfillment, region, distance_km, weight_kg,
             subtotal, discount, goods_total, shipping_fee, total, voucher_codes_json, tier, status, points_earned, created_at, paid_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
           ON CONFLICT (id) DO NOTHING`,
          [
            row.id, row.customer_id, row.items_json, row.recipient || '', row.phone || '', row.address || '', row.fulfillment,
            row.region, row.distance_km || 0, row.weight_kg ?? 1, row.subtotal, row.discount, row.goods_total, row.shipping_fee,
            row.total, row.voucher_codes_json || '[]', row.tier, row.status, row.points_earned || 0, row.created_at, row.paid_at,
          ],
        )
      }
    })
    console.log(` - Đã chuyển ${rows.length} đơn đặt hàng của khách (customer_orders)`)
    totalRows += rows.length
  }

  // Sequence synchronization
  const sequenceTables = [
    ['admins', 'id'],
    ['messages', 'id'],
    ['chat_turns', 'id'],
    ['admin_records', 'id'],
    ['customers', 'id'],
    ['product_reviews', 'id'],
  ]
  for (const [table, col] of sequenceTables) {
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await storeDb.query(`SELECT setval(pg_get_serial_sequence('${table}', '${col}'), COALESCE((SELECT MAX(${col}) FROM ${table}), 1))`)
    } catch {
      // Sequence handling
    }
  }

  sqlite.close()
  await storeDb.close()
  console.log(`\n✅ Hoàn tất chuyển đổi! Tổng cộng ${totalRows} dòng dữ liệu đã được nạp thành công vào hệ sinh thái PostgreSQL.\n`)
}

migrate().catch((err) => {
  console.error('[Migration Error]', err)
  process.exit(1)
})
