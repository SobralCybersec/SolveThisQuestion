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
})

test('latest assistant message id is time ordered', () => {
  const payload = {
    mapping: {
      newer: { message: { id: 'new', create_time: 2, author: { role: 'assistant' } } },
      older: { message: { id: 'old', create_time: 1, author: { role: 'assistant' } } },
    },
  }
  assert.equal(latestChatGPTAssistantMessageId(payload), 'new')
})

test('sessions round-trip and apply parent message id', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-agent-session-'))
  try {
    const sessions = new Map([['work', { conversation_id: 'c', parent_message_id: 'p' }]])
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
