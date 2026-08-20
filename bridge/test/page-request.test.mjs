import assert from 'node:assert/strict'
import test from 'node:test'
import { CHATGPT_PAGE_REQUEST } from '../rustproxyhub/chatgpt-web-page.mjs'

test('ChatGPT page request is an invokable Playwright function', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: null,
    headers: { get: () => null },
  })
  try {
    const result = await CHATGPT_PAGE_REQUEST({
      headers: {},
      payload: { prompt: 'hello' },
      submittedPrompt: 'hello',
      stream: false,
    })
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
  } finally {
    globalThis.fetch = previousFetch
  }
})
