import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractChatGPTAssistantModel, extractChatGPTAssistantReasoning, extractChatGPTAssistantText } from './chatgpt-web-response.mjs'
import { DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS, submitChatGPTPrompt, waitForAssistantAnswer, waitForChatGPTResponse } from './chatgpt-web-flow.mjs'
import { applyChatGPTConversationSession, chatGPTSessionFromTemplate, chatGPTSessionKey, latestChatGPTAssistantMessageId, loadChatGPTWebSessions, saveChatGPTWebSessions } from './chatgpt-web-session.mjs'
import { compactStructuredPrompt, summarizePromptCompaction } from './prompt-compaction.mjs'
import { CHATGPT_PAGE_REQUEST } from './chatgpt-web-page.mjs'
import { assertSafeAccountId, closeChromiumProfileInstances, isProfileSingletonError, removeStaleChromiumProfileLock } from './chromium-profile.mjs'

// Fix IPv6/IPv4 resolution issue in Node 17+ (localhost resolves to ::1 instead of 127.0.0.1)
// See: https://github.com/microsoft/playwright/issues/20784
dns.setDefaultResultOrder('ipv4first')

// Host check that survives scrutiny: parse the URL and compare the hostname
// exactly (or as a dot-boundary subdomain). `url.includes('kimi.com')` also
// matches 'kimi.com.evil.com' and 'evil.com/?x=kimi.com' — this does not.
function isOnHost(rawUrl, ...hosts) {
  let host
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return hosts.some((h) => {
    const target = h.toLowerCase()
    return host === target || host.endsWith(`.${target}`)
  })
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
async function importPlaywright() {
  const candidateUrls = [
    new URL('./node_modules/playwright/index.mjs', import.meta.url),
    new URL('../node_modules/playwright/index.mjs', import.meta.url),
    new URL('../../node_modules/playwright/index.mjs', import.meta.url),
    new URL('../../../node_modules/playwright/index.mjs', import.meta.url),
  ]

  for (const candidate of candidateUrls) {
    if (fs.existsSync(fileURLToPath(candidate))) {
      return import(candidate)
    }
  }

  const pnpmRoots = [
    path.resolve(__dirname, 'node_modules', '.pnpm'),
    path.resolve(__dirname, '..', 'node_modules', '.pnpm'),
    path.resolve(__dirname, '..', '..', 'node_modules', '.pnpm'),
    path.resolve(__dirname, '..', '..', '..', 'node_modules', '.pnpm'),
  ]

  for (const root of pnpmRoots) {
    if (!fs.existsSync(root)) {
      continue
    }

    const playwrightDir = fs
      .readdirSync(root, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith('playwright@'))

    if (!playwrightDir) {
      continue
    }

    const candidate = path.join(root, playwrightDir.name, 'node_modules', 'playwright', 'index.mjs')
    if (fs.existsSync(candidate)) {
      return import(pathToFileURL(candidate).href)
    }
  }

  return import('playwright')
}

export function browserBackendFromEnv(env = process.env) {
  const backend = String(env.RUST_PROXY_BROWSER_BACKEND || 'playwright').trim().toLowerCase()
  if (backend !== 'playwright' && backend !== 'patchright') {
    throw new Error(`unsupported browser backend: ${backend}`)
  }
  return backend
}

async function importBrowserAutomation() {
  const backend = browserBackendFromEnv()
  if (backend === 'playwright') return importPlaywright()
  try {
    return await import('patchright')
  } catch (error) {
    throw new Error(
      `Patchright backend selected but package is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const playwright = await importBrowserAutomation()
const { chromium, firefox, webkit } = playwright

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

const BROWSER_PATHS = {
  msedge: [
    '/opt/microsoft/msedge/msedge',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge-beta',
    '/usr/bin/microsoft-edge-dev',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  chrome: [
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
  chromium: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
}

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate))
}

const BROWSER_PATH_NAMES = {
  msedge: ['msedge', 'microsoft-edge', 'microsoft-edge-stable'],
  chrome: ['chrome', 'google-chrome', 'google-chrome-stable'],
  chromium: ['chromium', 'chromium-browser'],
}

function firstOnPath(names) {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => path.join(directory, name)))
    .find((candidate) => fs.existsSync(candidate))
}

function browserExecutablePath(browser) {
  return firstExisting(BROWSER_PATHS[browser] ?? []) || firstOnPath(BROWSER_PATH_NAMES[browser] ?? [])
}

// Resolve a Chromium launch config. If the requested channel's real
// distribution is installed, drive it via `channel` (Playwright applies the
// right profile flags). Otherwise point `executablePath` at whatever
// Chromium-family browser IS installed — preferring the requested family, then
// Edge → Chrome → Chromium. Last resort is Playwright's bundled chromium.
function resolveChromium(preferredChannel) {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  if (override && fs.existsSync(override)) {
    return { engine: chromium, executablePath: override }
  }
  if (preferredChannel && firstExisting(BROWSER_PATHS[preferredChannel] ?? [])) {
    return { engine: chromium, channel: preferredChannel }
  }
  const order = preferredChannel
    ? [preferredChannel, 'msedge', 'chrome', 'chromium']
    : ['chromium', 'chrome', 'msedge']
  for (const key of order) {
    const executablePath = browserExecutablePath(key)
    if (executablePath) {
      return { engine: chromium, executablePath }
    }
  }
  return { engine: chromium }
}

function chromiumCommands({ executablePath, channel, engine } = {}) {
  return [
    executablePath,
    channel === 'chrome' ? 'google-chrome' : null,
    channel === 'msedge' ? 'microsoft-edge' : null,
    channel === 'chromium' ? 'chromium' : null,
    'chromium',
    'google-chrome',
    'microsoft-edge',
    typeof engine?.executablePath === 'function' ? engine.executablePath() : null,
  ].filter(Boolean)
}

function chromiumVersionFrom(command) {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    })
    const version = output.split(' ').find(value => value[0] >= '0' && value[0] <= '9') || ''
    return version.split('.')[0]
  } catch {
    return ''
  }
}

function chromiumMajorVersion(options = {}) {
  const { executablePath, channel, engine } = options
  const configured = Number(process.env.RUST_PROXY_CHROMIUM_MAJOR)
  if (Number.isInteger(configured) && configured > 0) return String(configured)
  for (const command of chromiumCommands({ executablePath, channel, engine })) {
    const major = chromiumVersionFrom(command)
    if (major) return major
  }
  return ''
}

function stealthArgs({ headless = false, executablePath, channel, engine } = {}) {
  const args = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=DevToolsDebuggingRestrictions,CalculateNativeWinOcclusion',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-client-side-phishing-detection',
  ]
  if (headless && engine === chromium) {
    const major = chromiumMajorVersion({ executablePath, channel, engine })
    const configuredUserAgent = String(process.env.RUST_PROXY_HEADLESS_USER_AGENT || '').trim()
    const userAgent = configuredUserAgent || (major
      ? `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
      : '')
    if (userAgent) args.push(`--user-agent=${userAgent}`)
    args.push('--window-size=1920,1080')
    bridgeDebug(`chatgpt headless launch ua=${userAgent ? userAgent.replace(/Chrome\/\d+/, 'Chrome/*') : 'default'} major=${major || 'unknown'}`)
  }
  return args
}

async function applyStealthScripts(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', {
      get: () => Object.assign([1, 2, 3, 4, 5], { item: () => null, namedItem: () => null, refresh: () => {} }),
    })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
    if (!window.chrome) window.chrome = {}
    if (!window.chrome.runtime) window.chrome.runtime = {}
    ;[
      'cdc_adoQpoasnfa76pfcZLmcfl_Array',
      'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
      'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
    ].forEach((key) => { try { delete window[key] } catch {} })
  })
}

function envBool(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase()
  return value == null || value === '' ? fallback : !['0', 'false', 'no', 'off'].includes(value)
}

function resolveEngine(browser) {
  if (browserBackendFromEnv() === 'patchright' && !['chromium', 'chrome', 'msedge', 'edge'].includes(String(browser || 'chromium').toLowerCase())) {
    throw new Error('patchright backend supports Chromium-family browsers only')
  }
  switch (browser) {
    case 'firefox':
      return { engine: firefox }
    case 'webkit':
      return { engine: webkit }
    case 'chrome':
      return resolveChromium('chrome')
    case 'edge':
    case 'msedge':
      return resolveChromium('msedge')
    case 'chromium':
    default:
      return resolveChromium(null)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bridgeDebug(message) {
  process.stderr.write(`[bridge] ${message}\n`)
}

function send(id, result = null, error = null) {
  process.stdout.write(`${JSON.stringify({ id, result, error })}\n`)
}

function sendEvent(id, event, result = null) {
  process.stdout.write(`${JSON.stringify({ id, event, result })}\n`)
}

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

const MODEL_KEY_RE = /["'](?:model|model_slug|slug|id|name)["']\s*:\s*["']([a-zA-Z0-9][\w.:-]{1,95})["']/g
const CHATGPT_MODEL_RE = /^(?:gpt|o[0-9]|chatgpt)[a-z0-9_.:-]*$/i
const GENERIC_MODEL_RE = /^[a-z0-9][a-z0-9_.:-]{1,80}$/i
const GENERIC_MODEL_SCAN_RE = /\b[a-z][a-z0-9_.:-]{1,80}\b/g
const DIRECT_MODEL_PATTERNS = {
  chatgpt: /\b(?:gpt|o[0-9]|chatgpt)[a-zA-Z0-9_.:-]{1,80}\b/g,
}

function ensureSessionText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function modelPattern(provider) {
  return provider === 'chatgpt' ? CHATGPT_MODEL_RE : GENERIC_MODEL_RE
}

function addModelCandidate(target, provider, value) {
  if (typeof value !== 'string') return
  const clean = value.trim().replace(/^model:/i, '').replace(/^models\//i, '')
  if (!clean || clean.length > 96 || /\s/.test(clean)) return
  if (modelPattern(provider).test(clean)) target.add(clean)
}

// #lizard forgive
function collectModelIds(value, provider, target, depth = 0) {
  // #lizard forgive
  if (depth > 8 || value == null) return

  if (typeof value === 'string') {
    addModelCandidate(target, provider, value)
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 500000) {
      try {
        collectModelIds(JSON.parse(trimmed), provider, target, depth + 1)
      } catch {}
    }

    for (const match of trimmed.matchAll(MODEL_KEY_RE)) addModelCandidate(target, provider, match[1])
    for (const match of trimmed.matchAll(DIRECT_MODEL_PATTERNS[provider] || GENERIC_MODEL_SCAN_RE)) {
      addModelCandidate(target, provider, match[0])
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectModelIds(item, provider, target, depth + 1)
    return
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:model|model_slug|slug|id|name)$/i.test(key)) {
        addModelCandidate(target, provider, child)
      }
      collectModelIds(child, provider, target, depth + 1)
    }
  }
}

function modelListResponse(ids, provider, fallbackModel) {
  const data = [...ids].length ? [...ids] : [fallbackModel]
  return {
    data: data.map(id => ({ id, provider })),
  }
}

const CHATGPT_WEB_MODEL_ENDPOINTS = [
  '/backend-api/models',
  '/backend-api/f/models',
  '/backend-api/model_slug_availability',
]

const CHATGPT_WEB_MODEL_IDS = [
  'gpt-5-3',
  'gpt-5.5',
  'gpt-5.5-thinking',
  'gpt-5',
  'gpt-4.1',
  'o3',
  'o4-mini',
  'chatgpt-web-session',
]

function isCodexModelId(id) {
  const lower = String(id || '').toLowerCase()
  return lower.includes('codex') || lower.includes('cyber')
}

function addKnownChatGPTModels(target) {
  for (const id of CHATGPT_WEB_MODEL_IDS) {
    addModelCandidate(target, 'chatgpt', id)
  }
}

async function scanPageModelHints(page, provider, endpointPaths = []) {
  const bodies = await page.evaluate(async ({ endpointPaths }) => {
    const out = []
    const add = value => {
      if (typeof value === 'string' && value.trim()) out.push(value.slice(0, 500000))
    }

    for (const endpoint of endpointPaths) {
      try {
        const response = await fetch(endpoint, { credentials: 'include' })
        if (response.ok) add(await response.text())
      } catch {}
    }

    try {
      add(JSON.stringify(window.__NEXT_DATA__ || window.__NUXT__ || {}))
    } catch {}

    for (const script of Array.from(document.scripts).slice(0, 80)) {
      const text = script.textContent || ''
      if (/model|gemini|gpt|mistral|codestral|magistral|glm|autoglm|zai|meta|llama/i.test(text)) add(text)
    }

    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) || ''
          const value = storage.getItem(key) || ''
          if (/model|gemini|gpt|mistral|codestral|magistral|glm|autoglm|zai|meta|llama/i.test(`${key} ${value}`)) {
            add(`${key} ${value}`)
          }
        }
      } catch {}
    }

    for (const resource of performance.getEntriesByType('resource').map(entry => entry.name)) {
      if (/batchexecute|model|init|template|status/i.test(resource)) add(resource)
    }

    return out
  }, { endpointPaths })

  const ids = new Set()
  for (const body of bodies) collectModelIds(body, provider, ids)
  return ids
}

async function waitForInteractiveSelector(page, selectors, timeout = 30000) {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout })
      return selector
    } catch {}
  }

  throw new Error(`Timeout waiting for interactive selector: ${selectors.join(', ')}`)
}

async function scanPageModelHintsWithRetries(page, provider, endpointPaths = [], attempts = 3) {
  let ids = new Set()
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    ids = await scanPageModelHints(page, provider, endpointPaths)
    if (ids.size > 0) {
      return ids
    }
    await sleep(1200)
  }
  return ids
}

async function closeContext(context) {
  if (!context) return
  const browser = typeof context.browser === 'function' ? context.browser() : null
  await context.close().catch(() => {})
  if (browser) {
    await browser.close().catch(() => {})
  }
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
  if (
    state.chatgpt.context &&
    state.chatgpt.headless === selectedHeadless &&
    state.chatgpt.browserChoice === selectedBrowser &&
    state.chatgpt.runtimeDir === process.cwd()
  ) {
    try {
      if (!state.chatgpt.page || state.chatgpt.page.isClosed()) {
        state.chatgpt.page = state.chatgpt.context.pages().find((candidate) => !candidate.isClosed())
          || await state.chatgpt.context.newPage()
        await state.chatgpt.page.exposeBinding('__rustProxyHubStream', (_source, event) => {
          if (state.chatgpt.streamEmitter && event && typeof event === 'object') {
            state.chatgpt.streamEmitter(event)
          }
        })
      }
      await state.chatgpt.page.bringToFront()
      return
    } catch (error) {
      bridgeDebug(`chatgpt stale session reset: ${error instanceof Error ? error.message : String(error)}`)
      await closeContext(state.chatgpt.context).catch(() => {})
      state.chatgpt.context = null
      state.chatgpt.page = null
      state.chatgpt.browserChoice = null
    }
  }
  if (state.chatgpt.context) {
    await persistChatGPTStorageState().catch(() => {})
    await closeContext(state.chatgpt.context)
    state.chatgpt.context = null
    state.chatgpt.page = null
    state.chatgpt.cachedHeaders = null
    state.chatgpt.lastHeadersTime = 0
    state.chatgpt.streamEmitter = null
    state.chatgpt.browserChoice = null
  }
  const profileDir = path.resolve('chatgpt_profile')
  ensureDir(profileDir)
  await closeChromiumProfileInstances(profileDir)
  removeStaleChromiumProfileLock(profileDir)
  let storageState
  try {
    storageState = JSON.parse(fs.readFileSync(chatGPTStorageStatePath(), 'utf8'))
  } catch {}
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
  state.chatgpt.page = state.chatgpt.context.pages().find((candidate) => isOnHost(candidate.url(), 'chatgpt.com'))
    || state.chatgpt.context.pages()[0]
    || await state.chatgpt.context.newPage()
  await state.chatgpt.page.exposeBinding('__rustProxyHubStream', (_source, event) => {
    if (state.chatgpt.streamEmitter && event && typeof event === 'object') {
      state.chatgpt.streamEmitter(event)
    }
  })
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

// chatgpt.com's web conversation endpoint silently drops client-supplied
// `author.role: "system"` turns — the trusted system prompt is composed
// server-side (account Custom Instructions), never from an inline message. The
// only per-request way to make instructions land is to fold them into the user
// turn, matching the "User:/Assistant:" transcript that split_prompt builds.
function foldChatGPTSystemPrompt(systemPrompt, prompt) {
  const sys = (systemPrompt || '').trim()
  if (!sys) return prompt
  return `System: ${sys}\n\n${prompt}`
}

function buildChatGPTMessages(prompt, webSearch, systemPrompt) {
  const messages = []
  messages.push({
    id: randomUUID(),
    author: { role: 'user' },
    create_time: Date.now() / 1000,
    content: {
      content_type: 'text',
      parts: [foldChatGPTSystemPrompt(systemPrompt, prompt)],
    },
    metadata: {
      developer_mode_connector_ids: [],
      selected_sources: webSearch ? ['web'] : [],
      selected_github_repos: [],
      selected_all_github_repos: false,
      serialization_metadata: { custom_symbol_offsets: [] },
    },
  })
  return messages
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
    client_contextual_info: {
      app_name: 'chatgpt.com',
    },
    paragen_cot_summary_display_override: 'allow',
    force_parallel_switch: 'auto',
    thinking_effort: model.includes('thinking') ? 'extended' : 'auto',
  }
  if (webSearch) payload.force_use_tool = 'web'
  return payload
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function replaceChatGPTMessageContent(content, prompt) {
  if (!content || typeof content !== 'object') {
    return {
      content_type: 'text',
      parts: [prompt],
    }
  }

  if (Array.isArray(content.parts)) {
    return {
      ...content,
      parts: [prompt],
    }
  }

  return {
    ...content,
    text: prompt,
  }
}

function compactChatGPTPrompt(prompt, maxChars = 18000) {
  return compactStructuredPrompt(prompt, { maxChars })
}

function parseJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseChatGPTTemplate(template) {
  return parseJson(template?.payload)
}

function resetChatGPTPayload(payload) {
  for (const key of [
    'conversation_id', 'conversationId', 'current_node', 'currentNode', 'parent_id',
    'parentId', 'response_id', 'responseId', 'suggestions', 'history_and_training_disabled',
  ]) delete payload[key]
}

function buildChatGPTTemplateMessage(templateMessage, templateMetadata, prompt, systemPrompt, webSearch) {
  return {
    ...templateMessage,
    id: randomUUID(),
    create_time: Date.now() / 1000,
    author: { ...(templateMessage.author || {}), role: 'user' },
    content: replaceChatGPTMessageContent(templateMessage.content, foldChatGPTSystemPrompt(systemPrompt, prompt)),
    metadata: { ...templateMetadata, selected_sources: webSearch ? ['web'] : [] },
  }
}

function finalizeChatGPTPayload(payload, session, webSearch) {
  applyChatGPTConversationSession(payload, session)
  if (!payload.action || typeof payload.action !== 'string') payload.action = 'next'
  if (webSearch) payload.force_use_tool = 'web'
  return payload
}

function buildChatGPTPayloadFromTemplate({ template, prompt, model, webSearch, systemPrompt, session = null }) {
  const payload = parseChatGPTTemplate(template)
  if (!payload || typeof payload !== 'object') return buildChatGPTPayload(prompt, model, webSearch, systemPrompt)
  const nextPayload = cloneJson(payload)
  const messages = Array.isArray(nextPayload.messages) ? nextPayload.messages : []
  const templateMessage = messages.find((message) => message?.author?.role === 'user') || messages[0] || {}
  const templateMetadata = templateMessage?.metadata && typeof templateMessage.metadata === 'object' ? templateMessage.metadata : {}
  nextPayload.model = model
  resetChatGPTPayload(nextPayload)
  nextPayload.messages = [buildChatGPTTemplateMessage(templateMessage, templateMetadata, prompt, systemPrompt, webSearch)]
  return finalizeChatGPTPayload(nextPayload, session, webSearch)
}

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

async function listChatGPTHybridModels() {
  const items = []
  const errors = []
  const seen = new Set()
  let webDiscovery = {
    provider: 'chatgpt',
    source: 'playwright',
    api: 'chat_completions',
    endpoints: CHATGPT_WEB_MODEL_ENDPOINTS,
  }
  const ids = new Set()
  addKnownChatGPTModels(ids)
  if (state.chatgpt.page) {
    try {
      const web = await listChatGPTModels()
      webDiscovery = web?.discovery || webDiscovery
      for (const item of web?.data || []) addModelCandidate(ids, 'chatgpt', item?.id)
    } catch (error) {
      errors.push(`ChatGPT web model discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (state.chatgpt.cachedHeaders?.model) addModelCandidate(ids, 'chatgpt', state.chatgpt.cachedHeaders.model)
  for (const id of ids) {
    if (isCodexModelId(id) || seen.has(id)) continue
    seen.add(id)
    items.push({ id, provider: 'chatgpt', api: 'chat_completions' })
  }

  return {
    data: items.length ? items : [{ id: 'chatgpt-web-session', provider: 'chatgpt', api: 'chat_completions' }],
    errors,
    discovery: webDiscovery,
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

async function readChatGPTConversation({ page, conversationId, responseHeaders, previousAssistantMessageId, prompt }) {
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

async function chatChatGPTWeb({ model, prompt, system_prompt, web_search = false, session_id = null }, emitStream = null) {
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

async function chatChatGPT({ model, prompt, system_prompt, web_search = false, session_id = null }, emitStream = null) {
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
      return await chatChatGPTWeb({ model: selectedModel, prompt, system_prompt, web_search, session_id }, emitStream)
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

async function enableThinkMode(page) {
  const button = page.getByRole('button', { name: /^Think$/i }).first()
  if (!await button.count() || !await button.isVisible().catch(() => false)) return false
  if ((await button.getAttribute('aria-pressed')) === 'true') return true
  await button.click()
  return (await button.getAttribute('aria-pressed').catch(() => null)) === 'true'
}

async function startNewChat(page) {
  // Homepage is ChatGPT's stable new-conversation entry point. Avoid relying
  // on version-specific sidebar labels whose old composer can stay visible.
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
  await page.locator(CHATGPT_INPUT_SELECTOR).first().waitFor({ state: 'visible', timeout: 30000 })
  return page
}

async function selectChatGPTPage() {
  return state.chatgpt.context.pages().find((candidate) => !candidate.isClosed() && isOnHost(candidate.url(), 'chatgpt.com'))
    || state.chatgpt.context.pages().find((candidate) => !candidate.isClosed())
    || await state.chatgpt.context.newPage()
}

async function prepareImagePage(page, image_path, web_search) {
  const fileInput = page.locator('input[type="file"]').first()
  if (await fileInput.count() === 0) throw new Error('ChatGPT image upload control not found')
  await fileInput.setInputFiles(image_path)
  await sleep(500)
  page = await selectChatGPTPage()
  if (!isOnHost(page.url(), 'chatgpt.com')) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
  }
  if (envBool('SCREEN_AGENT_CHATGPT_THINK', false)) await enableThinkMode(page)
  if (web_search) await enableWebSearch(page)
  return page
}

async function enableWebSearch(page) {
  const searchButton = page.getByRole('button', { name: /search( the web)?/i }).first()
  if (await searchButton.count() && await searchButton.isVisible().catch(() => false)) {
    await searchButton.click().catch(() => {})
  }
}

function imagePrompt(prompt, web_search) {
  const normalized = prompt.replace(/@WebSearch\b/gi, '@Web search')
  return web_search && !/@Web search\s*$/i.test(normalized.trim())
    ? `${normalized.trim()}\n\n@Web search`
    : normalized
}

async function sendImageAndReadAnswer(options) {
  const { page: initialPage, image_path, prompt, web_search } = options
  let page = await prepareImagePage(initialPage, image_path, web_search)

  const assistantMessages = page.locator('[data-message-author-role="assistant"]')
  const beforeCount = await assistantMessages.count()
  const composer = page.locator(CHATGPT_INPUT_SELECTOR).first()
  await composer.waitFor({ state: 'visible', timeout: 30000 })
  await composer.fill(imagePrompt(prompt, web_search))
  await submitChatGPTPrompt({ page, composer,
    selector: CHATGPT_SEND_SELECTOR,
    onSubmitted: method => bridgeDebug(`chatgpt prompt submitted via ${method}`),
  })

  // Wait for the assistant reply to finish streaming, then capture it whole.
  // A truly empty reply gets one fresh-chat retry after 10 seconds.
  const answerTimeout = Number(process.env.SCREEN_AGENT_ANSWER_TIMEOUT_MS || 180000)
  const emptyRetryTimeout = Number(process.env.SCREEN_AGENT_EMPTY_ANSWER_RETRY_TIMEOUT_MS || DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS)
  const stableMs = Number(process.env.SCREEN_AGENT_ANSWER_STABLE_MS || 2500)
  // Code streams in bursts with long pauses between them; a short stability
  // window mistakes a mid-block pause for completion and crops the code. Hold
  // out much longer whenever a code fence is present so it lands complete.
  const codeStableMs = Number(process.env.SCREEN_AGENT_ANSWER_CODE_STABLE_MS || 8000)
  const stopButton = page.locator('button[data-testid="stop-button"], button[aria-label="Stop streaming"]')
  const waited = await waitForAssistantAnswer({
    read: async () => {
      if (await assistantMessages.count() <= beforeCount) return { text: '', streaming: false }
      const text = await assistantMessages.last().innerText().catch(() => '')
      const streaming = await stopButton.count() && await stopButton.first().isVisible().catch(() => false)
      return { text, streaming }
    },
    answerTimeoutMs: answerTimeout,
    emptyRetryTimeoutMs: emptyRetryTimeout,
    stableMs,
    codeStableMs,
  })
  return { page, answer: waited.answer, retry: waited.retry }
}

async function chatChatGPTWithImage({ runtime_dir, browser, image_path, prompt, web_search = false, headless = true }) {
  await initChatGPT({ runtime_dir, headless, browser })
  let page = await ensureChatGPTInteractivePage({ runtime_dir, browser })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      bridgeDebug('chatgpt image response empty; starting a new chat and retrying image request')
      page = await startNewChat(page)
    }
    const result = await sendImageAndReadAnswer({ page, image_path, prompt, web_search })
    page = result.page
    if (result.answer) {
      return { text: result.answer, model: 'chatgpt-web-session', image: true, web_search }
    }
  }
  throw new Error('ChatGPT image response was empty after new-chat retry')
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

async function handle(method, provider, params, emitStream = null) {
  switch (`${provider}:${method}`) {
    case 'chatgpt:init':
      return initChatGPT(params)
    case 'chatgpt:capture_headers':
      return captureChatGPTTemplate(!!params.force_new)
    case 'chatgpt:basic_headers':
      return getChatGPTBasicHeaders()
    case 'chatgpt:manual_login':
      return openChatGPTLogin(params)
    case 'chatgpt:manual_login_wait':
      return openChatGPTLoginAndWait({ ...(params || {}), headless: false })
    case 'chatgpt:status':
      return chatGPTStatus(params)
    case 'chatgpt:chat_image':
      return chatChatGPTWithImage(params)
    case 'chatgpt:list_models':
      return listChatGPTHybridModels()
    case 'chatgpt:chat':
      return chatChatGPT(params, params?.stream ? emitStream : null)
    case 'chatgpt:shutdown':
      await closeAll()
      setImmediate(() => process.exit(0))
      return { ok: true }
    default:
      throw new Error(`Unsupported helper call: ${provider}:${method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  let newlineIndex = buffer.indexOf('\n')
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (line) {
      let requestId = null
      try {
        const request = JSON.parse(line)
        requestId = request?.id ?? null
        const result = await handle(
          request.method,
          request.provider,
          request.params || {},
          (event) => sendEvent(request.id, event.type || 'status', event),
        )
        send(request.id, result, null)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (requestId != null) {
          send(requestId, null, message)
        } else {
          process.stderr.write(`bridge request parse failed: ${message}\n`)
        }
      }
    }
    newlineIndex = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => {
  void shutdownAndExit(0)
})

process.on('SIGTERM', () => {
  void shutdownAndExit(0)
})

process.on('SIGINT', () => {
  void shutdownAndExit(0)
})
