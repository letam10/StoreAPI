import { createApp } from '../src/app.js'
import { StoreDb } from '../src/db.js'
import { hashPassword } from '../src/security.js'

export async function withCommerceServer(run, overrides = {}) {
  const storeDb = new StoreDb(':memory:')
  await storeDb.ready
  let clock = new Date('2026-10-02T02:00:00.000Z')
  const { app } = createApp({ ...overrides, storeDb, now: () => new Date(clock) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const root = 'http://127.0.0.1:' + server.address().port
  try { await run({ root, storeDb, setNow: value => { clock = new Date(value) } }) }
  finally { await new Promise(resolve => server.close(resolve)); await storeDb.close() }
}

export async function customerSession(root, name = 'buyer') {
  const response = await fetch(root + '/api/customer/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, email: name + '@example.invalid', password: 'local-test-password' }),
  })
  const { account } = await response.json()
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: account.csrfToken, account }
}

export async function adminSession(root, storeDb) {
  const { salt, hash } = hashPassword('local-admin-test-password')
  await storeDb.createAdmin({ username: 'test-owner', passwordSalt: salt, passwordHash: hash })
  const response = await fetch(root + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-owner', password: 'local-admin-test-password' }),
  })
  return { cookie: response.headers.get('set-cookie').split(';')[0], ...await response.json() }
}

export function write(root, path, session, body = {}, method = 'POST') {
  return fetch(root + path, { method, headers: {
    cookie: session.cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken,
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
}
