import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS,
  DEFAULT_ASSISTANT_ANSWER_POLL_INTERVAL_MS,
  DEFAULT_RESPONSE_POLL_ATTEMPTS,
  DEFAULT_RESPONSE_POLL_INTERVAL_MS,
  composerText,
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

test('prompt submission can skip redundant composer-clear confirmation', async () => {
  let submitted = ''
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    isDisabled: async () => false,
    click: async () => {},
  }
  const method = await submitChatGPTPrompt({
    page: { locator: () => ({ last: () => button }) },
    composer: { inputValue: async () => 'prompt', press: async () => {} },
    selector: 'button',
    waitForClearAfterSubmit: false,
    sleep: async () => { throw new Error('clear confirmation should be skipped') },
    onSubmitted: value => { submitted = value },
  })
  assert.equal(method, 'button')
  assert.equal(submitted, 'button')
})

test('prompt submission falls back after button click failure', async () => {
  let value = 'prompt'
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    isDisabled: async () => false,
    click: async () => { throw new Error('detached') },
  }
  const method = await submitChatGPTPrompt({
    page: { locator: () => ({ last: () => button }) },
    composer: {
      inputValue: async () => value,
      press: async () => { value = '' },
    },
    selector: 'button',
    sleep: async () => {},
  })
  assert.equal(method, 'keyboard')
})

test('prompt submission tolerates detached button state reads', async () => {
  let value = 'prompt'
  let clock = 0
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    getAttribute: async () => { throw new Error('detached') },
    isDisabled: async () => { throw new Error('detached') },
  }
  const method = await submitChatGPTPrompt({
    page: { locator: () => ({ last: () => button }) },
    composer: {
      inputValue: async () => value,
      press: async () => { value = '' },
    },
    selector: 'button',
    deadlineMs: 1,
    now: () => clock,
    sleep: async ms => { clock += ms },
  })
  assert.equal(method, 'keyboard')
})

test('prompt submission honors aria-disabled and falls back to Enter', async () => {
  let value = 'prompt'
  let clock = 0
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    getAttribute: async name => name === 'aria-disabled' ? 'true' : null,
    isDisabled: async () => false,
    click: async () => { throw new Error('button must not be clicked') },
  }
  const method = await submitChatGPTPrompt({
    page: { locator: () => ({ last: () => button }) },
    composer: {
      inputValue: async () => value,
      press: async key => { assert.equal(key, 'Enter'); value = '' },
    },
    selector: 'button#composer-submit-button, button[data-testid="send-button"], button[aria-label="Send prompt"]',
    deadlineMs: 1,
    now: () => clock,
    sleep: async ms => { clock += ms },
  })
  assert.equal(method, 'keyboard')
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

test('prompt submission polls uncleared button then uses keyboard', async () => {
  let value = 'prompt'
  let clock = 0
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    isDisabled: async () => false,
    click: async () => {},
  }
  const composer = {
    inputValue: async () => value,
    press: async key => { assert.equal(key, 'Enter'); value = '' },
  }
  const method = await submitChatGPTPrompt({
    page: { locator: () => ({ last: () => button }) }, composer, selector: 'button',
    deadlineMs: 1, now: () => clock, sleep: async ms => { clock += ms },
  })
  assert.equal(method, 'keyboard')
})

test('prompt submission reports failure when keyboard leaves composer populated', async () => {
  const composer = { inputValue: async () => 'prompt', press: async () => {} }
  await assert.rejects(
    submitChatGPTPrompt({
      page: { locator: () => ({ last: () => ({ count: async () => 0 }) }) },
      composer, selector: 'button', deadlineMs: 0, sleep: async () => {},
    }),
    /composer did not submit prompt/,
  )
})

test('poll defaults bound empty-response wait', () => {
  assert.equal(DEFAULT_RESPONSE_POLL_ATTEMPTS, 60)
  assert.equal(DEFAULT_RESPONSE_POLL_INTERVAL_MS, 50)
  assert.equal(DEFAULT_ASSISTANT_ANSWER_POLL_INTERVAL_MS, 50)
  assert.equal(DEFAULT_RESPONSE_POLL_ATTEMPTS * DEFAULT_RESPONSE_POLL_INTERVAL_MS, 3_000)
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

test('assistant answer returns after the second stable non-streaming read', async () => {
  let clock = 0
  const result = await waitForAssistantAnswer({
    read: async () => ({ text: 'answer', streaming: false }),
      emptyRetryTimeoutMs: 10_000,
      stableMs: 2_500,
      intervalMs: 250,
      now: () => clock,
      sleep: async ms => { clock += ms },
  })
  assert.deepEqual(result, { answer: 'answer', retry: false })
  assert.equal(clock, 250)
})

test('assistant answer returns code after stable non-streaming reads', async () => {
  let clock = 0
  const result = await waitForAssistantAnswer({
    read: async () => ({ text: '```answer```', streaming: false }),
    stableMs: 2_500,
    codeStableMs: 2_000,
    intervalMs: 250,
    now: () => clock,
    sleep: async ms => { clock += ms },
  })
  assert.deepEqual(result, { answer: '```answer```', retry: false })
  assert.equal(clock, 250)
})

test('assistant answer handles streaming and uses default timing callbacks', async () => {
  let reads = 0
  const result = await waitForAssistantAnswer({
    read: async () => ({ text: '```answer```', streaming: reads++ === 0 }),
    stableMs: 0, codeStableMs: 0, intervalMs: 0,
  })
  assert.equal(result.answer, '```answer```')
  assert.equal(result.retry, false)
})

test('response polling supports default extractor', async () => {
  const result = await waitForChatGPTResponse({
    read: async () => response('body'), attempts: 1, sleep: async () => {},
  })
  assert.deepEqual(result, { body: 'body', status: 200 })
})

test('composer text falls back to inner text when input value fails', async () => {
  assert.equal(await composerText({
    inputValue: async () => { throw new Error('detached') },
    innerText: async () => ' fallback ',
  }), 'fallback')
  assert.equal(await composerText({
    inputValue: async () => { throw new Error('detached') },
    innerText: async () => { throw new Error('closed') },
  }), '')
})
