import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractChatGPTAssistantModel, extractChatGPTAssistantReasoning, extractChatGPTAssistantText } from './chatgpt-web-response.mjs'
import { applyChatGPTConversationSession, chatGPTSessionFromTemplate, chatGPTSessionKey, latestChatGPTAssistantMessageId, loadChatGPTWebSessions, saveChatGPTWebSessions } from './chatgpt-web-session.mjs'
import { compactStructuredPrompt, summarizePromptCompaction } from './prompt-compaction.mjs'

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

function removeStaleChromiumProfileLock(profileDir) {
  const lockPath = path.join(profileDir, 'SingletonLock')
  let target
  try {
    target = fs.readlinkSync(lockPath)
  } catch {
    return false
  }
  const pid = Number(String(target).match(/-(\d+)$/)?.[1])
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error?.code !== 'ESRCH') return false
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(profileDir, name))
    } catch (error) {
      if (error?.code !== 'ENOENT') return false
    }
  }
  return true
}

function chromiumProcessesUsingProfile(profileDir) {
  if (process.platform === 'win32') return []
  let output
  try {
    output = execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024,
    })
  } catch {
    return []
  }
  const expected = path.resolve(profileDir)
  const pids = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    const userData = match[2].match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/)
    if (!userData) continue
    if (path.resolve(userData[1] || userData[2] || userData[3]) === expected) pids.push(pid)
  }
  return pids
}

async function closeChromiumProfileInstances(profileDir) {
  let pids = chromiumProcessesUsingProfile(profileDir)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  const deadline = Date.now() + 2500
  while (pids.length && Date.now() < deadline) {
    await sleep(100)
    pids = chromiumProcessesUsingProfile(profileDir)
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  return pids.length === 0
}

function isProfileSingletonError(error) {
  return /ProcessSingleton|SingletonLock/i.test(error instanceof Error ? error.message : String(error))
}

// Defense-in-depth: account_id is joined to a filesystem profile path.
// Reject anything outside [A-Za-z0-9_-]{1,64} before path.resolve sees it.
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/
function assertSafeAccountId(accountId) {
  if (accountId != null && accountId !== '' && !SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error(`unsafe account_id rejected: ${accountId}`)
  }
}

// Known install locations per Chromium-family browser, across platforms. Used
// to fall back to an installed browser when the requested channel's own
// distribution is missing (e.g. 'msedge' requested on a Linux box that only has
// Chromium) instead of hard-failing the launch.
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

function chromiumMajorVersion({ executablePath, channel, engine } = {}) {
  const configured = String(process.env.RUST_PROXY_CHROMIUM_MAJOR || '').match(/^\d+$/)?.[0]
  if (configured) return configured

  const commands = [
    executablePath,
    channel === 'chrome' ? 'google-chrome' : null,
    channel === 'msedge' ? 'microsoft-edge' : null,
    channel === 'chromium' ? 'chromium' : null,
    'chromium',
    'google-chrome',
    'microsoft-edge',
    typeof engine?.executablePath === 'function' ? engine.executablePath() : null,
  ].filter(Boolean)
  for (const command of commands) {
    try {
      const output = execFileSync(command, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      })
      const major = output.match(/(?:Chrome|Chromium|HeadlessChrome|Edge)[/\s](\d+)/i)?.[1]
      if (major) return major
    } catch {}
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

function ensureSessionText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function modelPattern(provider) {
  return provider === 'chatgpt'
    ? /^(?:gpt|o[0-9]|chatgpt)[a-z0-9_.:-]*$/i
    : /^[a-z0-9][a-z0-9_.:-]{1,80}$/i
}

function addModelCandidate(target, provider, value) {
  if (typeof value !== 'string') return
  const clean = value.trim().replace(/^model:/i, '').replace(/^models\//i, '')
  if (!clean || clean.length > 96 || /\s/.test(clean)) return
  if (modelPattern(provider).test(clean)) target.add(clean)
}

function collectModelIds(value, provider, target, depth = 0) {
  if (depth > 8 || value == null) return

  if (typeof value === 'string') {
    addModelCandidate(target, provider, value)
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 500000) {
      try {
        collectModelIds(JSON.parse(trimmed), provider, target, depth + 1)
      } catch {}
    }

    const modelKeyRe = /["'](?:model|model_slug|slug|id|name)["']\s*:\s*["']([a-zA-Z0-9][\w.:-]{1,95})["']/g
    for (const match of trimmed.matchAll(modelKeyRe)) addModelCandidate(target, provider, match[1])

    const directPatterns = {
      chatgpt: /\b(?:gpt|o[0-9]|chatgpt)[a-zA-Z0-9_.:-]{1,80}\b/g,
    }
    for (const match of trimmed.matchAll(directPatterns[provider] || /\b[a-z][a-z0-9_.:-]{1,80}\b/g)) {
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

async function chatGPTComposerText(composer) {
  return (await composer.inputValue().catch(async () => composer.innerText().catch(() => ''))).trim()
}

async function submitChatGPTPrompt(page, composer) {
  // Prefer the send button, but only once it's actually enabled. With an image
  // attachment ChatGPT keeps send disabled until the upload finishes, and a
  // premature Enter just inserts a newline in the ProseMirror composer instead
  // of sending — so wait for the button rather than firing Enter first.
  // Headless uploads can be slow; give it a full minute.
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const sendButton = page.locator(CHATGPT_SEND_SELECTOR).last()
    const ready = await sendButton.count()
      && await sendButton.isVisible().catch(() => false)
      && !await sendButton.isDisabled().catch(() => true)
    if (ready) {
      await sendButton.click({ force: true }).catch(() => {})
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!await chatGPTComposerText(composer)) {
          bridgeDebug('chatgpt prompt submitted via send button')
          return
        }
        await sleep(250)
      }
    }
    await sleep(300)
  }

  // Last resort once the upload window has passed: keyboard submit.
  await composer.press('Enter').catch(() => {})
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!await chatGPTComposerText(composer)) {
      bridgeDebug('chatgpt prompt submitted via keyboard')
      return
    }
    await sleep(200)
  }
  throw new Error('ChatGPT composer did not submit prompt')
}

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
      let payloadModel = 'chatgpt-web-session'

      try {
        payloadModel = JSON.parse(postData).model || payloadModel
      } catch {}

      const headers = {
        authorization: reqHeaders.authorization || '',
        accept: reqHeaders.accept || 'text/event-stream',
        'accept-language': reqHeaders['accept-language'] || 'en-US,en;q=0.9',
        'content-type': reqHeaders['content-type'] || 'application/json',
        origin: reqHeaders.origin || 'https://chatgpt.com',
        referer: reqHeaders.referer || 'https://chatgpt.com/',
        'user-agent': reqHeaders['user-agent'] || '',
        'oai-client-build-number': reqHeaders['oai-client-build-number'] || '',
        'oai-client-version': reqHeaders['oai-client-version'] || '',
        'oai-device-id': reqHeaders['oai-device-id'] || '',
        'oai-language': reqHeaders['oai-language'] || 'en-US',
        'oai-session-id': reqHeaders['oai-session-id'] || '',
        'openai-sentinel-chat-requirements-token': reqHeaders['openai-sentinel-chat-requirements-token'] || '',
        'openai-sentinel-proof-token': reqHeaders['openai-sentinel-proof-token'] || '',
        'openai-sentinel-turnstile-token': reqHeaders['openai-sentinel-turnstile-token'] || '',
        'x-conduit-token': reqHeaders['x-conduit-token'] || '',
        'x-oai-turn-trace-id': reqHeaders['x-oai-turn-trace-id'] || '',
        'x-openai-target-path': reqHeaders['x-openai-target-path'] || '/backend-api/f/conversation',
        'x-openai-target-route': reqHeaders['x-openai-target-route'] || '/backend-api/f/conversation',
      }

      if (!headers.authorization) {
        await route.continue()
        return
      }

      state.chatgpt.cachedHeaders = {
        headers,
        payload: postData,
        model: payloadModel,
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

function buildChatGPTPayloadFromTemplate(template, prompt, model, webSearch, systemPrompt, session = null) {
  let payload = null
  try {
    payload = template?.payload ? JSON.parse(template.payload) : null
  } catch {}

  if (!payload || typeof payload !== 'object') {
    return buildChatGPTPayload(prompt, model, webSearch, systemPrompt)
  }

  const nextPayload = cloneJson(payload)
  const messages = Array.isArray(nextPayload.messages) ? nextPayload.messages : []
  const templateMessage = messages.find((message) => message?.author?.role === 'user') || messages[0] || {}
  const templateMetadata =
    templateMessage?.metadata && typeof templateMessage.metadata === 'object'
      ? templateMessage.metadata
      : {}

  nextPayload.model = model
  delete nextPayload.conversation_id
  delete nextPayload.conversationId
  delete nextPayload.current_node
  delete nextPayload.currentNode
  delete nextPayload.parent_id
  delete nextPayload.parentId
  delete nextPayload.response_id
  delete nextPayload.responseId
  delete nextPayload.suggestions
  delete nextPayload.history_and_training_disabled

  const builtMessages = []
  builtMessages.push({
    ...templateMessage,
    id: randomUUID(),
    create_time: Date.now() / 1000,
    author: { ...(templateMessage.author || {}), role: 'user' },
    content: replaceChatGPTMessageContent(
      templateMessage.content,
      foldChatGPTSystemPrompt(systemPrompt, prompt),
    ),
    metadata: {
      ...templateMetadata,
      selected_sources: webSearch ? ['web'] : [],
    },
  })
  nextPayload.messages = builtMessages

  applyChatGPTConversationSession(nextPayload, session)
  if (!nextPayload.action || typeof nextPayload.action !== 'string') {
    nextPayload.action = 'next'
  }
  if (webSearch) nextPayload.force_use_tool = 'web'

  return nextPayload
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

async function chatChatGPTWeb({ model, prompt, system_prompt, web_search = false, session_id = null }, emitStream = null) {
  await ensureLiveChatGPTSession()
  const page = state.chatgpt.page
  if (!page) throw new Error('ChatGPT Playwright not initialized')

  let template = await captureChatGPTTemplate(false)
  const sessionKey = chatGPTSessionKey(session_id)
  let session = state.chatgpt.webSessions.get(sessionKey) || chatGPTSessionFromTemplate(template)
  if (session) state.chatgpt.webSessions.set(sessionKey, session)

  const sendConversation = async (preparedPrompt) => {
    const requestHeaders = { ...template.headers }
    delete requestHeaders.cookie
    const payload = buildChatGPTPayloadFromTemplate(
      template,
      preparedPrompt.text,
      ensureSessionText(model, template.model || 'chatgpt-web-session'),
      web_search,
      system_prompt || null,
      session,
    )
    const requestResult = await page.evaluate(async ({ headers, payload, submittedPrompt, stream }) => {
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
      let conversationId = ''
      const streamRoles = []
      const streamContentTypes = []
      const streamKeys = []
      const streamMessageShapes = []

      const collectText = (value, output = [], acceptsText = false, depth = 0) => {
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
          for (const [key, child] of Object.entries(value)) {
            collectText(child, output, ['content', 'output_text', 'parts', 'text'].includes(key), depth + 1)
          }
        }
        return output
      }
      const assistantText = (payload) => {
        const mapping = payload?.mapping && typeof payload.mapping === 'object' ? Object.values(payload.mapping) : []
        const messages = [
          ...(payload?.message?.author?.role === 'assistant' ? [payload.message] : []),
          ...mapping.map(entry => entry?.message),
        ]
          .filter((message, index, all) => message?.author?.role === 'assistant' && all.indexOf(message) === index)
          .sort((left, right) => (left?.create_time || 0) - (right?.create_time || 0))
        const message = messages.at(-1)
        const promptText = String(submittedPrompt || '').replace(/\s+/g, ' ').trim()
        return collectText(message?.content)
          .join('\n')
          .split(/\r?\n/)
          .map(line => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .filter(line => !/^worked for\b/i.test(line) && !/^modified \d+ files?\b/i.test(line))
          .filter(line => !promptText || line !== promptText)
          .join('\n')
          .trim()
      }
      const assistantModel = (payload) => {
        const mapping = payload?.mapping && typeof payload.mapping === 'object' ? Object.values(payload.mapping) : []
        const messages = [
          ...(payload?.message?.author?.role === 'assistant' ? [payload.message] : []),
          ...mapping.map(entry => entry?.message),
        ]
          .filter(message => message?.author?.role === 'assistant')
          .sort((left, right) => (left?.create_time || 0) - (right?.create_time || 0))
        const message = messages.at(-1)
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
      const assistantReasoning = (payload, output = [], acceptsText = false, depth = 0) => {
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
      const emitDelta = async (payload) => {
        const current = assistantText(payload)
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

      if (reader) {
        try {
          while (true) {
            let chunk
            try {
              chunk = await reader.read()
            } catch (error) {
              if (conversationId) break
              throw error
            }
            const { done, value } = chunk
            if (done) break
            const decoded = decoder.decode(value, { stream: true })
            raw = `${raw}${decoded}`.slice(-16_384)
            lineBuffer += decoded
            const lines = lineBuffer.split('\n')
            lineBuffer = lines.pop() || ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const chunk = trimmed.slice(5).trim()
              if (!chunk || chunk === '[DONE]') continue
              try {
                const parsed = JSON.parse(chunk)
                for (const key of Object.keys(parsed || {})) {
                  if (!streamKeys.includes(key)) streamKeys.push(key)
                }
                const role = parsed?.message?.author?.role
                const contentType = parsed?.message?.content?.content_type
                const messageShape = parsed?.message && typeof parsed.message === 'object'
                  ? Object.keys(parsed.message).slice(0, 12).join(',')
                  : typeof parsed?.message
                if (messageShape && !streamMessageShapes.includes(messageShape)) streamMessageShapes.push(messageShape)
                if (role && !streamRoles.includes(role)) streamRoles.push(role)
                if (contentType && !streamContentTypes.includes(contentType)) streamContentTypes.push(contentType)
                conversationId =
                  parsed.conversation_id ||
                  parsed.token?.conversation_id ||
                  parsed.options?.[0]?.conversation_id ||
                  conversationId
                streamedModel = assistantModel(parsed) || streamedModel
                await emitReasoning(parsed)
                await emitDelta(parsed)
              } catch {}
            }
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
      }

      clearTimeout(timer)
      const upstreamCache = {}
      for (const name of ['cache-control', 'age', 'cf-cache-status']) {
        const value = response.headers.get(name)
        if (value) upstreamCache[name] = value
      }
      return {
        ok: response.ok,
        status: response.status,
        conversationId,
        body: raw,
        streamModel: streamedModel,
        streamReasoning: streamedReasoning,
        streamText: streamedText,
        streamShape: { keys: streamKeys, roles: streamRoles, content_types: streamContentTypes, messages: streamMessageShapes },
        upstream_cache: Object.keys(upstreamCache).length ? upstreamCache : null,
      }
    }, { headers: requestHeaders, payload, submittedPrompt: preparedPrompt.text, stream: Boolean(emitStream) })
    if (process.env.RUST_PROXY_DUMP_CHATGPT_SSE === '1' && requestResult.body) {
      fs.writeFileSync('/tmp/solvethisquestion-login-fix/chatgpt-sse-debug.txt', requestResult.body)
    }
    bridgeDebug(`chatgpt conversation submit status=${requestResult.status} conversation=${Boolean(requestResult.conversationId)} bytes=${requestResult.body?.length || 0} sse=${requestResult.body?.includes('data:') || false} stream=${Boolean(requestResult.streamText)} shape=${JSON.stringify(requestResult.streamShape || {})}`)
    return { payload, requestResult, preparedPrompt }
  }

  const normalizedPrompt = prompt.replace(/@WebSearch\b/gi, '@Web search')
  const preparedUserPrompt = web_search && !/@Web search\s*$/i.test(normalizedPrompt.trim())
    ? `${normalizedPrompt.trim()}\n\n@Web search`
    : normalizedPrompt
  let sent = await sendConversation(compactChatGPTPrompt(preparedUserPrompt, 18000))
  if (!sent.requestResult.ok && [401, 403].includes(sent.requestResult.status)) {
    template = await captureChatGPTTemplate(true)
    session = state.chatgpt.webSessions.get(sessionKey) || chatGPTSessionFromTemplate(template)
    if (session) state.chatgpt.webSessions.set(sessionKey, session)
    sent = await sendConversation(compactChatGPTPrompt(preparedUserPrompt, 18000))
  }
  if (!sent.requestResult.ok && sent.requestResult.status === 413) {
    sent = await sendConversation(compactChatGPTPrompt(preparedUserPrompt, 9000))
  }

  const conversationId = sent.requestResult.conversationId || sent.payload.conversation_id || ''
  if (!sent.requestResult.ok || !conversationId) {
    const detail = sent.requestResult.body?.trim()
    throw new Error(
      detail
        ? `ChatGPT upstream request failed with status ${sent.requestResult.status}: ${detail.slice(0, 400)}`
        : `ChatGPT upstream request failed with status ${sent.requestResult.status}`,
    )
  }

  let responseHeaders = { ...template.headers }
  delete responseHeaders.cookie
  const readConversation = async () => {
    let lastStatus = 0
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await page.context().request.get(
        `https://chatgpt.com/backend-api/conversation/${conversationId}`,
        { headers: responseHeaders, timeout: 10000 },
      ).catch(() => null)
      const status = response?.status() || 0
      if (attempt === 0 || [401, 403].includes(status)) {
        bridgeDebug(`chatgpt conversation poll status=${status} attempt=${attempt + 1}`)
      }
      if (response?.ok()) {
        const text = await response.text()
        if (text && text !== 'null') return { body: text, status }
      }
      lastStatus = status
      if ([401, 403].includes(status)) return { body: '', status }
      await sleep(1000)
    }
    return { body: '', status: lastStatus }
  }

  let conversation = await readConversation()
  bridgeDebug(`chatgpt conversation read status=${conversation.status} bytes=${conversation.body?.length || 0}`)
  if ([401, 403].includes(conversation.status)) {
    template = await captureChatGPTTemplate(true)
    responseHeaders = { ...template.headers }
    delete responseHeaders.cookie
    conversation = await readConversation()
    bridgeDebug(`chatgpt conversation reread status=${conversation.status} bytes=${conversation.body?.length || 0}`)
  }
  if ([401, 403].includes(conversation.status)) {
    throw new Error(`ChatGPT web conversation read unauthorized (HTTP ${conversation.status})`)
  }

  let conversationPayload = null
  try {
    conversationPayload = conversation.body ? JSON.parse(conversation.body) : null
  } catch {}
  const conversationEntries = conversationPayload?.mapping && typeof conversationPayload.mapping === 'object'
    ? Object.values(conversationPayload.mapping)
    : []
  bridgeDebug(`chatgpt conversation shape keys=${Object.keys(conversationPayload || {}).slice(0, 12).join(',')} roles=${conversationEntries.map(entry => entry?.message?.author?.role).filter(Boolean).join(',') || 'none'}`)
  if (sessionKey) {
    const parentMessageId = latestChatGPTAssistantMessageId(conversationPayload)
    if (parentMessageId) {
      state.chatgpt.webSessions.set(sessionKey, {
        conversation_id: conversationId,
        parent_message_id: parentMessageId,
        updated_at: Date.now(),
      })
      persistChatGPTWebSessions()
    } else {
      state.chatgpt.webSessions.delete(sessionKey)
      persistChatGPTWebSessions()
    }
  }
  const text = extractChatGPTAssistantText(conversationPayload, sent.preparedPrompt.text)
    || sent.requestResult.streamText
  const reasoningContent = extractChatGPTAssistantReasoning(conversationPayload)
    || sent.requestResult.streamReasoning
  if (!text) {
    throw new Error('ChatGPT response was empty. Confirm session is active, then retry.')
  }

  return {
    text,
    model: extractChatGPTAssistantModel(conversationPayload)
      || sent.requestResult.streamModel
      || sent.payload.model,
    reasoning_content: reasoningContent || null,
    conversation_id: conversationId,
    upstream_cache: sent.requestResult.upstream_cache,
    warning: summarizePromptCompaction(sent.preparedPrompt),
  }
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

async function sendImageAndReadAnswer(page, { image_path, prompt, web_search }) {
  const fileInput = page.locator('input[type="file"]').first()
  if (await fileInput.count() === 0) throw new Error('ChatGPT image upload control not found')
  await fileInput.setInputFiles(image_path)
  await sleep(500)
  page = state.chatgpt.context.pages().find((candidate) => !candidate.isClosed() && isOnHost(candidate.url(), 'chatgpt.com'))
    || state.chatgpt.context.pages().find((candidate) => !candidate.isClosed())
    || await state.chatgpt.context.newPage()
  if (!isOnHost(page.url(), 'chatgpt.com')) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
  }

  // Think (reasoning) mode roughly triples latency; keep it off unless asked.
  if (envBool('SCREEN_AGENT_CHATGPT_THINK', false)) await enableThinkMode(page)

  if (web_search) {
    const searchButton = page.getByRole('button', { name: /search( the web)?/i }).first()
    if (await searchButton.count() && await searchButton.isVisible().catch(() => false)) {
      await searchButton.click().catch(() => {})
    }
  }

  const assistantMessages = page.locator('[data-message-author-role="assistant"]')
  const beforeCount = await assistantMessages.count()
  const composer = page.locator(CHATGPT_INPUT_SELECTOR).first()
  await composer.waitFor({ state: 'visible', timeout: 30000 })
  const normalizedPrompt = prompt.replace(/@WebSearch\b/gi, '@Web search')
  const message = web_search && !/@Web search\s*$/i.test(normalizedPrompt.trim())
    ? `${normalizedPrompt.trim()}\n\n@Web search`
    : normalizedPrompt
  await composer.fill(message)
  await submitChatGPTPrompt(page, composer)

  // Wait for the assistant reply to finish streaming, then capture it whole.
  // All timings env-configurable (ms): total cap, and how long the text must
  // hold steady before we treat it as done.
  const answerTimeout = Number(process.env.SCREEN_AGENT_ANSWER_TIMEOUT_MS || 180000)
  const stableMs = Number(process.env.SCREEN_AGENT_ANSWER_STABLE_MS || 2500)
  // Code streams in bursts with long pauses between them; a short stability
  // window mistakes a mid-block pause for completion and crops the code. Hold
  // out much longer whenever a code fence is present so it lands complete.
  const codeStableMs = Number(process.env.SCREEN_AGENT_ANSWER_CODE_STABLE_MS || 8000)
  const stopButton = page.locator('button[data-testid="stop-button"], button[aria-label="Stop streaming"]')
  const deadline = Date.now() + answerTimeout
  let answer = ''
  let lastText = ''
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    if (await assistantMessages.count() > beforeCount) {
      const text = (await assistantMessages.last().innerText().catch(() => '')).trim()
      if (text !== lastText) {
        lastText = text
        lastChange = Date.now()
      } else if (text) {
        // Not done until ChatGPT drops its stop button (streaming ended) AND the
        // text has held steady — a wider window when a code block is present.
        const streaming = await stopButton.count() && await stopButton.first().isVisible().catch(() => false)
        const window = text.includes('```') ? codeStableMs : stableMs
        if (!streaming && Date.now() - lastChange >= window) {
          answer = text
          break
        }
      }
    }
    await sleep(500)
  }
  if (!answer) answer = lastText
  return { page, answer }
}

async function chatChatGPTWithImage({ runtime_dir, browser, image_path, prompt, web_search = false, headless = true }) {
  await initChatGPT({ runtime_dir, headless, browser })
  let page = await ensureChatGPTInteractivePage({ runtime_dir, browser })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      bridgeDebug('chatgpt image response empty; starting a new chat and retrying image request')
      page = await startNewChat(page)
    }
    const result = await sendImageAndReadAnswer(page, { image_path, prompt, web_search })
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
