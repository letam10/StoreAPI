/**
 * @codex-vn-doc
 * Tệp: server/test/ollama-http.test.js
 * Mục đích: Tệp kiểm thử tự động cho các luồng chính và tình huống biên của module này.
 * Thành phần chính: các hàm/lớp và xử lý nội bộ trong tệp.
 * Liên kết trực tiếp: node:assert/strict, node:http, node:test, ../src/ollama.js.
 * Cẩn trọng: khi sửa hàm, route, state, schema hoặc export phải kiểm tra các tệp gọi nó; các nhánh lỗi, dữ liệu rỗng, hủy request và dữ liệu không hợp lệ phải giữ đúng hợp đồng hiện tại.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { OllamaClient } from '../src/ollama.js'

// Chức năng withFakeOllama: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function withFakeOllama(handler, run) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  try { await run('http://127.0.0.1:' + port) } finally { await new Promise((resolve) => server.close(resolve)) }
}

// Chức năng collect: xử lý dữ liệu theo hợp đồng của hàm; kiểm tra đầu vào, nhánh lỗi và kết quả trước khi trả cho nơi gọi.
async function collect(client, options = {}) {
  const events = []
  for await (const event of client.chatStream({ messages: [], think: false, numCtx: 8192, numPredict: 10, ...options })) events.push(event)
  return events
}

// Kiểm thử edge case: parses split chunks, unicode and terminal frame without trailing newline.
test('parses split chunks, unicode and terminal frame without trailing newline', async () => {
  await withFakeOllama((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const body = '{"message":{"role":"assistant","content":"Xin chào 🌱"},"done":false}\n{"done":true,"done_reason":"stop","eval_count":3}'
    const bytes = Buffer.from(body)
    res.write(bytes.subarray(0, 17)); res.write(bytes.subarray(17, 39)); res.end(bytes.subarray(39))
  }, async (baseUrl) => {
    const client = new OllamaClient({ baseUrl, model: 'qwen3.5:4b', timeoutMs: 1000 })
    const events = await collect(client)
    assert.equal(events[0].content, 'Xin chào 🌱')
    assert.equal(events.at(-1).type, 'terminal')
    assert.equal(events.at(-1).status, 'complete')
  })
})

// Kiểm thử edge case: rejects malformed json, wrong payload and error frames.
test('rejects malformed json, wrong payload and error frames', async () => {
  for (const body of ['not-json\n', '{"message":[],"done":false}\n', '{"error":"boom"}\n']) {
    await withFakeOllama((req, res) => { res.writeHead(200); res.end(body) }, async (baseUrl) => {
      const client = new OllamaClient({ baseUrl, model: 'm', timeoutMs: 1000 })
      await assert.rejects(() => collect(client), /Ollama|Frame|Stream/)
    })
  }
})

// Kiểm thử edge case: early EOF after partial content is an error.
test('early EOF after partial content is an error', async () => {
  await withFakeOllama((req, res) => { res.writeHead(200); res.end('{"message":{"role":"assistant","content":"một phần"},"done":false}\n') }, async (baseUrl) => {
    const client = new OllamaClient({ baseUrl, model: 'm', timeoutMs: 1000 })
    await assert.rejects(() => collect(client), (error) => error.code === 'OLLAMA_EARLY_EOF')
  })
})

// Kiểm thử edge case: token limit is terminal but not complete.
test('token limit is terminal but not complete', async () => {
  await withFakeOllama((req, res) => { res.writeHead(200); res.end('{"message":{"role":"assistant","content":"x"},"done":false}\n{"done":true,"done_reason":"length","eval_count":10}\n') }, async (baseUrl) => {
    const client = new OllamaClient({ baseUrl, model: 'm', timeoutMs: 1000 })
    const events = await collect(client)
    assert.equal(events.at(-1).status, 'max_tokens')
  })
})

// Kiểm thử edge case: thinking is never emitted.
test('thinking is never emitted', async () => {
  await withFakeOllama((req, res) => { res.writeHead(200); res.end('{"message":{"role":"assistant","content":"ok","thinking":"secret"},"done":false}\n{"done":true,"done_reason":"stop"}\n') }, async (baseUrl) => {
    const client = new OllamaClient({ baseUrl, model: 'm', timeoutMs: 1000 })
    const events = await collect(client)
    assert.equal(JSON.stringify(events).includes('secret'), false)
  })
})

test('preserves thinking and schema options while waiting for the final JSON', async () => {
  const format = {
    type: 'object',
    properties: { responseKey: { type: 'string', enum: ['greeting'] } },
    required: ['responseKey'],
    additionalProperties: false,
  }
  for (const think of [true, false]) {
    let request
    await withFakeOllama(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      request = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ message: { thinking: 'private', content: '' }, done: false }) + '\n')
      res.end(JSON.stringify({
        message: { content: '{"responseKey":"greeting"}', thinking: 'private terminal' },
        done: true,
        done_reason: 'stop',
        eval_count: 9,
      }))
    }, async (baseUrl) => {
      const client = new OllamaClient({ baseUrl, model: 'm', timeoutMs: 1000 })
      const messages = [{ role: 'user', content: 'Hello' }]
      const events = await collect(client, { messages, think, format })
      assert.equal(request.think, think)
      assert.equal(request.stream, true)
      assert.deepEqual(request.format, format)
      assert.deepEqual(request.messages, messages)
      assert.deepEqual(request.options, { num_ctx: 8192, num_predict: 10 })
      assert.equal(events.length, 2)
      assert.equal(events[0].content, '{"responseKey":"greeting"}')
      assert.equal(events[1].status, 'complete')
      assert.equal(JSON.stringify(events).includes('private'), false)
    })
  }
})

test('thinking that consumes the output budget is still a token limit failure', async () => {
  await withFakeOllama((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message: { thinking: 'private', content: '' }, done: false }) + '\n')
    res.end(JSON.stringify({ done: true, done_reason: 'length', eval_count: 10 }))
  }, async (baseUrl) => {
    const client = new OllamaClient({ baseUrl, model: 'm', timeoutMs: 1000 })
    const events = await collect(client, { think: true })
    assert.equal(events.length, 1)
    assert.equal(events[0].status, 'max_tokens')
    assert.equal(events[0].evalCount, 10)
    assert.equal(JSON.stringify(events).includes('private'), false)
  })
})

// Kiểm thử edge case: distinguishes timeout and already-aborted signal.
test('distinguishes timeout and already-aborted signal', async () => {
  await withFakeOllama((req, res) => { void req; void res }, async (baseUrl) => {
    const client = new OllamaClient({ baseUrl, model: 'm', timeoutMs: 30 })
    await assert.rejects(() => collect(client), (error) => error.code === 'OLLAMA_TIMEOUT')
    const controller = new AbortController(); controller.abort()
    await assert.rejects(() => collect(client, { signal: controller.signal }), (error) => error.code === 'ABORTED')
  })
})
