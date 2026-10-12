import { resolve } from 'node:path'

// Hai giao diện nằm ở D; backend và dữ liệu chạy trong repo Visual Studio ở C.
export const storeRoot = resolve(process.env.STORE_FRONTEND_ROOT || 'D:/Học Tập/Website_React/Store')
export const adminRoot = resolve('D:/Học Tập/Website_React/Store-Admin')
