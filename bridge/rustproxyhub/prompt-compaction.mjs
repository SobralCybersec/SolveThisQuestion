function trimPromptFormatting(text) {
  let compacted = ''
  let blankLine = false
  for (const rawLine of String(text || '').split(/\r?\n/u)) {
    const line = rawLine.replace(/[\t ]+$/u, '')
    if (line.length === 0) {
      if (blankLine) continue
      blankLine = true
    } else {
      blankLine = false
    }
    if (compacted.length > 0) compacted += '\n'
    compacted += line
  }
  return compacted.trim()
}

function normalizeBlockSignature(block) {
  return block.replace(/\s+/gu, ' ').trim()
}

function splitPromptBlocks(text) {
  return trimPromptFormatting(text)
    .split(/\n{2,}/u)
    .map(block => block.trim())
    .filter(Boolean)
}

function blockRole(block) {
  const line = String(block || '').trimStart()
  if (line.startsWith('User:')) return 'user'
  if (line.startsWith('Assistant:')) return 'assistant'
  if (line.startsWith('Tool Response')) return 'tool'
  return 'other'
}

function compactLongBlock(block, maxChars) {
  if (block.length <= maxChars) return block
  if (maxChars <= 48) return block.slice(0, Math.max(0, maxChars)).trimEnd()

  const marker = '\n… [block trimmed] …\n'
  const headBudget = Math.max(24, Math.floor((maxChars - marker.length) * 0.35))
  const tailBudget = Math.max(24, maxChars - marker.length - headBudget)
  return `${block.slice(0, headBudget).trimEnd()}${marker}${block.slice(-tailBudget).trimStart()}`
}

function fallbackHeadTail(text, maxChars) {
  if (text.length <= maxChars) return text
  const marker = '\n\n[Earlier conversation trimmed to fit limit]\n\n'
  if (maxChars <= marker.length + 64) return text.slice(-maxChars).trimStart()
  const headBudget = Math.min(6000, Math.floor((maxChars - marker.length) * 0.35))
  const tailBudget = Math.max(1600, maxChars - marker.length - headBudget)
  return `${text.slice(0, headBudget).trimEnd()}${marker}${text.slice(-tailBudget).trimStart()}`
}

function createCompactionResult(prompt, cleaned) {
  const baseline = String(prompt || '')
  return {
    text: cleaned,
    truncated: false,
    mode: cleaned === baseline.trim() ? 'fit' : 'trim-format',
    originalChars: baseline.length,
    cleanedChars: cleaned.length,
    removedDuplicateBlocks: 0,
    omittedBlocks: 0,
  }
}

function countDuplicateBlocks(blocks) {
  const seen = new Set()
  return blocks.reduce((duplicates, block) => {
    const signature = normalizeBlockSignature(block)
    if (!signature || !seen.has(signature)) {
      if (signature) seen.add(signature)
      return duplicates
    }
    return duplicates + 1
  }, 0)
}

function compactSingleBlock(result, cleaned, maxChars) {
  const text = fallbackHeadTail(cleaned, maxChars)
  return { ...result, text, truncated: true, mode: 'head-tail', compactedChars: text.length }
}

function createSelection(blocks, maxChars, preserveFirstBlock) {
  const marker = '\n\n[Earlier turns omitted to fit limit]\n\n'
  const firstBlock = preserveFirstBlock ? blocks[0] : ''
  return {
    marker,
    firstBlock,
    seen: new Set(firstBlock ? [normalizeBlockSignature(firstBlock)] : []),
    tail: [],
    remaining: maxChars - (firstBlock ? firstBlock.length + marker.length : 0),
  }
}

function keepPair(selection, previousBlock, block) {
  const previousSignature = normalizeBlockSignature(previousBlock)
  const pair = `${previousBlock}\n\n${block}`
  if (selection.seen.has(previousSignature) || pair.length > selection.remaining) return false
  selection.tail.unshift(previousBlock, block)
  selection.seen.add(previousSignature)
  selection.seen.add(normalizeBlockSignature(block))
  selection.remaining -= pair.length
  return true
}

function keepBlock(selection, block, signature) {
  const separatorCost = selection.tail.length > 0 ? 2 : 0
  if (block.length + separatorCost > selection.remaining) return false
  selection.tail.unshift(block)
  selection.seen.add(signature)
  selection.remaining -= block.length + separatorCost
  return true
}

function isConversationPair(options) {
  const { selection, block, previousBlock, index, preserveFirstBlock } = options
  return selection.tail.length === 0
    && blockRole(block) !== 'user'
    && blockRole(previousBlock) === 'user'
    && index > (preserveFirstBlock ? 0 : -1)
}

function keepTrimmedBlock(selection, block, signature) {
  if (selection.tail.length !== 0 || selection.remaining <= 96) return false
  const trimmed = compactLongBlock(block, selection.remaining)
  if (!trimmed) return false
  selection.tail.unshift(trimmed)
  selection.seen.add(signature)
  selection.remaining = 0
  return true
}

function selectBlock(options) {
  const { selection, blocks, index, preserveFirstBlock, result } = options
  const block = blocks[index]
  const signature = normalizeBlockSignature(block)
  if (!signature || selection.seen.has(signature)) return false

  const previousBlock = index > 0 ? blocks[index - 1] : ''
  if (isConversationPair({ selection, block, previousBlock, index, preserveFirstBlock })
    && keepPair(selection, previousBlock, block)) return true
  if (keepBlock(selection, block, signature)) return true
  if (keepTrimmedBlock(selection, block, signature)) return true
  result.omittedBlocks += 1
  return false
}

function selectTail(blocks, maxChars, preserveFirstBlock, result) {
  const selection = createSelection(blocks, maxChars, preserveFirstBlock)
  const firstIndex = preserveFirstBlock ? 1 : 0
  for (let index = blocks.length - 1; index >= firstIndex; index -= 1) {
    if (selectBlock({ selection, blocks, index, preserveFirstBlock, result }) && selection.tail.length > 1) index -= 1
  }
  return selection
}

function latestTail(blocks, maxChars) {
  const pair = blocks.length >= 2 ? `${blocks.at(-2)}\n\n${blocks.at(-1)}` : blocks.at(-1)
  return pair.length <= maxChars ? pair : compactLongBlock(blocks.at(-1), maxChars)
}

function compactStructuredBlocks(options) {
  const { result, cleaned, blocks, maxChars, preserveFirstBlock } = options
  const selection = selectTail(blocks, maxChars, preserveFirstBlock, result)
  if (selection.firstBlock && selection.tail.length === 0 && blocks.length > 1) {
    const text = latestTail(blocks, maxChars).trim()
    return { ...result, text, truncated: true, mode: 'latest-tail', compactedChars: text.length }
  }

  const parts = []
  if (selection.firstBlock) parts.push(selection.firstBlock)
  if (selection.firstBlock && selection.tail.length) parts.push(selection.marker.trim())
  parts.push(...selection.tail)
  const text = parts.join('\n\n').trim()
  if (!text || text.length > maxChars) return compactSingleBlock(result, cleaned, maxChars)
  return { ...result, text, truncated: true, mode: 'structured', compactedChars: text.length }
}

export function compactStructuredPrompt(
  prompt,
  { maxChars = 18000, preserveFirstBlock = true } = {},
) {
  const cleaned = trimPromptFormatting(prompt)
  const blocks = splitPromptBlocks(cleaned)
  const result = createCompactionResult(prompt, cleaned)
  if (cleaned.length <= maxChars) return { ...result, compactedChars: cleaned.length }
  result.removedDuplicateBlocks = countDuplicateBlocks(blocks)
  if (blocks.length <= 1) return compactSingleBlock(result, cleaned, maxChars)
  return compactStructuredBlocks({ result, cleaned, blocks, maxChars, preserveFirstBlock })
}

export function summarizePromptCompaction(stats) {
  if (!stats?.truncated) return null
  const saved = Math.max(0, Number(stats.originalChars || 0) - Number(stats.compactedChars || 0))
  const details = []
  if (stats.removedDuplicateBlocks) details.push(`${stats.removedDuplicateBlocks} duplicate block(s) removed`)
  if (stats.omittedBlocks) details.push(`${stats.omittedBlocks} earlier block(s) omitted`)
  return [
    `Prompt compacted before ChatGPT send (${saved} chars saved`,
    details.length ? `; ${details.join(', ')}` : '',
    ').',
  ].join('')
}

export { trimPromptFormatting }
