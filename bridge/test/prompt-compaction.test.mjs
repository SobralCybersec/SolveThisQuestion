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

test('single oversized block uses both head-tail fallback budgets', () => {
  const prompt = `User: ${'head '.repeat(2000)}tail`
  const narrow = compactStructuredPrompt(prompt, { maxChars: 80 })
  const wide = compactStructuredPrompt(prompt, { maxChars: 5000 })
  assert.equal(narrow.mode, 'head-tail')
  assert.ok(narrow.text.length <= 80)
  assert.equal(wide.mode, 'head-tail')
  assert.ok(wide.text.length <= 5000)
  assert.match(wide.text, /Earlier conversation trimmed/)
})

test('structured compaction trims oversized tool and latest blocks', () => {
  const pair = compactStructuredPrompt([
    'System: keep this',
    `User: old ${'context '.repeat(30)}`,
    'User: use tool',
    'Assistant: final answer',
  ].join('\n\n'), { maxChars: 120 })
  assert.equal(pair.mode, 'structured')
  assert.match(pair.text, /User: use tool/)

  const tool = compactStructuredPrompt([
    'System: keep this',
    'User: use tool',
    `Tool Response: ${'tool '.repeat(100)}`,
  ].join('\n\n'), { maxChars: 210 })
  assert.equal(tool.truncated, true)
  assert.ok(tool.text.length <= 210)

  const latest = compactStructuredPrompt(`System: keep\n\nAssistant: ${'latest '.repeat(60)}`, { maxChars: 40 })
  assert.equal(latest.mode, 'latest-tail')
  assert.ok(latest.text.length <= 40)
})

test('structured compaction supports dropping first block and empty selections', () => {
  const result = compactStructuredPrompt([
    'System: instructions',
    'User: old question',
    'Assistant: old answer',
    'Notes: extra context',
  ].join('\n\n'), { maxChars: 40, preserveFirstBlock: false })
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 40)

  const emptySelection = compactStructuredPrompt('System: first\n\nAssistant: second', {
    maxChars: 1,
    preserveFirstBlock: false,
  })
  assert.equal(emptySelection.mode, 'head-tail')
  assert.equal(emptySelection.text.length, 1)
})

test('compaction summary reports omitted and empty details', () => {
  assert.equal(
    summarizePromptCompaction({ truncated: true, originalChars: 10, compactedChars: 4 }),
    'Prompt compacted before ChatGPT send (6 chars saved).',
  )
  assert.match(
    summarizePromptCompaction({ truncated: true, originalChars: 20, compactedChars: 4, omittedBlocks: 2 }),
    /2 earlier block\(s\) omitted/,
  )
})
