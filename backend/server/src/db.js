/**
 * @codex-vn-doc
 * Tệp: server/src/db.js
 * Mục đích: StoreDb: truy vấn và transaction cho catalog, khách hàng, voucher, đơn hàng, chat và admin.
 * Thành phần chính: StoreDb.
 * Liên kết trực tiếp: node:fs, node:path, node:crypto, pg, @electric-sql/pglite.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'

const { Pool } = pg

// Chức năng nowIso: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function nowIso() {
  return new Date().toISOString()
}

// Chức năng parseJson: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function parseJson(value, fallback) {
  // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

export class StoreDb {
  constructor(target, { seedDemoData = false } = {}) {
    this.seedDemoData = seedDemoData
    this.backendOwner = null
    this.transactionContext = new AsyncLocalStorage()
    this.isPglite = false
    this.target = target
    this._isInitializing = true

    if (typeof target === 'string' && (target.startsWith('postgres://') || target.startsWith('postgresql://'))) {
      this.pool = new Pool({ connectionString: target })
    } else if (target && typeof target === 'object' && (target.host || target.user || target.database || target.connectionString)) {
      this.pool = new Pool(target)
    } else {
      // Local/Embedded PostgreSQL via PGlite
      this.isPglite = true
      const dataDir = typeof target === 'string' && target !== ':memory:' ? target : undefined
      if (dataDir && dataDir !== ':memory:') {
        mkdirSync(dirname(dataDir), { recursive: true })
      }
      this.pglite = new PGlite(dataDir)
    }

    this.ready = this.#init(target).finally(() => {
      this._isInitializing = false
    })
  }

  async #init(target) {
    await this.#migrate()
    await this.#seedCatalogSnapshot(target)
    if (this.seedDemoData) {
      await this.seedDemoOrders()
      await this.seedDemoOperations()
    }
  }

  async #rawQuery(sqlText, params = []) {
    if (this.isPglite) {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const res = await this.pglite.query(sqlText, params)
      return { rows: res.rows || [], rowCount: res.affectedRows ?? res.rows?.length ?? 0 }
    }
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.pool.query(sqlText, params)
    return { rows: res.rows || [], rowCount: res.rowCount || 0 }
  }

  // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
  async query(sqlText, params = []) {
    if (!this._isInitializing) {
      await this.ready
    }
    const transaction = this.transactionContext.getStore()
    return transaction ? transaction.query(sqlText, params) : this.#rawQuery(sqlText, params)
  }

  // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
  async transaction(fn) {
    if (!this._isInitializing) {
      await this.ready
    }
    const active = this.transactionContext.getStore()
    if (active) return fn(active)
    if (this.isPglite) {
      // Hàng đợi gốc ngăn các request dùng chung một BEGIN/COMMIT.
      return this.pglite.transaction(async (transaction) => {
        const clientWrapper = {
          // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
          query: async (text, params = []) => {
            // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
            const res = await transaction.query(text, params)
            return { rows: res.rows || [], rowCount: res.affectedRows ?? res.rows?.length ?? 0 }
          },
        }
        // Các helper gọi query vẫn nằm trong cùng giao dịch để rollback đầy đủ.
        return this.transactionContext.run(clientWrapper, () => fn(clientWrapper))
      })
    }
    const client = await this.pool.connect()
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await client.query('BEGIN')
      const clientWrapper = {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        query: async (text, params = []) => client.query(text, params),
      }
      const result = await this.transactionContext.run(clientWrapper, () => fn(clientWrapper))
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await client.query('COMMIT')
      return result
    } catch (err) {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async close() {
    if (!this._isInitializing) {
      await this.ready
    }
    if (this.backendOwner) {
      try {
        await this.#rawQuery('DELETE FROM backend_owner WHERE token = $1', [this.backendOwner])
      } catch {
        // Ignore errors during shutdown
      }
    }
    if (this.isPglite) {
      await this.pglite.close?.()
    } else if (this.pool) {
      await this.pool.end()
    }
  }

  async #migrate() {
    const ddl = `
      CREATE TABLE IF NOT EXISTS backend_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        pid INTEGER NOT NULL,
        token TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_username_lower ON admins(LOWER(username));

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('support', 'admin')),
        owner_key TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        memory_json TEXT NOT NULL DEFAULT '{}',
        compact_status TEXT NOT NULL DEFAULT 'not_needed',
        last_compacted_message_id INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_owner
        ON conversations(kind, owner_key, updated_at);

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 1,
        sources_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, id);

      CREATE TABLE IF NOT EXISTS chat_turns (
        id SERIAL PRIMARY KEY,
        request_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('support', 'admin')),
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        assistant_message_id INTEGER,
        user_content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'stopped')),
        assistant_content TEXT NOT NULL DEFAULT '',
        sources_json TEXT NOT NULL DEFAULT '[]',
        report_json TEXT NOT NULL DEFAULT 'null',
        verified_json TEXT NOT NULL DEFAULT 'null',
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_key, request_id)
      );

      CREATE INDEX IF NOT EXISTS idx_chat_turns_conversation
        ON chat_turns(conversation_id, id);

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        business_date TEXT NOT NULL,
        status TEXT NOT NULL,
        total_amount INTEGER NOT NULL CHECK(total_amount >= 0),
        refund_amount INTEGER NOT NULL DEFAULT 0 CHECK(refund_amount >= 0),
        is_demo INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS catalog_products (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price INTEGER NOT NULL CHECK(price >= 0),
        description TEXT NOT NULL,
        image TEXT NOT NULL,
        features_json TEXT NOT NULL DEFAULT '[]',
        tone TEXT NOT NULL,
        symbol TEXT NOT NULL,
        label TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_price_cents INTEGER NOT NULL CHECK(source_price_cents >= 0),
        source_currency TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        discount_percent INTEGER NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 90),
        stock_count INTEGER NOT NULL DEFAULT 20 CHECK(stock_count >= 0),
        UNIQUE(source, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_products_category ON catalog_products(category, name);

      CREATE TABLE IF NOT EXISTS product_views (
        product_id TEXT PRIMARY KEY,
        view_count INTEGER NOT NULL DEFAULT 0 CHECK(view_count >= 0)
      );

      CREATE TABLE IF NOT EXISTS admin_records (
        id SERIAL PRIMARY KEY,
        module TEXT NOT NULL,
        title TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'Đang dùng',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_admin_records_module ON admin_records(module, updated_at);

      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 0,
        paid_goods_total INTEGER NOT NULL DEFAULT 0,
        spin_credits INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_username_lower ON customers(LOWER(username));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_lower ON customers(LOWER(email));

      CREATE TABLE IF NOT EXISTS customer_sessions (
        token_hash TEXT PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS voucher_codes (
        code TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customer_vouchers (
        code TEXT PRIMARY KEY REFERENCES voucher_codes(code),
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('amount','percent')),
        value INTEGER NOT NULL CHECK(value > 0),
        scope TEXT NOT NULL DEFAULT 'goods' CHECK(scope IN ('goods','shipping')),
        expires_at TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_customer_vouchers_owner ON customer_vouchers(customer_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_customer_vouchers_expiry ON customer_vouchers(expires_at);

      CREATE TABLE IF NOT EXISTS customer_favorites (
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(customer_id, product_id)
      );

      CREATE TABLE IF NOT EXISTS product_reviews (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        comment TEXT NOT NULL,
        admin_reply TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        replied_at TEXT,
        UNIQUE(customer_id, product_id)
      );
      CREATE INDEX IF NOT EXISTS idx_product_reviews_product ON product_reviews(product_id, created_at);

      CREATE TABLE IF NOT EXISTS customer_orders (
        id TEXT PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        items_json TEXT NOT NULL,
        recipient TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        fulfillment TEXT NOT NULL,
        region TEXT NOT NULL,
        distance_km INTEGER NOT NULL DEFAULT 0,
        weight_kg DOUBLE PRECISION NOT NULL DEFAULT 1,
        subtotal INTEGER NOT NULL,
        discount INTEGER NOT NULL,
        goods_total INTEGER NOT NULL,
        shipping_fee INTEGER NOT NULL,
        total INTEGER NOT NULL,
        voucher_codes_json TEXT NOT NULL,
        tier TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','paid')),
        points_earned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        paid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_customer_orders_owner ON customer_orders(customer_id, created_at);
      ALTER TABLE customer_orders DROP CONSTRAINT IF EXISTS customer_orders_status_check;
      ALTER TABLE customer_orders ADD CONSTRAINT customer_orders_status_check CHECK(status IN ('pending','paid','completed','cancelled','refunded'));
      ALTER TABLE customer_orders ALTER COLUMN subtotal TYPE BIGINT;
      ALTER TABLE customer_orders ALTER COLUMN discount TYPE BIGINT;
      ALTER TABLE customer_orders ALTER COLUMN goods_total TYPE BIGINT;
      ALTER TABLE customer_orders ALTER COLUMN shipping_fee TYPE BIGINT;
      ALTER TABLE customer_orders ALTER COLUMN total TYPE BIGINT;
      ALTER TABLE customers ALTER COLUMN paid_goods_total TYPE BIGINT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS shipping_base BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cod';
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'demo';
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_reference TEXT NOT NULL DEFAULT '';
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_confirmation TEXT NOT NULL DEFAULT '';
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS payment_reported_at TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'processing';
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS scheduled_at TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS delivered_at TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS late_compensated_at TEXT;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS refund_amount BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS extra_paid BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS voucher_snapshot_json TEXT NOT NULL DEFAULT '[]';
      UPDATE customer_orders SET shipping_base = shipping_fee WHERE shipping_base = 0 AND shipping_fee > 0;
      CREATE TABLE IF NOT EXISTS customer_after_sales (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('cancel','return','reschedule','merchant_fault')),
        status TEXT NOT NULL CHECK(status IN ('awaiting_confirmation','pending','awaiting_payment','awaiting_return','resolved','rejected','cancelled')),
        reason TEXT NOT NULL,
        fee_json TEXT NOT NULL,
        scheduled_at TEXT,
        fee_paid_at TEXT,
        refund_reference TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        compensation_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_after_sales_open ON customer_after_sales(order_id)
        WHERE status NOT IN ('resolved','rejected','cancelled');
      CREATE TABLE IF NOT EXISTS customer_order_events (
        id SERIAL PRIMARY KEY, order_id TEXT NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
        message TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `
    if (this.isPglite) {
      await this.pglite.exec(ddl)
    } else {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await this.pool.query(ddl)
    }
  }

  async claimBackend() {
    await this.ready
    const token = randomUUID()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.transaction(async (tx) => {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const res = await tx.query('SELECT * FROM backend_owner WHERE singleton = 1')
      const owner = res.rows[0]
      if (owner) {
        let alive = true
        try {
          process.kill(owner.pid, 0)
        } catch (error) {
          // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
          if (error.code === 'ESRCH') alive = false
        }
        // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
        if (alive) throw new Error('Database đang thuộc một backend còn hoạt động; không phục hồi lượt chat.')
      }
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await tx.query(
        'INSERT INTO backend_owner (singleton, pid, token) VALUES (1, $1, $2) ON CONFLICT (singleton) DO UPDATE SET pid = EXCLUDED.pid, token = EXCLUDED.token',
        [process.pid, token],
      )
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await tx.query(
        "UPDATE chat_turns SET status = 'failed', error_code = 'SERVER_RESTART', updated_at = $1 WHERE status = 'running'",
        [nowIso()],
      )
    })
    this.backendOwner = token
  }

  async seedDemoOrders() {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      `INSERT INTO orders (id, business_date, status, total_amount, refund_amount, is_demo)
       VALUES 
         ('DEMO-1001', '2026-09-01', 'completed', 890000, 0, 1),
         ('DEMO-1002', '2026-09-03', 'paid', 249000, 0, 1),
         ('DEMO-1003', '2026-09-07', 'completed', 1290000, 159000, 1),
         ('DEMO-1004', '2026-09-09', 'cancelled', 159000, 0, 1)
       ON CONFLICT (id) DO NOTHING`
    )
  }

  async seedDemoOperations() {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const exists = await this.query("SELECT 1 FROM admin_records WHERE module IN ('inventory','logistics','order-types','staff','overtime','support') LIMIT 1")
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (exists.rows.length) return
    const now = nowIso()
    const rows = [
      ['inventory', 'Nhập kho tuần 39', JSON.stringify({ kind: 'Nhập', warehouse: 'Kho trung tâm', quantity: '240' }), 'Đã duyệt'],
      ['inventory', 'Xuất kho đơn demo', JSON.stringify({ kind: 'Xuất', warehouse: 'Kho trung tâm', quantity: '36' }), 'Đang xử lý'],
      ['logistics', 'Tuyến TP.HCM → Bình Dương', JSON.stringify({ route: 'Nội thành', progress: 'Đang giao', updated: 'Hôm nay 09:30' }), 'Đang dùng'],
      ['logistics', 'Tuyến TP.HCM → Hà Nội', JSON.stringify({ route: 'Liên tỉnh', progress: 'Chờ lấy hàng', updated: 'Hôm qua 16:10' }), 'Chờ duyệt'],
      ['order-types', 'Đơn giao tận nơi', JSON.stringify({ priority: 'Cao', sla: '24 giờ', note: 'Ưu tiên hàng đã thanh toán' }), 'Đang dùng'],
      ['staff', 'Nguyễn Minh An', JSON.stringify({ role: 'Điều phối', shift: '08:00 – 17:00', login: 'an.store' }), 'Đang dùng'],
      ['staff', 'Trần Gia Hân', JSON.stringify({ role: 'CSKH', shift: '13:00 – 21:00', login: 'han.store' }), 'Đang dùng'],
      ['overtime', 'Trực cuối tuần', JSON.stringify({ kind: 'Tăng ca', value: '4 giờ', note: 'Hỗ trợ chốt đơn' }), 'Chờ duyệt'],
      ['support', 'CSKH · Đổi sản phẩm', JSON.stringify({ customer: 'tam.demo', topic: 'Đổi sản phẩm lỗi', assignee: 'Trần Gia Hân' }), 'Đang xử lý'],
    ]
    const placeholders = []
    const values = []
    let p = 1
    for (const [module, title, dataJson, status] of rows) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`)
      values.push(module, title, dataJson, status, now, now)
    }
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      `INSERT INTO admin_records (module, title, data_json, status, created_at, updated_at) VALUES ${placeholders.join(', ')}`,
      values,
    )
  }

  async #seedCatalogSnapshot(databasePath) {
    if (typeof databasePath !== 'string' || databasePath === ':memory:') return
    const snapshotPath = resolve(dirname(databasePath), 'catalog-products.json')
    if (!existsSync(snapshotPath)) return
    try {
      const products = JSON.parse(readFileSync(snapshotPath, 'utf8'))
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!Array.isArray(products) || products.length === 0) return
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const countRes = await this.query('SELECT COUNT(*) AS count FROM catalog_products')
      const current = Number(countRes.rows[0]?.count || 0)
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (current < products.length) await this.upsertCatalogProducts(products)
    } catch {
      // A corrupt optional snapshot must not prevent the backend from starting.
    }
  }

  async upsertCatalogProducts(products) {
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!products || !products.length) return
    const chunkSize = 50
    for (let i = 0; i < products.length; i += chunkSize) {
      const chunk = products.slice(i, i + chunkSize)
      const values = []
      const valueTuples = []
      let pIdx = 1

      for (let j = 0; j < chunk.length; j++) {
        const product = chunk[j]
        const index = i + j
        const featuresJson = typeof product.features === 'string' ? product.features : JSON.stringify(product.features || [])
        const discountPercent = product.discountPercent ?? (index < 8 ? 15 : 0)
        const stockCount = Number.isInteger(product.stockCount) && product.stockCount >= 0 ? product.stockCount : 20

        const placeholders = []
        for (let col = 0; col < 18; col++) {
          placeholders.push(`$${pIdx++}`)
        }
        valueTuples.push(`(${placeholders.join(', ')})`)

        values.push(
          String(product.id),
          product.source,
          String(product.sourceId || product.source_id || product.id),
          product.name,
          product.category,
          product.price,
          product.description,
          product.image,
          featuresJson,
          product.tone || 'green',
          product.symbol || '✦',
          product.label || 'Hàng mới',
          product.sourceUrl || product.source_url || '',
          product.sourcePriceCents ?? product.source_price_cents ?? 0,
          product.sourceCurrency || product.source_currency || 'VND',
          product.importedAt || product.imported_at || nowIso(),
          discountPercent,
          stockCount,
        )
      }

      const sql = `
        INSERT INTO catalog_products (
          id, source, source_id, name, category, price, description, image,
          features_json, tone, symbol, label, source_url, source_price_cents,
          source_currency, imported_at, discount_percent, stock_count
        ) VALUES ${valueTuples.join(',\n')}
        ON CONFLICT(id) DO UPDATE SET
          name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price,
          description = EXCLUDED.description, image = EXCLUDED.image,
          features_json = EXCLUDED.features_json, tone = EXCLUDED.tone,
          symbol = EXCLUDED.symbol, label = EXCLUDED.label, source_url = EXCLUDED.source_url,
          source_price_cents = EXCLUDED.source_price_cents,
          source_currency = EXCLUDED.source_currency, imported_at = EXCLUDED.imported_at,
          discount_percent = EXCLUDED.discount_percent, stock_count = EXCLUDED.stock_count
      `
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await this.query(sql, values)
    }
  }

  async listCatalogProducts() {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      'SELECT p.*, COALESCE(v.view_count, 0) AS view_count, COALESCE(f.favorite_count, 0) AS favorite_count FROM catalog_products p LEFT JOIN product_views v ON v.product_id = p.id LEFT JOIN (SELECT product_id, COUNT(*) AS favorite_count FROM customer_favorites GROUP BY product_id) f ON f.product_id = p.id ORDER BY p.category, p.name',
    )
    return res.rows.map((row) => ({
      id: row.id,
      source: row.source,
      sourceId: row.source_id,
      name: row.name,
      category: row.category,
      price: Number(row.price),
      description: row.description,
      image: row.image,
      features: parseJson(row.features_json, []),
      tone: row.tone,
      symbol: row.symbol,
      label: /\bdemo\b/i.test(row.label || '') ? (row.label || '').replace(/\bdemo\b/ig, '').trim() || 'Hàng mới' : row.label,
      sourceUrl: row.source_url,
      sourcePriceCents: Number(row.source_price_cents),
      sourceCurrency: row.source_currency,
      importedAt: row.imported_at,
      discountPercent: Number(row.discount_percent),
      stockCount: Number(row.stock_count),
      viewCount: Number(row.view_count || 0),
      favoriteCount: Number(row.favorite_count || 0),
    }))
  }

  async storefrontCatalog({ details = false } = {}) {
    if (details) return this.listCatalogProducts()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      'SELECT p.id, p.discount_percent, p.stock_count, COALESCE(v.view_count, 0) AS view_count, COALESCE(f.favorite_count, 0) AS favorite_count FROM catalog_products p LEFT JOIN product_views v ON v.product_id = p.id LEFT JOIN (SELECT product_id, COUNT(*) AS favorite_count FROM customer_favorites GROUP BY product_id) f ON f.product_id = p.id',
    )
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const featuredRes = await this.query(
      "SELECT product_id AS id, view_count FROM product_views WHERE product_id IN ('1', '2', '3', '4')",
    )
    const result = new Map(
      res.rows.map((row) => [
        String(row.id),
        { id: row.id, discountPercent: Number(row.discount_percent), stockCount: Number(row.stock_count), viewCount: Number(row.view_count || 0), favoriteCount: Number(row.favorite_count || 0) },
      ]),
    )
    for (const row of featuredRes.rows) {
      if (!result.has(String(row.id))) {
        result.set(String(row.id), { id: row.id, discountPercent: 0, stockCount: 20, viewCount: Number(row.view_count || 0), favoriteCount: 0 })
      }
    }
    return [...result.values()]
  }

  async updateCatalogOffer(id, { discountPercent, stockCount }) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      'UPDATE catalog_products SET discount_percent = $1, stock_count = $2 WHERE id = $3',
      [discountPercent, stockCount, String(id)],
    )
    return res.rowCount > 0
  }

  async getCatalogProduct(id) {
    const products = await this.listCatalogProducts()
    return products.find((product) => String(product.id) === String(id)) || null
  }

  async updateCatalogProduct(id, patch) {
    const columns = { name: 'name', category: 'category', price: 'price', description: 'description', image: 'image', label: 'label', sourceUrl: 'source_url', stockCount: 'stock_count' }
    const entries = Object.keys(columns).filter((key) => patch[key] !== undefined)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!entries.length) return this.getCatalogProduct(id)
    const assignments = entries.map((key, idx) => `${columns[key]} = $${idx + 1}`).join(', ')
    const values = entries.map((key) => patch[key])
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(`UPDATE catalog_products SET ${assignments} WHERE id = $${entries.length + 1}`, [...values, String(id)])
    return res.rowCount ? this.getCatalogProduct(id) : null
  }

  async deleteCatalogProduct(id) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('DELETE FROM catalog_products WHERE id = $1', [String(id)])
    return res.rowCount > 0
  }

  async listAdminRecords(module) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      'SELECT id, module, title, data_json, status, created_at, updated_at FROM admin_records WHERE module = $1 ORDER BY updated_at DESC, id DESC',
      [module],
    )
    return res.rows.map((row) => ({
      id: row.id,
      module: row.module,
      title: row.title,
      data: parseJson(row.data_json, {}),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async createAdminRecord({ module, title, data = {}, status = 'Đang dùng' }) {
    const timestamp = nowIso()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      'INSERT INTO admin_records (module, title, data_json, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [module, title, JSON.stringify(data), status, timestamp, timestamp],
    )
    return { id: res.rows[0].id, module, title, data, status, createdAt: timestamp, updatedAt: timestamp }
  }

  async updateAdminRecord(id, { module, title, data = {}, status = 'Đang dùng' }) {
    const timestamp = nowIso()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      'UPDATE admin_records SET module = $1, title = $2, data_json = $3, status = $4, updated_at = $5 WHERE id = $6',
      [module, title, JSON.stringify(data), status, timestamp, Number(id)],
    )
    return res.rowCount ? { id: Number(id), module, title, data, status, updatedAt: timestamp } : null
  }

  async deleteAdminRecord(id) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('DELETE FROM admin_records WHERE id = $1', [Number(id)])
    return res.rowCount > 0
  }

  async adminOverview() {
    // Chức năng count: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
    const count = async (table) => {
      try {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        const res = await this.query(`SELECT COUNT(*) AS count FROM ${table}`)
        return Number(res.rows[0]?.count || 0)
      } catch {
        return 0
      }
    }

    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const revenueRes = await this.query(`
      SELECT business_date AS date,
        COALESCE(SUM(CASE WHEN status IN ('paid','completed') THEN total_amount - refund_amount ELSE 0 END), 0) AS revenue,
        SUM(CASE WHEN status IN ('paid','completed') THEN 1 ELSE 0 END) AS orders
      FROM orders GROUP BY business_date ORDER BY business_date ASC
    `)
    const revenueByDay = revenueRes.rows.map((row) => ({ date: row.date, revenue: Number(row.revenue || 0), orders: Number(row.orders || 0) }))

    let customerRevenueByDay = []
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const custRes = await this.query(`
        SELECT SUBSTRING(COALESCE(paid_at, created_at) FROM 1 FOR 10) AS date,
          COALESCE(SUM(CASE WHEN status IN ('paid','completed') THEN total ELSE 0 END), 0) AS revenue,
          SUM(CASE WHEN status IN ('paid','completed') THEN 1 ELSE 0 END) AS orders
        FROM customer_orders
        GROUP BY SUBSTRING(COALESCE(paid_at, created_at) FROM 1 FOR 10)
        ORDER BY date ASC
      `)
      customerRevenueByDay = custRes.rows.map((row) => ({ date: row.date, revenue: Number(row.revenue || 0), orders: Number(row.orders || 0) }))
    } catch {
      // customer_orders table may not exist in early tests
    }

    const byDate = new Map()
    for (const item of [...revenueByDay, ...customerRevenueByDay]) {
      const current = byDate.get(item.date) || { date: item.date, revenue: 0, orders: 0 }
      current.revenue += item.revenue
      current.orders += item.orders
      byDate.set(item.date, current)
    }
    const combinedRevenueByDay = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    const revenue = combinedRevenueByDay.reduce((sum, item) => sum + item.revenue, 0)
    const includedOrders = combinedRevenueByDay.reduce((sum, item) => sum + item.orders, 0)
    const customerOrders = await count('customer_orders')
    const legacyOrders = await count('orders')

    let orderStatus = []
    for (const status of ['pending', 'paid', 'completed', 'cancelled']) {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const res = await this.query('SELECT COUNT(*) AS count FROM orders WHERE status = $1', [status])
      orderStatus.push({ status, count: Number(res.rows[0]?.count || 0) })
    }
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const custStatusRes = await this.query('SELECT status, COUNT(*) AS count FROM customer_orders GROUP BY status')
      const counts = new Map(orderStatus.map((item) => [item.status, Number(item.count || 0)]))
      for (const item of custStatusRes.rows) {
        counts.set(item.status, (counts.get(item.status) || 0) + Number(item.count || 0))
      }
      orderStatus = [...counts.entries()].map(([status, value]) => ({ status, count: value }))
    } catch {
      // Keep legacy status
    }

    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const openSupportRes = await this.query("SELECT COUNT(*) AS count FROM conversations WHERE kind = 'support'")
    const totalViews = await this.totalProductViews()

    return {
      products: await count('catalog_products'),
      customers: await count('customers'),
      orders: legacyOrders + customerOrders,
      customerOrders,
      legacyOrders,
      reviews: await count('product_reviews'),
      favorites: await count('customer_favorites'),
      records: await count('admin_records'),
      openSupport: Number(openSupportRes.rows[0]?.count || 0),
      totalViews,
      revenue,
      includedOrders,
      revenueByDay: combinedRevenueByDay,
      orderStatus,
    }
  }

  async recordProductView(id) {
    const strId = String(id)
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const exists = /^[1-4]$/.test(strId) || Boolean((await this.query('SELECT 1 FROM catalog_products WHERE id = $1', [strId])).rows.length)
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (!exists) return null
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      'INSERT INTO product_views (product_id, view_count) VALUES ($1, 1) ON CONFLICT(product_id) DO UPDATE SET view_count = product_views.view_count + 1',
      [strId],
    )
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('SELECT view_count FROM product_views WHERE product_id = $1', [strId])
    return Number(res.rows[0]?.view_count || 0)
  }

  async getProductViewCount(id) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('SELECT view_count FROM product_views WHERE product_id = $1', [String(id)])
    return Number(res.rows[0]?.view_count || 0)
  }

  async getProductFavoriteCount(id) {
    // Lệnh tích hợp: đếm lượt yêu thích công khai để Store xếp hạng độ yêu thích.
    const res = await this.query('SELECT COUNT(*) AS count FROM customer_favorites WHERE product_id = $1', [String(id)])
    return Number(res.rows[0]?.count || 0)
  }

  async totalProductViews() {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('SELECT COALESCE(SUM(view_count), 0) AS total FROM product_views')
    return Number(res.rows[0]?.total || 0)
  }

  async clearOrders() {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query('DELETE FROM orders')
  }

  async insertOrder({ id, businessDate, status, totalAmount, refundAmount = 0, isDemo = false }) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      'INSERT INTO orders (id, business_date, status, total_amount, refund_amount, is_demo) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, businessDate, status, totalAmount, refundAmount, isDemo ? 1 : 0],
    )
  }

  async getSetting(key) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('SELECT value FROM settings WHERE key = $1', [key])
    return res.rows[0]?.value ?? null
  }

  async setSetting(key, value) {
    const now = nowIso()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at',
      [key, String(value), now],
    )
  }

  async createAdmin({ username, passwordSalt, passwordHash }) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      'INSERT INTO admins (username, password_salt, password_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, passwordSalt, passwordHash, nowIso()],
    )
    return { lastInsertRowid: res.rows[0].id }
  }

  async getAdminByUsername(username) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('SELECT * FROM admins WHERE LOWER(username) = LOWER($1)', [username])
    return res.rows[0] ?? null
  }

  async createAdminSession({ tokenHash, adminId, expiresAt }) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      'INSERT INTO admin_sessions (token_hash, admin_id, expires_at, created_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, adminId, expiresAt, nowIso()],
    )
  }

  async getAdminSession(tokenHash) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      `SELECT s.token_hash, s.expires_at, a.id AS admin_id, a.username
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = $1`,
      [tokenHash],
    )
    return res.rows[0] ?? null
  }

  async expireAdminSessionForTest(tokenHash) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query('UPDATE admin_sessions SET expires_at = $1 WHERE token_hash = $2', ['2000-01-01T00:00:00.000Z', tokenHash])
  }

  async deleteAdminSession(tokenHash) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query('DELETE FROM admin_sessions WHERE token_hash = $1', [tokenHash])
  }

  async cleanupExpiredSessions() {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query('DELETE FROM admin_sessions WHERE expires_at <= $1', [nowIso()])
  }

  async createConversation({ kind, ownerKey }) {
    const now = nowIso()
    const conversation = {
      id: randomUUID(),
      kind,
      owner_key: ownerKey,
      summary: '',
      memory_json: '{}',
      compact_status: 'not_needed',
      last_compacted_message_id: 0,
      created_at: now,
      updated_at: now,
    }
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      `INSERT INTO conversations
         (id, kind, owner_key, summary, memory_json, compact_status, last_compacted_message_id, created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        conversation.id,
        conversation.kind,
        conversation.owner_key,
        conversation.summary,
        conversation.memory_json,
        conversation.compact_status,
        conversation.last_compacted_message_id,
        conversation.created_at,
        conversation.updated_at,
      ],
    )
    return conversation
  }

  async getConversation(id) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('SELECT * FROM conversations WHERE id = $1', [id])
    return res.rows[0] ?? null
  }

  async getMessages(conversationId) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id ASC', [conversationId])
    return res.rows
  }

  async getPublicHistory(conversationId) {
    const messages = await this.getMessages(conversationId)
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const turnRes = await this.query('SELECT * FROM chat_turns WHERE conversation_id = $1 ORDER BY id', [conversationId])
    const turns = turnRes.rows
    const linked = new Set(turns.map((turn) => Number(turn.user_message_id)))
    const assistantIds = new Set()
    for (const turn of turns) {
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (turn.status !== 'completed') continue
      if (turn.assistant_message_id) {
        assistantIds.add(Number(turn.assistant_message_id))
        continue
      }
      const nextUser = messages.find((message) => message.id > turn.user_message_id && message.role === 'user')
      const reply = messages.find(
        (message) =>
          message.id > turn.user_message_id &&
          (!nextUser || message.id < nextUser.id) &&
          message.role === 'assistant' &&
          message.content === turn.assistant_content,
      )
      if (reply) assistantIds.add(Number(reply.id))
    }
    const result = []
    for (const message of messages) {
      if (message.role === 'user' && linked.has(Number(message.id))) continue
      if (assistantIds.has(Number(message.id))) continue
      result.push({ ...message, sources: parseJson(message.sources_json, []), status: 'complete', position: Number(message.id) })
    }
    for (const turn of turns) {
      result.push({
        id: Number(turn.user_message_id),
        role: 'user',
        content: turn.user_content,
        sources: [],
        status: 'complete',
        position: Number(turn.user_message_id),
      })
      result.push({
        id: 'turn-' + turn.id,
        role: 'assistant',
        content: turn.assistant_content,
        sources: parseJson(turn.sources_json, []),
        verified: parseJson(turn.verified_json, null),
        report: parseJson(turn.report_json, null),
        status: turn.status === 'completed' ? 'complete' : turn.status === 'failed' ? 'error' : turn.status === 'running' ? 'pending' : 'stopped',
        requestId: turn.request_id,
        retryContent: turn.user_content,
        error: turn.error_code ? 'Lượt trước chưa hoàn tất. Bạn có thể thử lại.' : '',
        position: Number(turn.user_message_id) + 0.5,
      })
    }
    return result
      .sort((a, b) => a.position - b.position)
      .map((message) => {
        const copy = { ...message }
        delete copy.position
        return copy
      })
  }

  async addMessage({ conversationId, role, content, sources = [], completed = true }) {
    const now = nowIso()
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query(
      'INSERT INTO messages (conversation_id, role, content, completed, sources_json, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [conversationId, role, content, completed ? 1 : 0, JSON.stringify(sources), now],
    )
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [now, conversationId])
    return Number(res.rows[0].id)
  }

  async getTurn(ownerKey, requestId) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const res = await this.query('SELECT * FROM chat_turns WHERE owner_key = $1 AND request_id = $2', [ownerKey, requestId])
    return res.rows[0] ?? null
  }

  async startTurn({ ownerKey, kind, conversationId, requestId, message }) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    return this.transaction(async (tx) => {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const existingRes = await tx.query('SELECT * FROM chat_turns WHERE owner_key = $1 AND request_id = $2', [ownerKey, requestId])
      const existing = existingRes.rows[0]
      if (existing) {
        if (existing.kind !== kind || existing.user_content !== message) {
          return { state: 'conflict', turn: existing }
        }
        if (conversationId && existing.conversation_id !== conversationId) {
          return { state: 'conflict', turn: existing }
        }
        // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
        if (existing.status === 'completed') return { state: 'completed', turn: existing }
        // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
        if (existing.status === 'running') return { state: 'running', turn: existing }
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          `UPDATE chat_turns
           SET status = 'running', assistant_content = '', sources_json = '[]', report_json = 'null',
               verified_json = 'null', error_code = NULL, updated_at = $1
           WHERE id = $2`,
          [nowIso(), existing.id],
        )
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        const updatedRes = await tx.query('SELECT * FROM chat_turns WHERE id = $1', [existing.id])
        return { state: 'retry', turn: updatedRes.rows[0] }
      }

      let activeConversationId = conversationId
      if (conversationId) {
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        const convRes = await tx.query('SELECT * FROM conversations WHERE id = $1', [conversationId])
        const conversation = convRes.rows[0]
        if (!conversation || conversation.kind !== kind || conversation.owner_key !== ownerKey) {
          return { state: 'conversation_not_found', turn: null }
        }
      } else {
        const now = nowIso()
        const newConvId = randomUUID()
        // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
        await tx.query(
          `INSERT INTO conversations
             (id, kind, owner_key, summary, memory_json, compact_status, last_compacted_message_id, created_at, updated_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [newConvId, kind, ownerKey, '', '{}', 'not_needed', 0, now, now],
        )
        activeConversationId = newConvId
      }

      const now = nowIso()
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const msgRes = await tx.query(
        'INSERT INTO messages (conversation_id, role, content, completed, sources_json, created_at) VALUES ($1, $2, $3, 1, $4, $5) RETURNING id',
        [activeConversationId, 'user', message, '[]', now],
      )
      const userMessageId = Number(msgRes.rows[0].id)
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await tx.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [now, activeConversationId])

      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const turnRes = await tx.query(
        `INSERT INTO chat_turns
           (request_id, owner_key, kind, conversation_id, user_message_id, user_content, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8)
         RETURNING *`,
        [requestId, ownerKey, kind, activeConversationId, userMessageId, message, now, now],
      )
      return { state: 'created', turn: turnRes.rows[0] }
    })
  }

  async completeTurn({ turnId, content, sources = [], report = null, verified = null }) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    return this.transaction(async (tx) => {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const turnRes = await tx.query('SELECT * FROM chat_turns WHERE id = $1', [turnId])
      const turn = turnRes.rows[0]
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (!turn || turn.status !== 'running') return false

      const now = nowIso()
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const msgRes = await tx.query(
        'INSERT INTO messages (conversation_id, role, content, completed, sources_json, created_at) VALUES ($1, $2, $3, 1, $4, $5) RETURNING id',
        [turn.conversation_id, 'assistant', content, JSON.stringify(sources), now],
      )
      const assistantMessageId = Number(msgRes.rows[0].id)
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await tx.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [now, turn.conversation_id])

      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      await tx.query(
        `UPDATE chat_turns
         SET status = 'completed', assistant_content = $1, sources_json = $2, report_json = $3, verified_json = $4,
             assistant_message_id = $5, error_code = NULL, updated_at = $6
         WHERE id = $7`,
        [content, JSON.stringify(sources), JSON.stringify(report), JSON.stringify(verified), assistantMessageId, now, turnId],
      )
      return true
    })
  }

  async failTurn(turnId, { status = 'failed', errorCode = 'AI_ERROR', partialContent = '' } = {}) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      `UPDATE chat_turns
       SET status = $1, assistant_content = $2, error_code = $3, updated_at = $4
       WHERE id = $5 AND status = 'running'`,
      [status, partialContent, errorCode, nowIso(), turnId],
    )
  }

  getConversationMemory(conversation) {
    return parseJson(conversation?.memory_json || '{}', {})
  }

  async updateCompact({ conversationId, summary, memory, status, lastCompactedMessageId }) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query(
      `UPDATE conversations
       SET summary = $1, memory_json = $2, compact_status = $3, last_compacted_message_id = $4, updated_at = $5
       WHERE id = $6`,
      [summary, JSON.stringify(memory), status, lastCompactedMessageId, nowIso(), conversationId],
    )
  }

  async markCompactFailure(conversationId) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    await this.query('UPDATE conversations SET compact_status = $1, updated_at = $2 WHERE id = $3', ['failed', nowIso(), conversationId])
  }

  async calculateRevenue({ from, to }) {
    // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
    const rowRes = await this.query(
      `SELECT
         COUNT(*) AS all_orders,
         SUM(CASE WHEN status IN ('paid', 'completed') THEN 1 ELSE 0 END) AS included_orders,
         COALESCE(SUM(CASE WHEN status IN ('paid', 'completed') THEN total_amount ELSE 0 END), 0) AS gross_revenue,
         COALESCE(SUM(CASE WHEN status IN ('paid', 'completed') THEN refund_amount ELSE 0 END), 0) AS refunds,
         COALESCE(SUM(CASE WHEN status IN ('paid', 'completed') THEN total_amount - refund_amount ELSE 0 END), 0) AS net_revenue,
         SUM(CASE WHEN is_demo = 1 THEN 1 ELSE 0 END) AS demo_orders,
         SUM(CASE WHEN is_demo = 0 THEN 1 ELSE 0 END) AS real_orders
       FROM orders
       WHERE business_date BETWEEN $1 AND $2`,
      [from, to],
    )
    const row = rowRes.rows[0] || {}

    let customerRow = { all_orders: 0, included_orders: 0, gross_revenue: 0, refunds: 0, net_revenue: 0 }
    try {
      // Lệnh tích hợp: gọi mạng hoặc dữ liệu bên ngoài; cần xử lý timeout, lỗi và dữ liệu rỗng.
      const custRes = await this.query(
        `SELECT
           COUNT(*) AS all_orders,
           SUM(CASE WHEN status IN ('paid', 'completed') THEN 1 ELSE 0 END) AS included_orders,
           COALESCE(SUM(CASE WHEN status IN ('paid', 'completed') THEN total ELSE 0 END), 0) AS gross_revenue,
           0 AS refunds,
           COALESCE(SUM(CASE WHEN status IN ('paid', 'completed') THEN total ELSE 0 END), 0) AS net_revenue
         FROM customer_orders
         WHERE SUBSTRING(COALESCE(paid_at, created_at) FROM 1 FOR 10) BETWEEN $1 AND $2`,
        [from, to],
      )
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (custRes.rows[0]) customerRow = custRes.rows[0]
    } catch {
      // customer_orders may not exist
    }

    const allOrders = Number(row.all_orders || 0) + Number(customerRow.all_orders || 0)
    const demoOrders = Number(row.demo_orders || 0)
    const realOrders = Number(row.real_orders || 0) + Number(customerRow.all_orders || 0)
    let dataMode = 'none'
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    if (allOrders > 0 && demoOrders === allOrders) dataMode = 'demo'
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    else if (allOrders > 0 && realOrders === allOrders) dataMode = 'real'
    // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
    else if (allOrders > 0) dataMode = 'mixed'

    return {
      from,
      to,
      timezone: 'Asia/Ho_Chi_Minh',
      includedStatuses: ['paid', 'completed'],
      excludedStatuses: ['cancelled'],
      allOrders,
      includedOrders: Number(row.included_orders || 0) + Number(customerRow.included_orders || 0),
      grossRevenue: Number(row.gross_revenue || 0) + Number(customerRow.gross_revenue || 0),
      refunds: Number(row.refunds || 0) + Number(customerRow.refunds || 0),
      netRevenue: Number(row.net_revenue || 0) + Number(customerRow.net_revenue || 0),
      currency: 'VND',
      dataMode,
    }
  }
}
