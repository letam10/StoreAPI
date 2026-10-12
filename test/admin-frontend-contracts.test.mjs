import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { adminRoot } from '../backend/server/scripts/projectPaths.js'

const serverRoot = new URL('../backend/server/', import.meta.url)
const { apiErrorMessage } = await import(
  pathToFileURL(join(adminRoot, 'src', 'api', 'userMessages.js')).href
)

// Kiểm tra hợp đồng giữa hai repo ở đây để bộ test giao diện không cần mã backend.
test('mọi mã lỗi backend tĩnh có thông báo tiếng Việt trong giao diện Admin', async () => {
  const source = new URL('src/', serverRoot)
  const codes = new Set()
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const text = await readFile(new URL(entry.name, source), 'utf8')
    const pattern = /(?:error:\s*|\.code\s*=\s*|new\s+\w*Error\()'([A-Z][A-Z0-9_]+)'/g
    for (const match of text.matchAll(pattern)) {
      if (!match[1].endsWith('_')) codes.add(match[1])
    }
  }
  assert.ok(codes.size >= 40)
  for (const error of codes) {
    assert.notEqual(apiErrorMessage({ error }), 'Không thể hoàn tất thao tác.', error)
  }
})

test('backend và lockfile dùng đúng runtime Node/npm đã chốt', async () => {
  assert.equal(process.versions.node, '24.19.0')
  const pkg = JSON.parse(await readFile(new URL('package.json', serverRoot), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('package-lock.json', serverRoot), 'utf8'))
  assert.deepEqual(pkg.engines, { node: '24.19.0', npm: '11.17.0' })
  assert.deepEqual(lock.packages[''].engines, pkg.engines)
  assert.equal(pkg.packageManager, 'npm@11.17.0')
})
