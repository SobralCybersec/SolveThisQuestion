import { sleep } from './browser-runtime.mjs'

const MODEL_KEY_RE = /["'](?:model|model_slug|slug|id|name)["']\s*:\s*["']([a-zA-Z0-9][\w.:-]{1,95})["']/g
const CHATGPT_MODEL_RE = /^(?:gpt|o[0-9]|chatgpt)[a-z0-9_.:-]*$/i
const GENERIC_MODEL_RE = /^[a-z0-9][a-z0-9_.:-]{1,80}$/i
const GENERIC_MODEL_SCAN_RE = /\b[a-z][a-z0-9_.:-]{1,80}\b/g
const DIRECT_MODEL_PATTERNS = {
  chatgpt: /\b(?:gpt|o[0-9]|chatgpt)[a-zA-Z0-9_.:-]{1,80}\b/g,
}

export function ensureSessionText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function modelPattern(provider) {
  return provider === 'chatgpt' ? CHATGPT_MODEL_RE : GENERIC_MODEL_RE
}

export function addModelCandidate(target, provider, value) {
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
      try { collectModelIds(JSON.parse(trimmed), provider, target, depth + 1) } catch {}
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
      if (/^(?:model|model_slug|slug|id|name)$/i.test(key)) addModelCandidate(target, provider, child)
      collectModelIds(child, provider, target, depth + 1)
    }
  }
}

export function modelListResponse(ids, provider, fallbackModel) {
  const data = [...ids].length ? [...ids] : [fallbackModel]
  return { data: data.map(id => ({ id, provider })) }
}

export const CHATGPT_WEB_MODEL_ENDPOINTS = [
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

export function isCodexModelId(id) {
  const lower = String(id || '').toLowerCase()
  return lower.includes('codex') || lower.includes('cyber')
}

export function addKnownChatGPTModels(target) {
  for (const id of CHATGPT_WEB_MODEL_IDS) addModelCandidate(target, 'chatgpt', id)
}

async function scanPageModelHints(page, provider, endpointPaths = []) {
  const bodies = await page.evaluate(async ({ endpointPaths: paths }) => {
    const out = []
    const add = value => {
      if (typeof value === 'string' && value.trim()) out.push(value.slice(0, 500000))
    }
    for (const endpoint of paths) {
      try {
        const response = await fetch(endpoint, { credentials: 'include' })
        if (response.ok) add(await response.text())
      } catch {}
    }
    try { add(JSON.stringify(window.__NEXT_DATA__ || window.__NUXT__ || {})) } catch {}
    for (const script of Array.from(document.scripts).slice(0, 80)) {
      const text = script.textContent || ''
      if (/model|gemini|gpt|mistral|codestral|magistral|glm|autoglm|zai|meta|llama/i.test(text)) add(text)
    }
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) || ''
          const value = storage.getItem(key) || ''
          if (/model|gemini|gpt|mistral|codestral|magistral|glm|autoglm|zai|meta|llama/i.test(`${key} ${value}`)) add(`${key} ${value}`)
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

export async function waitForInteractiveSelector(page, selectors, timeout = 30000) {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout })
      return selector
    } catch {}
  }
  throw new Error(`Timeout waiting for interactive selector: ${selectors.join(', ')}`)
}

export async function scanPageModelHintsWithRetries(page, provider, endpointPaths = [], attempts = 3) {
  let ids = new Set()
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    ids = await scanPageModelHints(page, provider, endpointPaths)
    if (ids.size > 0) return ids
    await sleep(1200)
  }
  return ids
}
