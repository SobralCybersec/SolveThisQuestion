import assert from 'node:assert/strict'
import test from 'node:test'
import { gotoChatGPT } from '../rustproxyhub/browser-runtime.mjs'

function fakePage(url) {
  const calls = []
  return {
    calls,
    url: () => url,
    goto: async (target, options) => { calls.push({ target, options }) },
  }
}

test('navigation skips pages already on a ChatGPT or OpenAI auth host', async () => {
  for (const url of ['https://chatgpt.com/c/123', 'https://auth.openai.com/log-in', 'https://openai.com/']) {
    const page = fakePage(url)
    await gotoChatGPT(page)
    assert.deepEqual(page.calls, [], `${url} must not be navigated away mid-login`)
  }
})

test('navigation commits instead of waiting out a Cloudflare interstitial', async () => {
  const page = fakePage('about:blank')
  await gotoChatGPT(page)
  assert.equal(page.calls.length, 1)
  assert.equal(page.calls[0].target, 'https://chatgpt.com/')
  assert.equal(page.calls[0].options.waitUntil, 'commit')
  assert.ok(page.calls[0].options.timeout >= 30000)
})

test('a forced navigation still restarts an in-progress chat', async () => {
  const page = fakePage('https://chatgpt.com/c/123')
  await gotoChatGPT(page, { force: true })
  assert.equal(page.calls.length, 1)
})
