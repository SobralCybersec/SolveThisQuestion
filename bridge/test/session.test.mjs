import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  applyChatGPTConversationSession,
  chatGPTSessionFromTemplate,
  chatGPTSessionKey,
  latestChatGPTAssistantMessageId,
  loadChatGPTWebSessions,
  saveChatGPTWebSessions,
} from '../rustproxyhub/chatgpt-web-session.mjs'

test('session keys and templates reject malformed values', () => {
  assert.equal(chatGPTSessionKey('  work  '), 'work')
  assert.equal(chatGPTSessionKey('../escape'), '../escape')
  assert.equal(chatGPTSessionFromTemplate({ payload: '{"conversation_id":"c","parent_message_id":"p"}' }).conversation_id, 'c')
  assert.equal(chatGPTSessionFromTemplate({ payload: '{}' }), null)
  assert.deepEqual(
    chatGPTSessionFromTemplate({ payload: { conversationId: 'c2', parentMessageId: 'p2' } }),
    { conversation_id: 'c2', parent_message_id: 'p2' },
  )
})

test('latest assistant message id is time ordered', () => {
  const payload = {
    mapping: {
      newer: { message: { id: 'new', create_time: 2, author: { role: 'assistant' } } },
      older: { message: { id: 'old', create_time: 1, author: { role: 'assistant' } } },
    },
  }
  assert.equal(latestChatGPTAssistantMessageId(payload), 'new')
  assert.equal(latestChatGPTAssistantMessageId({ message: { id: 'direct', author: { role: 'assistant' } } }), 'direct')
  assert.equal(latestChatGPTAssistantMessageId({ message: { id: 'user', author: { role: 'user' } }, mapping: { bad: {} } }), '')
})

test('sessions round-trip and apply parent message id', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-agent-session-'))
  try {
    const sessions = new Map([['work', { conversation_id: 'c', parent_message_id: 'p', assistant_text: 'answer' }]])
    saveChatGPTWebSessions(runtimeDir, sessions)
    assert.deepEqual([...loadChatGPTWebSessions(runtimeDir)], [...sessions])
    assert.deepEqual(
      applyChatGPTConversationSession({ prompt: 'x' }, sessions.get('work')),
      { prompt: 'x', conversation_id: 'c', parent_message_id: 'p' },
    )
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('session storage rejects malformed and invalid entries', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-agent-session-invalid-'))
  try {
    fs.writeFileSync(path.join(runtimeDir, 'chatgpt-web-sessions.json'), '{malformed')
    assert.deepEqual([...loadChatGPTWebSessions(runtimeDir)], [])
    assert.deepEqual(
      applyChatGPTConversationSession({ prompt: 'x' }, null),
      { prompt: 'x', parent_message_id: 'client-created-root' },
    )
    saveChatGPTWebSessions(runtimeDir, new Map([
      ['valid', { conversation_id: 'c', parent_message_id: 'p' }],
      ['bad', { conversation_id: 'c' }],
    ]))
    assert.deepEqual([...loadChatGPTWebSessions(runtimeDir)], [['valid', { conversation_id: 'c', parent_message_id: 'p' }]])
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
})
