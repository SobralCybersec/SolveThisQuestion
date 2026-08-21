import { randomUUID } from 'node:crypto'
import { applyChatGPTConversationSession } from './chatgpt-web-session.mjs'

// chatgpt.com's web conversation endpoint silently drops client-supplied
// `author.role: "system"` turns. Fold instructions into user turn.
export function foldChatGPTSystemPrompt(systemPrompt, prompt) {
  const sys = (systemPrompt || '').trim()
  if (!sys) return prompt
  return `System: ${sys}\n\n${prompt}`
}

function buildChatGPTMessages(prompt, webSearch, systemPrompt) {
  return [{
    id: randomUUID(),
    author: { role: 'user' },
    create_time: Date.now() / 1000,
    content: { content_type: 'text', parts: [foldChatGPTSystemPrompt(systemPrompt, prompt)] },
    metadata: {
      developer_mode_connector_ids: [],
      selected_sources: webSearch ? ['web'] : [],
      selected_github_repos: [],
      selected_all_github_repos: false,
      serialization_metadata: { custom_symbol_offsets: [] },
    },
  }]
}

function buildChatGPTPayload(prompt, model, webSearch, systemPrompt) {
  const payload = {
    action: 'next',
    messages: buildChatGPTMessages(prompt, webSearch, systemPrompt),
    parent_message_id: 'client-created-root',
    model,
    client_prepare_state: 'success',
    timezone_offset_min: -new Date().getTimezoneOffset(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    conversation_mode: { kind: 'primary_assistant' },
    enable_message_followups: true,
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ['v1'],
    client_contextual_info: { app_name: 'chatgpt.com' },
    paragen_cot_summary_display_override: 'allow',
    force_parallel_switch: 'auto',
    thinking_effort: model.includes('thinking') ? 'extended' : 'auto',
  }
  if (webSearch) payload.force_use_tool = 'web'
  return payload
}

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

export function replaceChatGPTMessageContent(content, prompt) {
  if (!content || typeof content !== 'object') return { content_type: 'text', parts: [prompt] }
  if (Array.isArray(content.parts)) return { ...content, parts: [prompt] }
  return { ...content, text: prompt }
}

export function parseJson(value) {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

export function parseChatGPTTemplate(template) {
  return parseJson(template?.payload)
}

function resetChatGPTPayload(payload) {
  for (const key of [
    'conversation_id', 'conversationId', 'current_node', 'currentNode', 'parent_id',
    'parentId', 'response_id', 'responseId', 'suggestions', 'history_and_training_disabled',
  ]) delete payload[key]
}

function buildChatGPTTemplateMessage(options) {
  const { templateMessage, templateMetadata, prompt, systemPrompt, webSearch } = options
  return {
    ...templateMessage,
    id: randomUUID(),
    create_time: Date.now() / 1000,
    author: { ...(templateMessage.author || {}), role: 'user' },
    content: replaceChatGPTMessageContent(templateMessage.content, foldChatGPTSystemPrompt(systemPrompt, prompt)),
    metadata: { ...templateMetadata, selected_sources: webSearch ? ['web'] : [] },
  }
}

export function finalizeChatGPTPayload(payload, session, webSearch) {
  applyChatGPTConversationSession(payload, session)
  if (!payload.action || typeof payload.action !== 'string') payload.action = 'next'
  if (webSearch) payload.force_use_tool = 'web'
  return payload
}

export function buildChatGPTPayloadFromTemplate(options) {
  const { template, prompt, model, webSearch, systemPrompt, session = null } = options
  const payload = parseChatGPTTemplate(template)
  if (!payload || typeof payload !== 'object') return buildChatGPTPayload(prompt, model, webSearch, systemPrompt)
  const nextPayload = cloneJson(payload)
  const messages = Array.isArray(nextPayload.messages) ? nextPayload.messages : []
  const templateMessage = messages.find(message => message?.author?.role === 'user') || messages[0] || {}
  const templateMetadata = templateMessage?.metadata && typeof templateMessage.metadata === 'object' ? templateMessage.metadata : {}
  nextPayload.model = model
  resetChatGPTPayload(nextPayload)
  nextPayload.messages = [buildChatGPTTemplateMessage({ templateMessage, templateMetadata, prompt, systemPrompt, webSearch })]
  return finalizeChatGPTPayload(nextPayload, session, webSearch)
}
