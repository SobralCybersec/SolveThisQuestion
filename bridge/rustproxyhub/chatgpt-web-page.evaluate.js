function cleanAssistantText(value, promptText) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(line => !/^worked for\b/i.test(line) && !/^modified \d+ files?\b/i.test(line))
    .filter(line => !promptText || line !== promptText)
    .join('\n')
    .trim()
}

const TEXT_FIELDS = new Set(['content', 'output_text', 'parts', 'text'])

function collectText(value, output = [], acceptsText = false, depth = 0) {
  if (depth > 12 || value == null) return output
  if (typeof value === 'string') {
    if (acceptsText && value.trim()) output.push(value)
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, acceptsText, depth + 1)
    return output
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) collectText(child, output, TEXT_FIELDS.has(key), depth + 1)
  }
  return output
}

function assistantMessages(payload) {
  const mapping = payload?.mapping && typeof payload.mapping === 'object' ? Object.values(payload.mapping) : []
  return [
    ...(payload?.message?.author?.role === 'assistant' ? [payload.message] : []),
    ...mapping.map(entry => entry?.message),
  ]
    .filter((message, index, all) => message?.author?.role === 'assistant' && all.indexOf(message) === index)
    .sort((left, right) => (left?.create_time || 0) - (right?.create_time || 0))
}

function assistantText(payload, submittedPrompt) {
  const message = assistantMessages(payload).at(-1)
  const promptText = String(submittedPrompt || '').replace(/\s+/g, ' ').trim()
  return cleanAssistantText(collectText(message?.content).join('\n'), promptText)
}

function assistantModel(payload) {
  const message = assistantMessages(payload).at(-1)
  for (const candidate of [
    message?.metadata?.model_slug,
    message?.metadata?.model,
    message?.content?.model_slug,
    message?.content?.model,
    message?.model_slug,
    message?.model,
    payload?.metadata?.model_slug,
    payload?.metadata?.model,
    payload?.model_slug,
    payload?.model,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function assistantReasoning(payload, output = [], acceptsText = false, depth = 0) {
  if (depth > 12 || payload == null) return output.join('\n').trim()
  if (typeof payload === 'string') {
    if (acceptsText && payload.trim()) output.push(payload)
    return output.join('\n').trim()
  }
  if (Array.isArray(payload)) {
    for (const item of payload) assistantReasoning(item, output, acceptsText, depth + 1)
    return output.join('\n').trim()
  }
  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      assistantReasoning(value, output, acceptsText || ['reasoning', 'reasoning_content', 'summary', 'thoughts'].includes(key), depth + 1)
    }
  }
  return output.join('\n').trim()
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value)
}

function recordStreamMetadata(parsed, state) {
  for (const key of Object.keys(parsed || {})) pushUnique(state.keys, key)
  const role = parsed?.message?.author?.role
  if (role === 'assistant' && parsed?.message?.id) state.messageId = parsed.message.id
  const contentType = parsed?.message?.content?.content_type
  const messageShape = parsed?.message && typeof parsed.message === 'object'
    ? Object.keys(parsed.message).slice(0, 12).join(',')
    : typeof parsed?.message
  pushUnique(state.messageShapes, messageShape)
  pushUnique(state.roles, role)
  pushUnique(state.contentTypes, contentType)
  state.conversationId = parsed.conversation_id || parsed.token?.conversation_id || parsed.options?.[0]?.conversation_id || state.conversationId
  state.model = assistantModel(parsed) || state.model
}

async function readPageStream({ reader, decoder, state, emitReasoning, emitDelta }) {
  try {
    while (true) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (error) {
        if (state.conversationId) break
        throw error
      }
      if (chunk.done) break
      const decoded = decoder.decode(chunk.value, { stream: true })
      state.raw = `${state.raw}${decoded}`.slice(-16_384)
      state.lineBuffer += decoded
      const lines = state.lineBuffer.split('\n')
      state.lineBuffer = lines.pop() || ''
      for (const line of lines) {
        const data = line.trim().replace(/^data:/, '').trim()
        if (!data || data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          recordStreamMetadata(parsed, state)
          await emitReasoning(parsed)
          await emitDelta(parsed)
        } catch {}
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

// #lizard forgives
function responseCache(response) {
  const cache = {}
  for (const name of ['cache-control', 'age', 'cf-cache-status']) {
    const value = response.headers.get(name)
    if (value) cache[name] = value
  }
  return Object.keys(cache).length ? cache : null
}

(async ({ headers, payload, submittedPrompt, stream }) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 240000)
      const response = await fetch('https://chatgpt.com/backend-api/f/conversation', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let raw = ''
      let lineBuffer = ''
      let streamedText = ''
      let streamedModel = ''
      let streamedReasoning = ''
      let streamedMessageId = ''
      let conversationId = ''
      const streamRoles = []
      const streamContentTypes = []
      const streamKeys = []
      const streamMessageShapes = []

      const emitDelta = async (payload) => {
        const current = assistantText(payload, submittedPrompt)
        if (!current) return
        const delta = current.startsWith(streamedText) ? current.slice(streamedText.length) : current
        streamedText = current
        if (!stream || typeof globalThis.__rustProxyHubStream !== 'function') return
        if (delta) await globalThis.__rustProxyHubStream({ type: 'delta', delta })
      }
      const emitReasoning = async (payload) => {
        const current = assistantReasoning(payload?.message?.content || payload)
        if (!current) return
        const delta = current.startsWith(streamedReasoning) ? current.slice(streamedReasoning.length) : current
        streamedReasoning = current
        if (!stream || typeof globalThis.__rustProxyHubStream !== 'function') return
        if (delta) await globalThis.__rustProxyHubStream({ type: 'reasoning', delta })
      }

      const streamState = {
        raw,
        lineBuffer,
        model: streamedModel,
        messageId: streamedMessageId,
        conversationId,
        roles: streamRoles,
        contentTypes: streamContentTypes,
        keys: streamKeys,
        messageShapes: streamMessageShapes,
      }
      if (reader) await readPageStream({ reader, decoder, state: streamState, emitReasoning, emitDelta })
      raw = streamState.raw
      streamedModel = streamState.model
      streamedMessageId = streamState.messageId
      conversationId = streamState.conversationId

      clearTimeout(timer)
      return {
        ok: response.ok,
        status: response.status,
        conversationId,
        body: raw,
        streamModel: streamedModel,
        streamReasoning: streamedReasoning,
        streamText: streamedText,
        streamMessageId: streamedMessageId,
        streamShape: { keys: streamKeys, roles: streamRoles, content_types: streamContentTypes, messages: streamMessageShapes },
        upstream_cache: responseCache(response),
      }
    })
