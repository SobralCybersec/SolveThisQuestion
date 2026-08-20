import fs from 'node:fs'
import path from 'node:path'
import { chatGPTSessionFromTemplate, chatGPTSessionKey, latestChatGPTAssistantMessageId, loadChatGPTWebSessions, saveChatGPTWebSessions } from './chatgpt-web-session.mjs'
import { assertSafeAccountId, closeChromiumProfileInstances, isProfileSingletonError, removeStaleChromiumProfileLock } from './chromium-profile.mjs'
import { applyStealthScripts, bridgeDebug, chromium, ensureDir, envBool, isOnHost, resolveEngine, sleep, stealthArgs } from './browser-runtime.mjs'
import {
  CHATGPT_WEB_MODEL_ENDPOINTS,
  addKnownChatGPTModels,
  addModelCandidate,
  ensureSessionText,
  isCodexModelId,
  modelListResponse,
  scanPageModelHintsWithRetries,
  waitForInteractiveSelector,
} from './chatgpt-model-runtime.mjs'
import {
  buildChatGPTPayloadFromTemplate,
  cloneJson,
  compactChatGPTPrompt,
  finalizeChatGPTPayload,
  foldChatGPTSystemPrompt,
  parseChatGPTTemplate,
  parseJson,
  replaceChatGPTMessageContent,
} from './chatgpt-template-runtime.mjs'

const state = {
  chatgpt: {
    context: null,
    page: null,
    headless: null,
    initPromise: null,
    initPromiseKey: null,
    cachedHeaders: null,
    lastHeadersTime: 0,
    streamEmitter: null,
    streamLock: Promise.resolve(),
    runtimeDir: null,
    browserChoice: null,
    webSessions: new Map(),
  },
}


async function closeContext(context) {
  if (!context) return
  const browser = typeof context.browser === 'function' ? context.browser() : null
  await context.close().catch(() => {})
  if (browser) {
    await browser.close().catch(() => {})
  }
}

async function resumeChatGPTContext(selectedHeadless, selectedBrowser) {
  const matches = state.chatgpt.context
    && state.chatgpt.headless === selectedHeadless
    && state.chatgpt.browserChoice === selectedBrowser
    && state.chatgpt.runtimeDir === process.cwd()
  if (!matches) return false
  try {
    if (!state.chatgpt.page || state.chatgpt.page.isClosed()) {
      state.chatgpt.page = state.chatgpt.context.pages().find(candidate => !candidate.isClosed())
        || await state.chatgpt.context.newPage()
      await state.chatgpt.page.exposeBinding('__rustProxyHubStream', (_source, event) => {
        if (state.chatgpt.streamEmitter && event && typeof event === 'object') state.chatgpt.streamEmitter(event)
      })
    }
    await state.chatgpt.page.bringToFront()
    return true
  } catch (error) {
    bridgeDebug(`chatgpt stale session reset: ${error instanceof Error ? error.message : String(error)}`)
    await closeContext(state.chatgpt.context).catch(() => {})
    state.chatgpt.context = null
    state.chatgpt.page = null
    state.chatgpt.browserChoice = null
    return false
  }
}

async function resetChatGPTContext() {
  if (!state.chatgpt.context) return
  await persistChatGPTStorageState().catch(() => {})
  await closeContext(state.chatgpt.context)
  state.chatgpt.context = null
  state.chatgpt.page = null
  state.chatgpt.cachedHeaders = null
  state.chatgpt.lastHeadersTime = 0
  state.chatgpt.streamEmitter = null
  state.chatgpt.browserChoice = null
}

async function launchChatGPTContext(profileDir, selectedHeadless, browser) {
  ensureDir(profileDir)
  await closeChromiumProfileInstances(profileDir)
  removeStaleChromiumProfileLock(profileDir)
  let storageState
  try { storageState = JSON.parse(fs.readFileSync(chatGPTStorageStatePath(), 'utf8')) } catch {}
  const { engine, channel, executablePath } = resolveEngine(browser)
  const launchOptions = {
    headless: selectedHeadless,
    channel,
    executablePath,
    storageState,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: stealthArgs({ headless: selectedHeadless, executablePath, channel, engine }),
  }
  try {
    state.chatgpt.context = await engine.launchPersistentContext(profileDir, launchOptions)
  } catch (error) {
    if (!isProfileSingletonError(error)) throw error
    await closeChromiumProfileInstances(profileDir)
    removeStaleChromiumProfileLock(profileDir)
    state.chatgpt.context = await engine.launchPersistentContext(profileDir, launchOptions)
  }
  await applyStealthScripts(state.chatgpt.context)
  state.chatgpt.page = state.chatgpt.context.pages().find(candidate => isOnHost(candidate.url(), 'chatgpt.com'))
    || state.chatgpt.context.pages()[0]
    || await state.chatgpt.context.newPage()
  await state.chatgpt.page.exposeBinding('__rustProxyHubStream', (_source, event) => {
    if (state.chatgpt.streamEmitter && event && typeof event === 'object') state.chatgpt.streamEmitter(event)
  })
}

async function initChatGPTOnce({ runtime_dir, headless, browser }) {
  const runtimeDir = path.resolve(runtime_dir || process.cwd())
  const selectedHeadless = Boolean(headless)
  const selectedBrowser = String(browser || 'chromium').trim().toLowerCase()
  ensureDir(runtimeDir)
  process.chdir(runtimeDir)
  bridgeDebug(`chatgpt init headless=${selectedHeadless} browser=${selectedBrowser} runtime=${runtimeDir}`)
  if (state.chatgpt.runtimeDir !== process.cwd()) {
    state.chatgpt.runtimeDir = process.cwd()
    state.chatgpt.webSessions = loadChatGPTWebSessions(state.chatgpt.runtimeDir)
  }
  if (await resumeChatGPTContext(selectedHeadless, selectedBrowser)) return
  await resetChatGPTContext()
  await launchChatGPTContext(path.resolve('chatgpt_profile'), selectedHeadless, browser)
  state.chatgpt.headless = selectedHeadless
  state.chatgpt.browserChoice = selectedBrowser
  bridgeDebug(`chatgpt context ready headless=${selectedHeadless} browser=${selectedBrowser}`)
}

function isSessionAlive(session) {
  try {
    if (!session?.page || session.page.isClosed() || !session.context) return false
    const browser = typeof session.context.browser === 'function' ? session.context.browser() : null
    return !browser || typeof browser.isConnected !== 'function' || browser.isConnected()
  } catch {
    return false
  }
}

async function ensureLiveChatGPTSession() {
  if (isSessionAlive(state.chatgpt)) return
  if (!state.chatgpt.runtimeDir) throw new Error('ChatGPT Playwright not initialized')
  await initChatGPT({
    runtime_dir: state.chatgpt.runtimeDir,
    headless: state.chatgpt.headless !== false,
    browser: state.chatgpt.browserChoice || 'chromium',
  })
}

function persistChatGPTWebSessions() {
  if (!state.chatgpt.runtimeDir) return
  saveChatGPTWebSessions(state.chatgpt.runtimeDir, state.chatgpt.webSessions)
}

function chatGPTStorageStatePath() {
  return path.join(state.chatgpt.runtimeDir || process.cwd(), 'chatgpt-storage-state.json')
}

async function persistChatGPTStorageState() {
  if (!state.chatgpt.context || !state.chatgpt.runtimeDir) return
  const storageState = await state.chatgpt.context.storageState()
  const destination = chatGPTStorageStatePath()
  const temporary = `${destination}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(storageState), { mode: 0o600 })
  fs.renameSync(temporary, destination)
}

function chatGPTInitKey(params = {}) {
  return JSON.stringify({
    runtime_dir: path.resolve(params.runtime_dir || process.cwd()),
    headless: Boolean(params.headless),
    browser: String(params.browser || 'chromium').trim().toLowerCase(),
  })
}

const CHATGPT_INPUT_SELECTOR = 'textarea:visible, #prompt-textarea:visible, div[contenteditable="true"]:visible'
const CHATGPT_SEND_SELECTOR = 'button[data-testid="send-button"]:visible, button[aria-label="Send prompt"]:visible'

async function ensureChatGPTInteractivePage({ runtime_dir, browser } = {}) {
  let page = state.chatgpt.page
  if (!page) throw new Error('ChatGPT Playwright not initialized')
  if (!isOnHost(page.url(), 'chatgpt.com')) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
  }

  const waitForComposer = async (target) => {
    const input = target.locator(CHATGPT_INPUT_SELECTOR).first()
    await input.waitFor({ state: 'visible', timeout: 30000 })
    return input
  }

  try {
    await waitForComposer(page)
    return page
  } catch (error) {
    const title = await page.title().catch(() => '')
    const challenge = /just a moment|checking your browser|verify you are human/i.test(title)
    bridgeDebug(`chatgpt composer wait failed title=${JSON.stringify(title)} headless=${state.chatgpt.headless} challenge=${challenge}`)
    throw error
  }
}

async function initChatGPT(params = {}) {
  const key = chatGPTInitKey(params)
  while (state.chatgpt.initPromise && state.chatgpt.initPromiseKey !== key) {
    await state.chatgpt.initPromise.catch(() => {})
  }
  if (state.chatgpt.initPromise) return state.chatgpt.initPromise
  const promise = initChatGPTOnce(params)
  state.chatgpt.initPromise = promise
  state.chatgpt.initPromiseKey = key
  try {
    return await promise
  } finally {
    if (state.chatgpt.initPromise === promise) state.chatgpt.initPromise = null
    if (state.chatgpt.initPromise === null) state.chatgpt.initPromiseKey = null
  }
}

function chatGPTRequestHeaders(requestHeaders) {
  const value = key => requestHeaders[key] || ''
  return {
    authorization: value('authorization'),
    accept: requestHeaders.accept || 'text/event-stream',
    'accept-language': requestHeaders['accept-language'] || 'en-US,en;q=0.9',
    'content-type': requestHeaders['content-type'] || 'application/json',
    origin: requestHeaders.origin || 'https://chatgpt.com',
    referer: requestHeaders.referer || 'https://chatgpt.com/',
    'user-agent': value('user-agent'),
    'oai-client-build-number': value('oai-client-build-number'),
    'oai-client-version': value('oai-client-version'),
    'oai-device-id': value('oai-device-id'),
    'oai-language': requestHeaders['oai-language'] || 'en-US',
    'oai-session-id': value('oai-session-id'),
    'openai-sentinel-chat-requirements-token': value('openai-sentinel-chat-requirements-token'),
    'openai-sentinel-proof-token': value('openai-sentinel-proof-token'),
    'openai-sentinel-turnstile-token': value('openai-sentinel-turnstile-token'),
    'x-conduit-token': value('x-conduit-token'),
    'x-oai-turn-trace-id': value('x-oai-turn-trace-id'),
    'x-openai-target-path': requestHeaders['x-openai-target-path'] || '/backend-api/f/conversation',
    'x-openai-target-route': requestHeaders['x-openai-target-route'] || '/backend-api/f/conversation',
  }
}

function chatGPTPayloadModel(postData) {
  try {
    return JSON.parse(postData).model || 'chatgpt-web-session'
  } catch {
    return 'chatgpt-web-session'
  }
}

async function captureChatGPTTemplate(forceNew = false) {
  await ensureLiveChatGPTSession()

  if (!forceNew && state.chatgpt.cachedHeaders && Date.now() - state.chatgpt.lastHeadersTime < 5 * 60 * 1000) {
    return state.chatgpt.cachedHeaders
  }

  const page = await ensureChatGPTInteractivePage({
    runtime_dir: state.chatgpt.runtimeDir,
    browser: state.chatgpt.browserChoice,
  }).catch(() => {
    throw new Error('Timeout waiting for ChatGPT input. Are you logged in?')
  })
  const input = page.locator(CHATGPT_INPUT_SELECTOR).first()

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for ChatGPT request template')), 60000)
    const routeHandler = async (route, request) => {
      clearTimeout(timeout)
      const reqHeaders = request.headers()
      const postData = request.postData() || ''
      const headers = chatGPTRequestHeaders(reqHeaders)

      if (!headers.authorization) {
        await route.continue()
        return
      }

      state.chatgpt.cachedHeaders = {
        headers,
        payload: postData,
        model: chatGPTPayloadModel(postData),
        url: request.url(),
      }
      state.chatgpt.lastHeadersTime = Date.now()
      bridgeDebug(`chatgpt template headers captured auth=${Boolean(headers.authorization)} ua=${headers['user-agent'] ? headers['user-agent'].replace(/Chrome\/\d+/, 'Chrome/*') : 'missing'} sentinel=${Boolean(headers['openai-sentinel-chat-requirements-token'])}`)

      await route.abort('aborted')
      await page.unroute('**/backend-api/f/conversation*', routeHandler)
      resolve(state.chatgpt.cachedHeaders)
    }

    page
      .route('**/backend-api/f/conversation*', routeHandler)
      .then(async () => {
        try {
          await input.fill('a')
          await sleep(1500)
          await input.press('Enter')
        } catch (error) {
          clearTimeout(timeout)
          await page.unroute('**/backend-api/f/conversation*', routeHandler).catch(() => {})
          reject(error)
        }
      })
      .catch(reject)
  })
}

async function getChatGPTBasicHeaders() {
  const page = state.chatgpt.page
  if (!page) throw new Error('ChatGPT Playwright not initialized')

  const cookies = await page.context().cookies()
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ')
  const userAgent = await page.evaluate(() => navigator.userAgent)
  const template = state.chatgpt.cachedHeaders

  return {
    headers: {
      cookie,
      authorization: template?.headers?.authorization || '',
      'user-agent': userAgent,
      origin: 'https://chatgpt.com',
      referer: 'https://chatgpt.com/',
    },
  }
}



export {
  CHATGPT_INPUT_SELECTOR,
  CHATGPT_SEND_SELECTOR,
  CHATGPT_WEB_MODEL_ENDPOINTS,
  addKnownChatGPTModels,
  addModelCandidate,
  buildChatGPTPayloadFromTemplate,
  captureChatGPTTemplate,
  chatGPTInitKey,
  chatGPTPayloadModel,
  chatGPTRequestHeaders,
  chatGPTStorageStatePath,
  cloneJson,
  closeContext,
  compactChatGPTPrompt,
  ensureChatGPTInteractivePage,
  ensureLiveChatGPTSession,
  ensureSessionText,
  finalizeChatGPTPayload,
  foldChatGPTSystemPrompt,
  getChatGPTBasicHeaders,
  initChatGPT,
  isCodexModelId,
  modelListResponse,
  parseChatGPTTemplate,
  parseJson,
  persistChatGPTStorageState,
  persistChatGPTWebSessions,
  replaceChatGPTMessageContent,
  scanPageModelHintsWithRetries,
  state,
  waitForInteractiveSelector,
}
