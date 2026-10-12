import { PGlite } from '../backend/server/node_modules/@electric-sql/pglite/dist/index.js'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

const dataRoot = resolve(process.argv[2] || 'backend/server/data/pgdata')
const output = process.argv[3]
if (!output) throw new Error('Cần đường dẫn báo cáo, chỉ chạy khi backend đã dừng.')
const db = new PGlite(dataRoot)
try {
  const tables = await db.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `)
  const counts = {}
  for (const { tablename } of tables.rows) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('Tên bảng không hợp lệ')
    const result = await db.query('SELECT COUNT(*)::int AS count FROM "' + tablename + '"')
    counts[tablename] = result.rows[0].count
  }
  await writeFile(output, JSON.stringify({ tables: counts }, null, 2))
  console.log('Đã ghi số dòng của ' + Object.keys(counts).length + ' bảng; không xuất dữ liệu cá nhân.')
} finally {
  await db.close()
}
