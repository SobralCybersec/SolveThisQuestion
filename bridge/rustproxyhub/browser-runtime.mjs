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

const CHATGPT_URL = 'https://chatgpt.com/'

// chatgpt.com sits behind Cloudflare. Two rules keep its interstitial from
// eating a navigation: never re-navigate a page already on a ChatGPT or OpenAI
// auth host - that yanks a half-finished sign-in back to the root and earns a
// fresh challenge - and wait for 'commit' instead of 'domcontentloaded', which
// a challenge page never reaches in time. Callers still decide the page is
// usable by waiting for the composer.
async function gotoChatGPT(page, { force = false, timeout = 60000 } = {}) {
  if (!force && isOnHost(page.url(), 'chatgpt.com', 'openai.com')) return page
  await page.goto(CHATGPT_URL, { waitUntil: 'commit', timeout })
  return page
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
async function importBrowserPackage(name) {
  const candidateUrls = [
    new URL(`./node_modules/${name}/index.mjs`, import.meta.url),
    new URL(`../node_modules/${name}/index.mjs`, import.meta.url),
    new URL(`../../node_modules/${name}/index.mjs`, import.meta.url),
    new URL(`../../../node_modules/${name}/index.mjs`, import.meta.url),
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

    const packageDir = fs
      .readdirSync(root, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith(`${name}@`))

    if (!packageDir) {
      continue
    }

    const candidate = path.join(root, packageDir.name, 'node_modules', name, 'index.mjs')
    if (fs.existsSync(candidate)) {
      return import(pathToFileURL(candidate).href)
    }
  }

  return import(name)
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
  try {
    return await importBrowserPackage(backend)
  } catch (error) {
    throw new Error(
      `${backend} backend selected but package is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const playwright = await importBrowserAutomation()
const { chromium, firefox, webkit } = playwright

export const BASE_STEALTH_ARGS = [
  '--no-sandbox',
  '--disable-features=DevToolsDebuggingRestrictions,CalculateNativeWinOcclusion',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  '--disable-dev-shm-usage',
  '--class=HireMeOpsBot',
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

export const HEADLESS_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

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

function preferredChromiumLaunch(preferredChannel) {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  if (override && fs.existsSync(override)) return { engine: chromium, executablePath: override }
  if (preferredChannel && firstExisting(BROWSER_PATHS[preferredChannel] ?? [])) {
    return { engine: chromium, channel: preferredChannel }
  }
  if (!preferredChannel && firstExisting(BROWSER_PATHS.chrome)) {
    return { engine: chromium, channel: 'chrome' }
  }
  return null
}

function fallbackChromiumLaunch(preferredChannel) {
  const order = preferredChannel
    ? [preferredChannel, 'msedge', 'chrome', 'chromium']
    : ['chrome', 'chromium', 'msedge']
  const executablePath = order.map(browserExecutablePath).find(Boolean)
  return executablePath ? { engine: chromium, executablePath } : { engine: chromium }
}

// Resolve a Chromium launch config. If the requested channel's real
// distribution is installed, drive it via `channel` (Playwright applies the
// right profile flags). Otherwise point `executablePath` at whatever
// Chromium-family browser IS installed — preferring the requested family, then
// Edge → Chrome → Chromium. Last resort is Playwright's bundled chromium.
function resolveChromium(preferredChannel) {
  return preferredChromiumLaunch(preferredChannel) || fallbackChromiumLaunch(preferredChannel)
}

function baseLaunchOptions(options = {}) {
  const { headless = true, executablePath, channel = 'chrome', engine = chromium, extraArgs = [] } = options
  const chromiumLaunch = engine === chromium
  const uaArgs = chromiumLaunch && headless
    ? [`--user-agent=${HEADLESS_UA}`, '--window-size=1920,1080']
    : []
  return {
    headless,
    viewport: null,
    args: [...BASE_STEALTH_ARGS, ...uaArgs, ...extraArgs],
    ignoreDefaultArgs: ['--enable-automation'],
    ...(executablePath ? { executablePath } : {}),
    ...(chromiumLaunch && !executablePath && channel ? { channel } : {}),
  }
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

const MODEL_KEY_RE = /["'](?:model|model_slug|slug|id|name)["']\s*:\s*["']([a-zA-Z0-9][\w.:-]{1,95})["']/g
const CHATGPT_MODEL_RE = /^(?:gpt|o[0-9]|chatgpt)[a-z0-9_.:-]*$/i
const GENERIC_MODEL_RE = /^[a-z0-9][a-z0-9_.:-]{1,80}$/i
const GENERIC_MODEL_SCAN_RE = /\b[a-z][a-z0-9_.:-]{1,80}\b/g
const DIRECT_MODEL_PATTERNS = {
  chatgpt: /\b(?:gpt|o[0-9]|chatgpt)[a-zA-Z0-9_.:-]{1,80}\b/g,
}

export { CHATGPT_URL, applyStealthScripts, baseLaunchOptions, bridgeDebug, chromium, ensureDir, envBool, firefox, gotoChatGPT, isOnHost, resolveEngine, send, sendEvent, sleep, webkit }
