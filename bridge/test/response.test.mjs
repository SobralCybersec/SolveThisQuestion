import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanChatGPTUiAssistantText,
  extractChatGPTAssistantModel,
  extractChatGPTAssistantReasoning,
  extractChatGPTAssistantText,
  extractChatGPTAssistantTextFromSse,
} from '../rustproxyhub/chatgpt-web-response.mjs'

const assistant = (id, time, parts, extra = {}) => ({
  id,
  create_time: time,
  author: { role: 'assistant' },
  content: { content_type: 'text', parts },
  ...extra,
})

test('extractChatGPTAssistantText selects latest non-empty assistant text', () => {
  const payload = {
    mapping: {
      first: { message: assistant('a', 1, ['old']) },
      latest: { message: assistant('b', 2, ['the submitted prompt', 'final answer']) },
    },
  }
  assert.equal(extractChatGPTAssistantText(payload, 'the submitted prompt'), 'final answer')
})

test('response cleaning removes UI noise but preserves answer lines', () => {
  assert.equal(
    cleanChatGPTUiAssistantText('Worked for 2s\nanswer\nModified 3 files\nanswer  ', 'prompt'),
    'answer\nanswer',
  )
})

test('extractors handle model, reasoning, and empty payloads', () => {
  const payload = {
    mapping: {
      answer: {
        message: assistant('a', 1, ['answer'], {
          metadata: { model_slug: 'model-x' },
          content: { content_type: 'text', parts: ['answer'], reasoning: 'checked inputs' },
        }),
      },
    },
  }
  assert.equal(extractChatGPTAssistantModel(payload), 'model-x')
  assert.equal(extractChatGPTAssistantReasoning(payload), 'checked inputs')
  assert.equal(extractChatGPTAssistantText({ mapping: {} }), '')
})

test('SSE extractor returns final answer after completion marker', () => {
  const message = assistant('a', 1, ['streamed answer'])
  const raw = [
    `event: message\ndata: ${JSON.stringify({ message })}`,
    'data: [DONE]',
  ].join('\n\n')
  assert.equal(extractChatGPTAssistantTextFromSse(raw), 'streamed answer')
  assert.equal(extractChatGPTAssistantTextFromSse(`data: ${JSON.stringify({ message })}`), '')
})
