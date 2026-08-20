import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS,
  DEFAULT_RESPONSE_POLL_ATTEMPTS,
  DEFAULT_RESPONSE_POLL_INTERVAL_MS,
  submitChatGPTPrompt,
  waitForAssistantAnswer,
  waitForChatGPTResponse,
} from '../rustproxyhub/chatgpt-web-flow.mjs'

const response = (body, status = 200) => ({
  status: () => status,
  ok: () => status >= 200 && status < 300,
  text: async () => body,
})

test('waitForChatGPTResponse retries empty bodies and returns first answer', async () => {
  const bodies = ['', 'null', JSON.stringify({ answer: 'ready' })]
  let reads = 0
  const sleeps = []
  const result = await waitForChatGPTResponse({
    read: async () => response(bodies[reads++]),
    extractText: body => JSON.parse(body).answer || '',
    sleep: async ms => sleeps.push(ms),
  })
  assert.equal(result.body, bodies[2])
  assert.equal(reads, 3)
  assert.deepEqual(sleeps, [DEFAULT_RESPONSE_POLL_INTERVAL_MS, DEFAULT_RESPONSE_POLL_INTERVAL_MS])
})

test('waitForChatGPTResponse stops unauthorized polling immediately', async () => {
  let reads = 0
  const result = await waitForChatGPTResponse({
    read: async () => {
      reads += 1
      return response('', 401)
    },
    sleep: async () => { throw new Error('unexpected sleep') },
  })
  assert.equal(result.status, 401)
  assert.equal(reads, 1)
})

test('waitForChatGPTResponse keeps polling when extractor rejects stale content', async () => {
  const bodies = ['stale', 'fresh']
  let reads = 0
  const result = await waitForChatGPTResponse({
    read: async () => response(bodies[reads++]),
    extractText: body => body === 'fresh' ? body : '',
    sleep: async () => {},
  })
  assert.equal(result.body, 'fresh')
  assert.equal(reads, 2)
})

test('prompt submission uses enabled button and clears composer quickly', async () => {
  let value = 'prompt'
  let clicks = 0
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    isDisabled: async () => false,
    click: async () => { clicks += 1; value = '' },
  }
  const page = { locator: () => ({ last: () => button }) }
  const composer = {
    inputValue: async () => value,
    press: async () => { value = '' },
  }
  const method = await submitChatGPTPrompt({ page, composer,
    selector: 'button',
    sleep: async () => {},
  })
  assert.equal(method, 'button')
  assert.equal(clicks, 1)
})

test('prompt submission falls back to Enter after button deadline', async () => {
  let value = 'prompt'
  const composer = {
    inputValue: async () => value,
    press: async key => { assert.equal(key, 'Enter'); value = '' },
  }
  const hiddenButton = {
    count: async () => 0,
    isVisible: async () => false,
    isDisabled: async () => true,
  }
  const method = await submitChatGPTPrompt({
    page: { locator: () => ({ last: () => hiddenButton }) },
    composer,
    selector: 'button',
    deadlineMs: 0,
    sleep: async () => {},
  })
  assert.equal(method, 'keyboard')
})

test('poll defaults bound empty-response wait', () => {
  assert.equal(DEFAULT_RESPONSE_POLL_ATTEMPTS, 40)
  assert.equal(DEFAULT_RESPONSE_POLL_INTERVAL_MS, 250)
  assert.ok(DEFAULT_RESPONSE_POLL_ATTEMPTS * DEFAULT_RESPONSE_POLL_INTERVAL_MS <= 10_000)
})

test('empty assistant answer requests fresh chat after ten seconds', async () => {
  let clock = 0
  const result = await waitForAssistantAnswer({
    read: async () => ({ text: '', streaming: false }),
      emptyRetryTimeoutMs: DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS,
      intervalMs: 2_500,
      now: () => clock,
      sleep: async ms => { clock += ms },
  })
  assert.deepEqual(result, { answer: '', retry: true })
  assert.equal(clock, DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS)
})

test('assistant answer waits for stable non-streaming text', async () => {
  let clock = 0
  const result = await waitForAssistantAnswer({
    read: async () => ({ text: 'answer', streaming: false }),
      emptyRetryTimeoutMs: 10_000,
      stableMs: 1_000,
      intervalMs: 250,
      now: () => clock,
      sleep: async ms => { clock += ms },
  })
  assert.deepEqual(result, { answer: 'answer', retry: false })
  assert.equal(clock, 1_000)
})
