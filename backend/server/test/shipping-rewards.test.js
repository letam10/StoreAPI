import assert from 'node:assert/strict'
import test from 'node:test'
import { rewardPrizes } from '../src/customer.js'
import { withCommerceServer, customerSession, adminSession, write } from './commerceTestHelpers.js'

test('shipping prizes keep the ten sectors and winning probability of the goods wheel', () => {
  const goods = rewardPrizes()
  const shipping = rewardPrizes('shipping')
  assert.equal(shipping.length, 10)
  assert.deepEqual(shipping.map(item => item.kind === 'none'), goods.map(item => item.kind === 'none'))
  assert.equal(shipping.filter(item => item.value === 50 && item.kind === 'percent').length, 3)
  assert.equal(shipping.filter(item => item.value === 100 && item.kind === 'percent').length, 1)
})

test('both wheels consume exactly ten shared credits under concurrent requests', async () => {
  await withCommerceServer(async ({ root, storeDb }) => {
    const customer = await customerSession(root)
    await storeDb.query('UPDATE customers SET spin_credits = 10 WHERE id = $1', [customer.account.id])
    const responses = await Promise.all(Array.from({ length: 16 }, (_, index) => write(root, '/api/customer/spin', customer, { wheel: index % 2 ? 'shipping' : 'goods' })))
    assert.equal(responses.filter(response => response.status === 200).length, 10)
    assert.equal(responses.filter(response => response.status === 409).length, 6)
    const outcomes = await Promise.all(responses.filter(response => response.ok).map(response => response.json()))
    assert.deepEqual(outcomes.map(item => item.spinCredits).sort((a, b) => a - b), [0,1,2,3,4,5,6,7,8,9])
    for (const outcome of outcomes) if (outcome.voucher) assert.equal(outcome.voucher.scope, outcome.wheel)
    assert.equal(Number((await storeDb.query('SELECT spin_credits FROM customers WHERE id = $1', [customer.account.id])).rows[0].spin_credits), 0)
    assert.equal((await write(root, '/api/customer/spin', customer, { wheel: 'invalid' })).status, 400)
  })
})

test('shipping voucher can be created edited to free shipping and deleted without changing goods', async () => {
  await withCommerceServer(async ({ root, storeDb }) => {
    const customer = await customerSession(root)
    const admin = await adminSession(root, storeDb)
    const values = { customerId: customer.account.id, scope: 'shipping', type: 'percent', value: 50, expiresAt: '2026-11-01T00:00:00.000Z' }
    const created = await write(root, '/api/admin/vouchers', admin, values)
    assert.equal(created.status, 201)
    const { voucher } = await created.json()
    const basket = { items: [{ id: 1, quantity: 1 }], fulfillment: 'delivery', region: 'hcm', voucherCodes: [voucher.code] }
    const before = await (await write(root, '/api/customer/quote', customer, basket)).json()
    assert.equal(before.shippingFee, 15000)
    assert.equal(before.goodsTotal, 890000)
    const updated = await write(root, '/api/admin/vouchers/' + voucher.code, admin, { ...values, value: 100 }, 'PATCH')
    assert.equal(updated.status, 200)
    assert.equal((await updated.json()).voucher.code, voucher.code)
    const after = await (await write(root, '/api/customer/quote', customer, basket)).json()
    assert.equal(after.shippingFee, 0)
    assert.equal(after.goodsTotal, before.goodsTotal)
    assert.equal((await write(root, '/api/admin/vouchers/' + voucher.code, admin, { ...values, value: 101 }, 'PATCH')).status, 400)
    assert.equal((await write(root, '/api/admin/vouchers/' + voucher.code, { ...admin, csrfToken: 'invalid' }, values, 'PATCH')).status, 403)
    assert.equal((await write(root, '/api/admin/vouchers/' + voucher.code, admin, {}, 'DELETE')).status, 200)
    assert.equal((await write(root, '/api/customer/quote', customer, basket)).status, 400)
  })
})

test('queries inside a transaction roll back together even through the shared database helper', async () => {
  await withCommerceServer(async ({ root, storeDb }) => {
    const customer = await customerSession(root)
    await assert.rejects(storeDb.transaction(async () => {
      await storeDb.query('UPDATE customers SET spin_credits = 99 WHERE id = $1', [customer.account.id])
      throw new Error('cancel-test-transaction')
    }), /cancel-test-transaction/)
    assert.equal(Number((await storeDb.query('SELECT spin_credits FROM customers WHERE id = $1', [customer.account.id])).rows[0].spin_credits), 0)
  })
})
