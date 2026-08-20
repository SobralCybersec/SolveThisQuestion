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

test('extractors cover direct messages, fallback model fields, and nested values', () => {
  const direct = assistant('direct', 1, [{ content: { output_text: ['nested answer'] } }], {
    metadata: { model_slug: '', model: '' },
    model_slug: '',
    model: '',
  })
  const payload = {
    message: direct,
    mapping: { ignored: null, duplicate: { message: direct } },
    model_slug: 'fallback-model',
  }
  assert.equal(extractChatGPTAssistantText(payload), 'nested answer')
  assert.equal(extractChatGPTAssistantModel(payload), 'fallback-model')
  assert.equal(extractChatGPTAssistantModel({ mapping: {} }), '')
  assert.equal(extractChatGPTAssistantReasoning({ message: assistant('r', 1, ['answer'], {
    content: { reasoning: [null, 7, 'reason'] },
  }) }), 'reason')
  assert.equal(extractChatGPTAssistantReasoning({ mapping: {} }), '')
  assert.equal(extractChatGPTAssistantText(null), '')
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

test('SSE extractor ignores empty, unrelated, and malformed lines', () => {
  const message = assistant('a', 1, ['answer'])
  const raw = [
    'event: message',
    '',
    'noise',
    'data:',
    'data: {malformed',
    `data: ${JSON.stringify({ type: 'message.completed', message })}`,
  ].join('\n')
  assert.equal(extractChatGPTAssistantTextFromSse(raw), 'answer')
})
