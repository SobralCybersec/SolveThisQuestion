import assert from 'node:assert/strict'
import test from 'node:test'
import { selectNewAssistantText } from '../rustproxyhub/chatgpt-image-controller.mjs'

test('image answer accepts assistant node reused as response placeholder', () => {
  assert.equal(selectNewAssistantText(['old', 'new answer'], 2, ['old', '']), 'new answer')
})

test('image answer skips blank trailing assistant nodes and keeps new text', () => {
  assert.equal(selectNewAssistantText(['old', 'new answer', ''], 1, ['old']), 'new answer')
})

test('image answer ignores unchanged prior assistant text', () => {
  assert.equal(selectNewAssistantText(['old'], 1, ['old']), '')
})
