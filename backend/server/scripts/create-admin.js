/**
 * @codex-vn-doc
 * Tệp: server/scripts/create-admin.js
 * Mục đích: Lệnh quản trị/import dữ liệu; có thể ghi database hoặc file ảnh nên phải chạy đúng môi trường.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:process, ../src/config.js, ../src/db.js, ../src/security.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import { stdin, stdout } from 'node:process'
import { config } from '../src/config.js'
import { StoreDb } from '../src/db.js'
import { hashPassword } from '../src/security.js'

// Chức năng readHidden: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('Cần chạy lệnh trong terminal tương tác để nhập mật khẩu an toàn.'))
      return
    }

    stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''

    // Chức năng cleanup: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
    }

    // Chức năng onData: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
    const onData = (char) => {
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (char === '\u0003') {
        cleanup()
        process.exit(130)
      }
      if (char === '\r' || char === '\n') {
        cleanup()
        resolve(value)
        return
      }
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (char === '\u007f' || char === '\b') {
        // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
        if (value.length > 0) {
          value = value.slice(0, -1)
          stdout.write('\b \b')
        }
        return
      }
      // Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
      if (/^[\x20-\x7E]$/.test(char)) {
        value += char
        stdout.write('*')
      }
    }

    stdin.on('data', onData)
  })
}

const username = (process.argv[2] || '').trim()
// Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
if (!/^[A-Za-z0-9._-]{3,80}$/.test(username)) {
  console.error('Cách dùng: npm run create-admin -- <username>')
  console.error('Username dài 3-80 ký tự, chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.')
  process.exit(1)
}

const minimumLength = process.env.NODE_ENV === 'production' ? 12 : 4
const password = await readHidden(`Mật khẩu admin (${minimumLength}–256 ký tự): `)
// Edge case: điều kiện ngay sau chú thích là chốt bảo vệ; dữ liệu thiếu, sai, hết hạn, bị hủy hoặc không an toàn phải dừng tại đây.
if (password.length < minimumLength || password.length > 256) {
  console.error(`Mật khẩu phải có ${minimumLength}–256 ký tự.`)
  process.exit(1)
}
const confirm = await readHidden('Nhập lại mật khẩu: ')
if (password !== confirm) {
  console.error('Mật khẩu xác nhận không khớp.')
  process.exit(1)
}

const defaultTarget = config.databaseUrl ||
  (config.pgHost && config.pgUser && config.pgDatabase ? { host: config.pgHost, port: config.pgPort, user: config.pgUser, password: config.pgPassword, database: config.pgDatabase } : config.pgDataPath)

const storeDb = new StoreDb(defaultTarget)
try {
  await storeDb.ready
  if (await storeDb.getAdminByUsername(username)) {
    console.error('Admin đã tồn tại: ' + username)
    process.exitCode = 1
  } else {
    const { salt, hash } = hashPassword(password)
    await storeDb.createAdmin({ username, passwordSalt: salt, passwordHash: hash })
    console.log('Đã tạo admin: ' + username)
  }
} finally {
  await storeDb.close()
}
