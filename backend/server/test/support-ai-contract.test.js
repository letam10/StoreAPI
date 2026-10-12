import assert from 'node:assert/strict'
import test from 'node:test'
import { responseContract, screenSensitiveModelText } from '../src/knowledge.js'

test('chat khách hàng nhận câu trả lời tự nhiên từ model local', () => {
  const contract = responseContract('general', { freeForm: true })
  assert.deepEqual(contract.schema.required, ['answer'])
  assert.equal(contract.schema.properties.answer.maxLength, 4000)

  const result = screenSensitiveModelText(JSON.stringify({ answer: 'Store có thể giúp bạn tìm sản phẩm phù hợp.' }), {
    scope: 'general',
    freeForm: true,
  })
  assert.deepEqual(result, { accepted: true, text: 'Store có thể giúp bạn tìm sản phẩm phù hợp.' })
})

test('chat khách hàng không phát JSON sai hợp đồng', () => {
  const result = screenSensitiveModelText(JSON.stringify({ responseKey: 'not_a_choice' }), {
    scope: 'general',
    freeForm: true,
  })
  assert.equal(result.accepted, false)
})
