const TEXT_FIELDS = new Set(['content', 'output_text', 'parts', 'text'])
const REASONING_FIELDS = new Set(['reasoning', 'reasoning_content', 'summary', 'thoughts'])

function assistantMessages(payload) {
  if (!payload || typeof payload !== 'object') return []
  const mapping = payload.mapping && typeof payload.mapping === 'object' ? Object.values(payload.mapping) : []
  return [
    ...(payload.message?.author?.role === 'assistant' ? [payload.message] : []),
    ...mapping.map(entry => entry?.message),
  ]
    .filter((message, index, all) => message?.author?.role === 'assistant' && all.indexOf(message) === index)
    .sort((left, right) => (left?.create_time || 0) - (right?.create_time || 0))
}

function collectAssistantText(value, output = [], acceptsText = false, depth = 0) {
  if (depth > 12 || value == null) return output
  if (typeof value === 'string') {
    if (acceptsText && value.trim()) output.push(value)
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssistantText(item, output, acceptsText, depth + 1)
    return output
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectAssistantText(child, output, TEXT_FIELDS.has(key), depth + 1)
    }
  }
  return output
}

function collectNamedText(value, fields, output = [], acceptsText = false, depth = 0) {
  if (depth > 12 || value == null) return output
  if (typeof value === 'string') {
    if (acceptsText && value.trim()) output.push(value)
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamedText(item, fields, output, acceptsText, depth + 1)
    return output
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectNamedText(child, fields, output, acceptsText || fields.has(key), depth + 1)
    }
  }
  return output
}

export function extractChatGPTAssistantText(payload, submittedPrompt = '') {
  const messages = assistantMessages(payload)

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = cleanChatGPTUiAssistantText(
      collectAssistantText(messages[index]?.content).join('\n'),
      submittedPrompt,
    ).trim()
    if (text) return text
  }

  return ''
}

export function extractChatGPTAssistantModel(payload) {
  for (const message of assistantMessages(payload).reverse()) {
    for (const candidate of [
      message?.metadata?.model_slug,
      message?.metadata?.model,
      message?.content?.model_slug,
      message?.content?.model,
      message?.model_slug,
      message?.model,
    ]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
  }
  for (const candidate of [payload?.metadata?.model_slug, payload?.metadata?.model, payload?.model_slug, payload?.model]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

export function extractChatGPTAssistantReasoning(payload) {
  for (const message of assistantMessages(payload).reverse()) {
    const reasoning = collectNamedText(message?.content, REASONING_FIELDS).join('\n').trim()
    if (reasoning) return reasoning
  }
  return ''
}

export function extractChatGPTAssistantTextFromSse(raw, submittedPrompt = '') {
  let latest = ''
  let finalized = false
  let eventName = ''
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('event:')) {
      eventName = trimmed.slice(6).trim()
      continue
    }
    if (!trimmed) {
      eventName = ''
      continue
    }
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data) continue
    if (data === '[DONE]') {
      finalized = true
      continue
    }
    try {
      const parsed = JSON.parse(data)
      const type = String(parsed.type || parsed.event || eventName).toLowerCase()
      if (type.includes('completed') || type.endsWith('.done') || parsed.is_completion === true) {
        finalized = true
      }
      const text = extractChatGPTAssistantText(parsed, submittedPrompt)
      if (text) latest = text
    } catch {}
  }
  return finalized ? latest : ''
}

export function cleanChatGPTUiAssistantText(value, submittedPrompt = '') {
  const prompt = String(submittedPrompt || '').replace(/\s+/g, ' ').trim()
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(line => !/^worked for\b/i.test(line))
    .filter(line => !/^modified \d+ files?\b/i.test(line))
    .filter(line => !prompt || line !== prompt)
  return lines.join('\n').trim()
}
