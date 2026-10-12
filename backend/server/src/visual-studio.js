import { createInterface } from 'node:readline'
import { createApp } from './app.js'
import { config } from './config.js'

// Visual Studio sở hữu tiến trình này và gửi lệnh dừng qua stdin riêng.
if (process.env.STORE_VISUAL_STUDIO !== 'true') {
  throw new Error('Hãy khởi động backend từ solution Store-Admin trong Visual Studio.')
}

const { app, storeDb } = createApp()
await storeDb.ready
await storeDb.claimBackend()
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log('[Store API] Sẵn sàng · Node nội bộ tại 127.0.0.1:' + config.port)
  console.log('[Store API] AI Local: ' + config.ollamaUrl + ' · ' + config.ollamaModel)
})

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  console.log('[Store API] Đang dừng và đóng database...')
  const deadline = setTimeout(() => process.exit(1), 8000)
  deadline.unref()
  server.close()
  server.closeAllConnections()
  await storeDb.close()
  clearTimeout(deadline)
  process.exit(0)
}

server.once('error', async error => {
  console.error('[Store API] Không mở được cổng:', error.code)
  await storeDb.close()
  process.exit(1)
})
const commands = createInterface({ input: process.stdin })
commands.on('line', line => {
  if (line === 'shutdown') void shutdown()
})
commands.on('close', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
