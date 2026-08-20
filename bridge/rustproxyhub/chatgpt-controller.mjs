import fs from 'node:fs'
import path from 'node:path'
import { summarizePromptCompaction } from './prompt-compaction.mjs'
import { extractChatGPTAssistantModel, extractChatGPTAssistantReasoning, extractChatGPTAssistantText } from './chatgpt-web-response.mjs'
import { waitForChatGPTResponse } from './chatgpt-web-flow.mjs'
import { chatGPTSessionFromTemplate, chatGPTSessionKey, latestChatGPTAssistantMessageId } from './chatgpt-web-session.mjs'
import { CHATGPT_PAGE_REQUEST } from './chatgpt-web-page.mjs'
import { bridgeDebug, envBool, isOnHost, sleep } from './browser-runtime.mjs'
import { listChatGPTHybridModels } from './chatgpt-model-discovery.mjs'
import { chatChatGPTWithImage } from './chatgpt-image-controller.mjs'
import {
  CHATGPT_INPUT_SELECTOR,
  CHATGPT_WEB_MODEL_ENDPOINTS,
  addKnownChatGPTModels,
  addModelCandidate,
  buildChatGPTPayloadFromTemplate,
  captureChatGPTTemplate,
  closeContext,
  compactChatGPTPrompt,
  ensureChatGPTInteractivePage,
  ensureLiveChatGPTSession,
  ensureSessionText,
  getChatGPTBasicHeaders,
  initChatGPT,
  isCodexModelId,
  modelListResponse,
  parseJson,
  persistChatGPTStorageState,
  persistChatGPTWebSessions,
  scanPageModelHintsWithRetries,
  state,
  waitForInteractiveSelector,
} from './chatgpt-session-runtime.mjs'

async function listChatGPTModels() {
  const page = state.chatgpt.page
  if (!page) throw new Error('ChatGPT Playwright not initialized')
  if (!isOnHost(page.url(), 'chatgpt.com')) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
  }

  await waitForInteractiveSelector(page, [
    'textarea:visible',
    '#prompt-textarea:visible',
    'div[contenteditable="true"]:visible',
  ])

  const ids = await scanPageModelHintsWithRetries(page, 'chatgpt', CHATGPT_WEB_MODEL_ENDPOINTS)
  addKnownChatGPTModels(ids)
  if (state.chatgpt.cachedHeaders?.model) addModelCandidate(ids, 'chatgpt', state.chatgpt.cachedHeaders.model)
  return {
    ...modelListResponse(ids, 'chatgpt', 'chatgpt-web-session'),
    discovery: {
      provider: 'chatgpt',
      source: 'playwright',
      api: 'chat_completions',
      endpoints: CHATGPT_WEB_MODEL_ENDPOINTS,
    },
  }
}

async function sendChatGPTConversation(context) {
  const { page, template, model, web_search, system_prompt, session, preparedPrompt, emitStream } = context
  const requestHeaders = { ...template.headers }
  delete requestHeaders.cookie
  const payload = buildChatGPTPayloadFromTemplate({
    template,
    prompt: preparedPrompt.text,
    model: ensureSessionText(model, template.model || 'chatgpt-web-session'),
    webSearch: web_search,
    systemPrompt: system_prompt || null,
    session,
  })
  const requestResult = await page.evaluate(CHATGPT_PAGE_REQUEST, {
    headers: requestHeaders,
    payload,
    submittedPrompt: preparedPrompt.text,
    stream: Boolean(emitStream),
  })
  if (process.env.RUST_PROXY_DUMP_CHATGPT_SSE === '1' && requestResult.body) {
    fs.writeFileSync('/tmp/solvethisquestion-login-fix/chatgpt-sse-debug.txt', requestResult.body)
  }
  bridgeDebug(`chatgpt conversation submit status=${requestResult.status} conversation=${Boolean(requestResult.conversationId)} bytes=${requestResult.body?.length || 0} sse=${requestResult.body?.includes('data:') || false} stream=${Boolean(requestResult.streamText)} shape=${JSON.stringify(requestResult.streamShape || {})}`)
  return { payload, requestResult, preparedPrompt }
}

function normalizeChatGPTPrompt(prompt, web_search) {
  const normalized = prompt.replace(/@WebSearch\b/gi, '@Web search')
  return web_search && !/@Web search\s*$/i.test(normalized.trim())
    ? `${normalized.trim()}\n\n@Web search`
    : normalized
}

async function sendChatGPTWithRetries(context) {
  let { template, session } = context
  const send = preparedPrompt => sendChatGPTConversation({ ...context, template, session, preparedPrompt })
  let sent = await send(compactChatGPTPrompt(context.prompt, 18000))
  if (sent.requestResult.status === 401 || sent.requestResult.status === 403) {
    template = await captureChatGPTTemplate(true)
    session = state.chatgpt.webSessions.get(context.sessionKey) || chatGPTSessionFromTemplate(template)
    if (session) state.chatgpt.webSessions.set(context.sessionKey, session)
    sent = await send(compactChatGPTPrompt(context.prompt, 18000))
  }
  if (sent.requestResult.status === 413) sent = await send(compactChatGPTPrompt(context.prompt, 9000))
  return { template, session, sent }
}

function conversationIdFrom(sent) {
  return sent.requestResult.conversationId || sent.payload.conversation_id || ''
}

function assertChatGPTConversation(sent, conversationId) {
  if (sent.requestResult.ok && conversationId) return
  const detail = sent.requestResult.body?.trim()
  const suffix = detail ? `: ${detail.slice(0, 400)}` : ''
  throw new Error(`ChatGPT upstream request failed with status ${sent.requestResult.status}${suffix}`)
}

async function readChatGPTConversation(options) {
  const { page, conversationId, responseHeaders, previousAssistantMessageId, prompt } = options
  return waitForChatGPTResponse({
    read: () => page.context().request.get(
      `https://chatgpt.com/backend-api/conversation/${conversationId}`,
      { headers: responseHeaders, timeout: 10000 },
    ),
    extractText: body => {
      try {
        const payload = JSON.parse(body)
        if (previousAssistantMessageId && latestChatGPTAssistantMessageId(payload) === previousAssistantMessageId) return ''
        return extractChatGPTAssistantText(payload, prompt)
      } catch {
        return ''
      }
    },
    onAttempt: (status, attempt) => {
      if (attempt === 1 || [401, 403].includes(status)) {
        bridgeDebug(`chatgpt conversation poll status=${status} attempt=${attempt}`)
      }
    },
  })
}

function parseConversation(conversation) {
  return parseJson(conversation.body)
}

function logConversationShape(payload) {
  const entries = payload?.mapping && typeof payload.mapping === 'object' ? Object.values(payload.mapping) : []
  bridgeDebug(`chatgpt conversation shape keys=${Object.keys(payload || {}).slice(0, 12).join(',')} roles=${entries.map(entry => entry?.message?.author?.role).filter(Boolean).join(',') || 'none'}`)
}

function updateChatGPTSession(sessionKey, conversationId, payload, sent) {
  if (!sessionKey) return
  const parentMessageId = latestChatGPTAssistantMessageId(payload) || sent.requestResult.streamMessageId || ''
  if (parentMessageId) {
    state.chatgpt.webSessions.set(sessionKey, { conversation_id: conversationId, parent_message_id: parentMessageId, updated_at: Date.now() })
  } else if (!sent.requestResult.streamText) {
    state.chatgpt.webSessions.delete(sessionKey)
  }
  persistChatGPTWebSessions()
}

function buildChatGPTResult(payload, sent, conversationId) {
  const text = extractChatGPTAssistantText(payload, sent.preparedPrompt.text) || sent.requestResult.streamText
  const reasoningContent = extractChatGPTAssistantReasoning(payload) || sent.requestResult.streamReasoning
  if (!text) throw new Error('ChatGPT response was empty. Confirm session is active, then retry.')
  return {
    text,
    model: extractChatGPTAssistantModel(payload) || sent.requestResult.streamModel || sent.payload.model,
    reasoning_content: reasoningContent || null,
    conversation_id: conversationId,
    upstream_cache: sent.requestResult.upstream_cache,
    warning: summarizePromptCompaction(sent.preparedPrompt),
  }
}

async function chatChatGPTWeb(options) {
  const { model, prompt, system_prompt, web_search = false, session_id = null, emitStream = null } = options
  await ensureLiveChatGPTSession()
  const page = state.chatgpt.page
  if (!page) throw new Error('ChatGPT Playwright not initialized')
  const template = await captureChatGPTTemplate(false)
  const sessionKey = chatGPTSessionKey(session_id)
  const session = state.chatgpt.webSessions.get(sessionKey) || chatGPTSessionFromTemplate(template)
  if (session) state.chatgpt.webSessions.set(sessionKey, session)
  const context = { page, template, session, sessionKey, model, web_search, system_prompt, emitStream, prompt: normalizeChatGPTPrompt(prompt, web_search) }
  const sentState = await sendChatGPTWithRetries(context)
  const { sent } = sentState
  const conversationId = conversationIdFrom(sent)
  assertChatGPTConversation(sent, conversationId)
  let responseHeaders = { ...sentState.template.headers }
  delete responseHeaders.cookie
  let conversation = sent.requestResult.streamText
    ? { body: '', status: 200 }
    : await readChatGPTConversation({ page, conversationId, responseHeaders, previousAssistantMessageId: sentState.session?.parent_message_id || '', prompt: sent.preparedPrompt.text })
  bridgeDebug(`chatgpt conversation read status=${conversation.status} bytes=${conversation.body?.length || 0}`)
  if ([401, 403].includes(conversation.status)) {
    const refreshed = await captureChatGPTTemplate(true)
    responseHeaders = { ...refreshed.headers }
    delete responseHeaders.cookie
    conversation = await readChatGPTConversation({ page, conversationId, responseHeaders, previousAssistantMessageId: sentState.session?.parent_message_id || '', prompt: sent.preparedPrompt.text })
    bridgeDebug(`chatgpt conversation reread status=${conversation.status} bytes=${conversation.body?.length || 0}`)
  }
  if ([401, 403].includes(conversation.status)) throw new Error(`ChatGPT web conversation read unauthorized (HTTP ${conversation.status})`)
  const payload = parseConversation(conversation)
  logConversationShape(payload)
  updateChatGPTSession(sessionKey, conversationId, payload, sent)
  return buildChatGPTResult(payload, sent, conversationId)
}

async function chatChatGPT(options) {
  const { model, prompt, system_prompt, web_search = false, session_id = null, emitStream = null } = options
  const selectedModel = ensureSessionText(model, 'chatgpt-web-session')
  const previousStream = state.chatgpt.streamLock
  let releaseStream
  state.chatgpt.streamLock = new Promise(resolve => {
    releaseStream = resolve
  })
  await previousStream
  try {
    const previousEmitter = state.chatgpt.streamEmitter
    state.chatgpt.streamEmitter = emitStream
    try {
      return await chatChatGPTWeb({ model: selectedModel, prompt, system_prompt, web_search, session_id, emitStream })
    } finally {
      state.chatgpt.streamEmitter = previousEmitter
    }
  } finally {
    releaseStream()
  }
}

async function openChatGPTLogin({ runtime_dir, browser } = {}) {
  bridgeDebug(`chatgpt manual login start browser=${browser || 'chromium'}`)
  await initChatGPT({ runtime_dir, headless: false, browser })
  await state.chatgpt.page.bringToFront().catch(() => {})
  await state.chatgpt.page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
  bridgeDebug(`chatgpt manual login ready url=${state.chatgpt.page.url()}`)
}

async function openChatGPTLoginAndWait(params) {
  await openChatGPTLogin(params)
  const deadline = Date.now() + Number(process.env.SCREEN_AGENT_LOGIN_TIMEOUT_MS || 300000)
  const page = state.chatgpt.page
  const composerSelector = 'textarea:visible, #prompt-textarea:visible, div[contenteditable="true"]:visible'
  while (Date.now() < deadline) {
    const cookies = await state.chatgpt.context.cookies('https://chatgpt.com').catch(() => [])
    const hasSessionCookie = cookies.some((cookie) => /session-token/i.test(cookie.name) && cookie.value)
    const hasComposer = await page?.locator(composerSelector).first().isVisible().catch(() => false)
    const loginFormVisible = await page?.locator('input[type="email"], input[name="username"], input[type="password"]').first().isVisible().catch(() => false)
    if (hasSessionCookie && hasComposer && !loginFormVisible) {
      return { logged_in: true, profile_dir: path.resolve('chatgpt_profile') }
    }
    await sleep(1500)
  }
  throw new Error('ChatGPT login timed out. Sign in, then retry.')
}

async function chatGPTStatus({ runtime_dir, browser } = {}) {
  await initChatGPT({
    runtime_dir,
    headless: state.chatgpt.context ? state.chatgpt.headless : envBool('SCREEN_AGENT_CHATGPT_HEADLESS', true),
    browser: browser || state.chatgpt.browserChoice || 'chromium',
  })
  let page = state.chatgpt.page
  try {
    page = await ensureChatGPTInteractivePage({ runtime_dir, browser })
  } catch (error) {
    bridgeDebug(`chatgpt status unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const cookies = await state.chatgpt.context.cookies('https://chatgpt.com').catch(() => [])
  const hasComposer = await page?.locator(CHATGPT_INPUT_SELECTOR).first().isVisible().catch(() => false)
  return {
    mode: 'embedded',
    logged_in: cookies.some((cookie) => /session-token/i.test(cookie.name) && cookie.value) && hasComposer,
    profile_dir: path.resolve('chatgpt_profile'),
  }
}


async function closeAll() {
  if (state.chatgpt.context) {
    await persistChatGPTStorageState().catch(() => {})
    await closeContext(state.chatgpt.context)
    state.chatgpt.context = null
    state.chatgpt.page = null
    state.chatgpt.headless = null
    state.chatgpt.cachedHeaders = null
    state.chatgpt.lastHeadersTime = 0
    state.chatgpt.browserChoice = null
    state.chatgpt.streamEmitter = null
  }
}

async function shutdownAndExit(code = 0) {
  await closeAll().catch((error) => {
    process.stderr.write(`shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  process.exit(code)
}

const CHATGPT_HANDLERS = {
  'chatgpt:init': ({ params }) => initChatGPT(params),
  'chatgpt:capture_headers': ({ params }) => captureChatGPTTemplate(!!params.force_new),
  'chatgpt:basic_headers': () => getChatGPTBasicHeaders(),
  'chatgpt:manual_login': ({ params }) => openChatGPTLogin(params),
  'chatgpt:manual_login_wait': ({ params }) => openChatGPTLoginAndWait({ ...(params || {}), headless: false }),
  'chatgpt:status': ({ params }) => chatGPTStatus(params),
  'chatgpt:chat_image': ({ params }) => chatChatGPTWithImage(params),
  'chatgpt:list_models': () => listChatGPTHybridModels({
    state,
    listModels: listChatGPTModels,
    endpoints: CHATGPT_WEB_MODEL_ENDPOINTS,
    addKnownModels: addKnownChatGPTModels,
    addModelCandidate,
    isCodexModelId,
  }),
  'chatgpt:chat': ({ params, emitStream }) => chatChatGPT({ ...params, emitStream: params?.stream ? emitStream : null }),
}

async function handle(method, provider, params, emitStream = null) {
  const key = `${provider}:${method}`
  if (key === 'chatgpt:shutdown') {
    await closeAll()
    setImmediate(() => process.exit(0))
    return { ok: true }
  }
  const handler = CHATGPT_HANDLERS[key]
  if (!handler) throw new Error(`Unsupported helper call: ${key}`)
  return handler({ params: params || {}, emitStream })
}

export { handle, shutdownAndExit }
