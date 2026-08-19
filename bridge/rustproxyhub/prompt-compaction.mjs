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

export function compactStructuredPrompt(
  prompt,
  { maxChars = 18000, preserveFirstBlock = true } = {},
) {
  const cleaned = trimPromptFormatting(prompt)
  const baseline = String(prompt || '')
  const blocks = splitPromptBlocks(cleaned)
  const result = {
    text: cleaned,
    truncated: false,
    mode: cleaned === baseline.trim() ? 'fit' : 'trim-format',
    originalChars: baseline.length,
    cleanedChars: cleaned.length,
    removedDuplicateBlocks: 0,
    omittedBlocks: 0,
  }

  if (cleaned.length <= maxChars) return { ...result, compactedChars: cleaned.length }
  const duplicateScan = new Set()
  for (const block of blocks) {
    const signature = normalizeBlockSignature(block)
    if (!signature) continue
    if (duplicateScan.has(signature)) result.removedDuplicateBlocks += 1
    else duplicateScan.add(signature)
  }
  if (blocks.length <= 1) {
    const text = fallbackHeadTail(cleaned, maxChars)
    return {
      ...result,
      text,
      truncated: true,
      mode: 'head-tail',
      compactedChars: text.length,
    }
  }

  const marker = '\n\n[Earlier turns omitted to fit limit]\n\n'
  const firstBlock = preserveFirstBlock ? blocks[0] : ''
  const firstCost = firstBlock ? firstBlock.length : 0
  const seen = new Set(firstBlock ? [normalizeBlockSignature(firstBlock)] : [])
  const tail = []
  let remaining = maxChars - firstCost - (firstBlock ? marker.length : 0)

  for (let index = blocks.length - 1; index >= (preserveFirstBlock ? 1 : 0); index -= 1) {
    const block = blocks[index]
    const previousBlock = index > 0 ? blocks[index - 1] : ''
    const signature = normalizeBlockSignature(block)
    if (!signature) continue
    if (seen.has(signature)) {
      continue
    }

    const previousRole = blockRole(previousBlock)
    const currentRole = blockRole(block)
    const shouldKeepPair =
      tail.length === 0 &&
      currentRole !== 'user' &&
      previousRole === 'user' &&
      index > (preserveFirstBlock ? 0 : -1)
    if (shouldKeepPair) {
      const pair = `${previousBlock}\n\n${block}`
      if (!seen.has(normalizeBlockSignature(previousBlock)) && pair.length <= remaining) {
        tail.unshift(previousBlock, block)
        seen.add(normalizeBlockSignature(previousBlock))
        seen.add(signature)
        remaining -= pair.length
        index -= 1
        continue
      }
    }

    const separatorCost = tail.length > 0 ? 2 : 0
    if (block.length + separatorCost <= remaining) {
      tail.unshift(block)
      seen.add(signature)
      remaining -= block.length + separatorCost
      continue
    }

    if (tail.length === 0 && remaining > 96) {
      const trimmed = compactLongBlock(block, remaining)
      if (trimmed) {
        tail.unshift(trimmed)
        seen.add(signature)
        remaining = 0
      }
    } else {
      result.omittedBlocks += 1
    }
  }

  const parts = []
  if (firstBlock && tail.length === 0 && blocks.length > 1) {
    const latestPair = blocks.length >= 2 ? `${blocks.at(-2)}\n\n${blocks.at(-1)}` : blocks.at(-1)
    const latest = latestPair.length <= maxChars ? latestPair : compactLongBlock(blocks.at(-1), maxChars)
    return {
      ...result,
      text: latest.trim(),
      truncated: true,
      mode: 'latest-tail',
      compactedChars: latest.trim().length,
    }
  }
  if (firstBlock) parts.push(firstBlock)
  if (firstBlock && tail.length) parts.push(marker.trim())
  parts.push(...tail)

  let text = parts.join('\n\n').trim()
  if (!text || text.length > maxChars) {
    text = fallbackHeadTail(cleaned, maxChars)
    return {
      ...result,
      text,
      truncated: true,
      mode: 'head-tail',
      compactedChars: text.length,
    }
  }

  return {
    ...result,
    text,
    truncated: true,
    mode: 'structured',
    compactedChars: text.length,
  }
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
