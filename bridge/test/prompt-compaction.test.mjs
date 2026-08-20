import assert from 'node:assert/strict'
import test from 'node:test'
import { compactStructuredPrompt, summarizePromptCompaction, trimPromptFormatting } from '../rustproxyhub/prompt-compaction.mjs'

test('trimPromptFormatting removes trailing spaces and repeated blank lines', () => {
  assert.equal(trimPromptFormatting(' first  \n\n\nsecond \t\n'), 'first\n\nsecond')
})

test('compactStructuredPrompt keeps prompt start and latest answer within limit', () => {
  const prompt = [
    'System: answer the user.',
    'User: old question',
    'Assistant: old answer',
    'User: old question',
    'Assistant: old answer',
    'User: latest question',
    'Assistant: latest answer',
  ].join('\n\n')
  const result = compactStructuredPrompt(prompt, { maxChars: 96 })
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 96)
  assert.match(result.text, /System: answer the user\./)
  assert.match(result.text, /latest answer/)
  assert.ok(result.removedDuplicateBlocks >= 1)
  assert.match(summarizePromptCompaction(result), /Prompt compacted before ChatGPT send/)
})

test('short prompt stays byte-for-byte meaningful', () => {
  const result = compactStructuredPrompt('User: hello\n\nAssistant: hi')
  assert.equal(result.truncated, false)
  assert.equal(result.text, 'User: hello\n\nAssistant: hi')
  assert.equal(summarizePromptCompaction(result), null)
})
