import { latestChatGPTAssistantMessageId } from './chatgpt-web-session.mjs'

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

function queueNamedTextChildren(options) {
  const { pending, value, fields, acceptsText, depth } = options
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      pending.push({ value: value[index], acceptsText, depth: depth + 1 })
    }
    return
  }
  if (typeof value !== 'object') return
  const entries = Object.entries(value)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [key, child] = entries[index]
    pending.push({ value: child, acceptsText: acceptsText || fields.has(key), depth: depth + 1 })
  }
}

function collectNamedText(value, fields, options = {}) {
  const output = options.output || []
  const pending = [{ value, acceptsText: Boolean(options.acceptsText), depth: options.depth || 0 }]
  while (pending.length) {
    const current = pending.pop()
    if (current.depth > 12 || current.value == null) continue
    if (typeof current.value === 'string') {
      if (current.acceptsText && current.value.trim()) output.push(current.value)
      continue
    }
    queueNamedTextChildren({
      pending,
      value: current.value,
      fields,
      acceptsText: current.acceptsText,
      depth: current.depth,
    })
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

export function extractChatGPTConversationText(payload, options = {}) {
  const {
    submittedPrompt = '',
    previousAssistantMessageId = '',
    previousAssistantText = '',
  } = options
  const text = extractChatGPTAssistantText(payload, submittedPrompt)
  if (!text) return ''
  if (
    previousAssistantMessageId
    && previousAssistantText
    && latestChatGPTAssistantMessageId(payload) === previousAssistantMessageId
    && text === previousAssistantText
  ) return ''
  return text
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

function parseSseData(data, eventName, submittedPrompt) {
  if (!data) return null
  if (data === '[DONE]') return { finalized: true, text: '' }
  try {
    const parsed = JSON.parse(data)
    const type = String(parsed.type || parsed.event || eventName).toLowerCase()
    const finalized = type.includes('completed') || type.endsWith('.done') || parsed.is_completion === true
    return { finalized, text: extractChatGPTAssistantText(parsed, submittedPrompt) }
  } catch {
    return null
  }
}

function processSseLine(line, state, submittedPrompt) {
  const trimmed = line.trim()
  if (trimmed.startsWith('event:')) {
    state.eventName = trimmed.slice(6).trim()
    return
  }
  if (!trimmed) {
    state.eventName = ''
    return
  }
  if (!trimmed.startsWith('data:')) return
  const parsed = parseSseData(trimmed.slice(5).trim(), state.eventName, submittedPrompt)
  if (!parsed) return
  state.finalized ||= parsed.finalized
  if (parsed.text) state.latest = parsed.text
}

export function extractChatGPTAssistantTextFromSse(raw, submittedPrompt = '') {
  const state = { latest: '', finalized: false, eventName: '' }
  for (const line of String(raw || '').split(/\r?\n/)) processSseLine(line, state, submittedPrompt)
  return state.finalized ? state.latest : ''
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
