/**
 * @codex-vn-doc
 * Tệp: server/test/context.test.js
 * Mục đích: Tệp kiểm thử tự động cho các luồng chính và tình huống biên của module này.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:assert/strict, node:test, ../src/context.js, ../src/db.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractStructuredMemory, prepareConversationContext, collectProductHints } from '../src/context.js'
import { StoreDb } from '../src/db.js'

// Chức năng tempDb: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function tempDb() {
  const db = new StoreDb(':memory:')
  await db.ready
  return { db, cleanup: async () => { await db.close() } }
}

// Kiểm thử edge case: clarifying reply preserves pending request until backend confirms exact resolution.
test('clarifying reply preserves pending request until backend confirms exact resolution', () => {
  const memory = extractStructuredMemory([
    { id: 1, role: 'user', content: 'Kiểm tra đơn ORDER-123 giúp tôi?', sources_json: '[]' },
    { id: 2, role: 'assistant', content: 'Bạn cho biết thêm thông tin nhé.', sources_json: '[]' },
  ])
  assert.equal(memory.pendingRequests.length, 1)
  const resolved = extractStructuredMemory([
    { id: 3, role: 'assistant', content: '', sources_json: JSON.stringify([{ id: 'action:1', kind: 'action', confirmed: true, resolvesMessageId: 1 }]) },
  ], memory)
  assert.equal(resolved.pendingRequests.length, 0)
})

// Kiểm thử edge case: recent product references precede old compact memory.
test('recent product references precede old compact memory', () => {
  assert.deepEqual(collectProductHints([
    { id: 8, role: 'assistant', sources_json: JSON.stringify([{ kind: 'product', id: 'product:2' }]) },
  ], { entities: [{ kind: 'product', id: '1', messageId: 1 }] }), ['2', '1'])
})

// Kiểm thử edge case: structured extraction keeps facts after character 420 and provenance.
test('structured extraction keeps facts after character 420 and provenance', () => {
  const longPrefix = 'x'.repeat(600)
  const memory = extractStructuredMemory([
    { id: 1, role: 'user', content: longPrefix + ' Tôi thích Tai nghe Everyday và mã đơn ORDER-ABC-123.', sources_json: '[]' },
    { id: 2, role: 'assistant', content: 'model text', sources_json: JSON.stringify([{ kind: 'product', id: 'product:1', label: 'backend product' }]) },
  ])
  assert.ok(memory.preferences.some((item) => item.text.includes('Tai nghe Everyday') && item.provenance === 'user_claim'))
  assert.ok(memory.entities.some((item) => item.kind === 'order' && item.id === 'ORDER-ABC-123' && item.provenance === 'user_claim'))
  assert.ok(memory.entities.some((item) => item.kind === 'product' && item.id === '1' && item.provenance === 'backend_source'))
})

// Kiểm thử edge case: prepareConversationContext preserves early structured facts across repeated extraction.
test('prepareConversationContext preserves early structured facts across repeated extraction', async () => {
  const { db, cleanup } = await tempDb()
  try {
    const conversation = await db.createConversation({ kind: 'support', ownerKey: 'owner' })
    await db.addMessage({ conversationId: conversation.id, role: 'user', content: 'Tôi thích tai nghe, mã đơn ORDER-OLD-999.' })
    await db.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'ok', sources: [{ kind: 'product', id: 'product:1', label: 'p1' }] })
    for (let index = 0; index < 20; index += 1) {
      await db.addMessage({ conversationId: conversation.id, role: 'user', content: 'Câu hỏi dài ' + index + ' '.repeat(50) + 'x'.repeat(200) })
      await db.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'Trả lời ' + index })
    }
    await prepareConversationContext({ storeDb: db, conversation: await db.getConversation(conversation.id), systemPrompt: 's', knowledgeText: 'k', numCtx: 8192, outputBudget: 128 })
    const afterFirst = await db.getConversation(conversation.id)
    const memoryFirst = db.getConversationMemory(afterFirst)
    assert.ok(memoryFirst.entities.some((item) => item.id === 'ORDER-OLD-999'))
    assert.ok(memoryFirst.entities.some((item) => item.kind === 'product' && item.id === '1'))

    for (let index = 20; index < 38; index += 1) {
      await db.addMessage({ conversationId: conversation.id, role: 'user', content: 'Tiếp ' + index + ' ' + 'y'.repeat(220) })
      await db.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'ok ' + index })
    }
    await prepareConversationContext({ storeDb: db, conversation: await db.getConversation(conversation.id), systemPrompt: 's', knowledgeText: 'k', numCtx: 8192, outputBudget: 128 })
    const afterSecond = await db.getConversation(conversation.id)
    const memorySecond = db.getConversationMemory(afterSecond)
    assert.ok(memorySecond.entities.some((item) => item.id === 'ORDER-OLD-999'))
    assert.ok(memorySecond.preferences.some((item) => item.provenance === 'user_claim'))
    assert.match(afterSecond.summary, /extractive_compaction/)
    const prepared = await prepareConversationContext({ storeDb: db, conversation: afterSecond, systemPrompt: 's', knowledgeText: 'k', numCtx: 65536, outputBudget: 128 })
    const memoryMessage = prepared.messages.find((item) => item.content.includes('BỘ NHỚ HỘI THOẠI'))
    assert.equal(memoryMessage.role, 'user')
    assert.match(memoryMessage.content, /ORDER-OLD-999/)
  } finally { await cleanup() }
})

// Kiểm thử edge case: failed extraction keeps prior summary, memory and marker intact.
test('failed extraction keeps prior summary, memory and marker intact', async () => {
  const { db, cleanup } = await tempDb()
  try {
    const conversation = await db.createConversation({ kind: 'support', ownerKey: 'owner' })
    await db.updateCompact({ conversationId: conversation.id, summary: 'good-summary', memory: { version: 1, entities: [{ kind: 'product', id: '1', provenance: 'backend_source' }], preferences: [], pendingRequests: [], evidence: [], confirmedActions: [] }, status: 'extracted', lastCompactedMessageId: 7 })
    for (let index = 0; index < 10; index += 1) await db.addMessage({ conversationId: conversation.id, role: 'user', content: 'z'.repeat(2000) })
    const convData = await db.getConversation(conversation.id)
    await assert.rejects(() => prepareConversationContext({ storeDb: db, conversation: convData, systemPrompt: 's'.repeat(2000), knowledgeText: 'k'.repeat(2000), numCtx: 8192, outputBudget: 1024 }))
    const after = await db.getConversation(conversation.id)
    assert.equal(after.summary, 'good-summary')
    assert.equal(Number(after.last_compacted_message_id), 7)
    assert.equal(db.getConversationMemory(after).entities[0].id, '1')
    assert.equal(after.compact_status, 'failed')
  } finally { await cleanup() }
})
