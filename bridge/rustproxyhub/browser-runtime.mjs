import { execFileSync } from 'node:child_process'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

dns.setDefaultResultOrder('ipv4first')

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

export { applyStealthScripts, bridgeDebug, chromium, ensureDir, envBool, firefox, isOnHost, resolveEngine, send, sendEvent, sleep, stealthArgs, webkit }
