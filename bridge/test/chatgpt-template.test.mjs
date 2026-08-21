import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChatGPTPayloadFromTemplate } from '../rustproxyhub/chatgpt-template-runtime.mjs'

test('ChatGPT template keeps prompt text unchanged', () => {
  const prompt = 'keep   spacing\n\nall blocks'
  const payload = buildChatGPTPayloadFromTemplate({
    template: {
      payload: JSON.stringify({
        messages: [{
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['old prompt'] },
          metadata: {},
        }],
      }),
    },
    prompt,
    model: 'chatgpt-web-session',
    webSearch: false,
  })
  assert.equal(payload.messages[0].content.parts[0], prompt)
})
