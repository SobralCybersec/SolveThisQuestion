import { DEFAULT_ASSISTANT_ANSWER_POLL_INTERVAL_MS, DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS, submitChatGPTPrompt, waitForAssistantAnswer } from './chatgpt-web-flow.mjs'
import { bridgeDebug, envBool, gotoChatGPT, isOnHost } from './browser-runtime.mjs'
import {
  CHATGPT_INPUT_SELECTOR,
  CHATGPT_SEND_SELECTOR,
  initChatGPT,
  state,
} from './chatgpt-session-runtime.mjs'

async function enableThinkMode(page) {
  const button = page.getByRole('button', { name: /^Think$/i }).first()
  if (!await button.count() || !await button.isVisible().catch(() => false)) return false
  if ((await button.getAttribute('aria-pressed')) === 'true') return true
  await button.click()
  return (await button.getAttribute('aria-pressed').catch(() => null)) === 'true'
}

async function startNewChat(page) {
  await gotoChatGPT(page, { force: true })
  await page.locator(CHATGPT_INPUT_SELECTOR).first().waitFor({ state: 'visible', timeout: 30000 })
  return page
}

async function selectChatGPTPage() {
  return state.chatgpt.context.pages().find(candidate => !candidate.isClosed() && isOnHost(candidate.url(), 'chatgpt.com'))
    || state.chatgpt.context.pages().find(candidate => !candidate.isClosed())
    || await state.chatgpt.context.newPage()
}

async function enableWebSearch(page) {
  const searchButton = page.getByRole('button', { name: /search( the web)?/i }).first()
  if (await searchButton.count() && await searchButton.isVisible().catch(() => false)) {
    await searchButton.click().catch(() => {})
  }
}

async function prepareImagePage(page, imagePath, webSearch) {
  if (!page || page.isClosed() || !isOnHost(page.url(), 'chatgpt.com', 'openai.com')) page = await selectChatGPTPage()
  await gotoChatGPT(page)
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.waitFor({ state: 'attached', timeout: 2000 })
  await fileInput.setInputFiles(imagePath)
  if (envBool('SCREEN_AGENT_CHATGPT_THINK', false)) await enableThinkMode(page)
  if (webSearch) await enableWebSearch(page)
  return page
}

async function readAssistantMessageTexts(messages) {
  return messages.evaluateAll(nodes => nodes.map(node => String(node.innerText || node.textContent || '').trim())).catch(() => [])
}

export function selectNewAssistantText(texts, beforeCount, beforeTexts = []) {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = String(texts[index] || '').trim()
    if (!text) continue
    if (index >= beforeCount) return text
    if (text !== String(beforeTexts[index] || '').trim()) return text
  }
  return ''
}

function imagePrompt(prompt, webSearch) {
  const normalized = prompt.replace(/@WebSearch\b/gi, '@Web search')
  return webSearch && !/@Web search\s*$/i.test(normalized.trim())
    ? `${normalized.trim()}\n\n@Web search`
    : normalized
}

async function sendImageAndReadAnswer(options) {
  const { page: initialPage, image_path, prompt, web_search } = options
  const startedAt = Date.now()
  const mark = phase => bridgeDebug(`chatgpt image timing phase=${phase} elapsed_ms=${Date.now() - startedAt}`)
  let page = await prepareImagePage(initialPage, image_path, web_search)
  mark('page-ready')
  const assistantMessages = page.locator('[data-message-author-role="assistant"]:visible')
  const beforeTexts = await readAssistantMessageTexts(assistantMessages)
  const beforeCount = beforeTexts.length
  const composer = page.locator(CHATGPT_INPUT_SELECTOR).first()
  await composer.waitFor({ state: 'visible', timeout: 30000 })
  mark('composer-ready')
  await composer.fill(imagePrompt(prompt, web_search))
  mark('composer-filled')
  await submitChatGPTPrompt({
    page,
    composer,
    selector: CHATGPT_SEND_SELECTOR,
    buttonPollIntervalMs: DEFAULT_ASSISTANT_ANSWER_POLL_INTERVAL_MS,
    waitForClearAfterSubmit: false,
    onSubmitted: method => {
      bridgeDebug(`chatgpt prompt submitted via ${method}`)
      mark('prompt-submitted')
    },
  })
  const answerTimeout = Number(process.env.SCREEN_AGENT_ANSWER_TIMEOUT_MS || 180000)
  const emptyRetryTimeout = Number(process.env.SCREEN_AGENT_EMPTY_ANSWER_RETRY_TIMEOUT_MS || DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS)
  const stableMs = Number(process.env.SCREEN_AGENT_ANSWER_STABLE_MS || 250)
  const codeStableMs = Number(process.env.SCREEN_AGENT_ANSWER_CODE_STABLE_MS || 1000)
  const answerPollIntervalMs = Number(process.env.SCREEN_AGENT_ANSWER_POLL_INTERVAL_MS || DEFAULT_ASSISTANT_ANSWER_POLL_INTERVAL_MS)
  const stopButton = page.locator('button[data-testid="stop-button"], button[aria-label="Stop streaming"]')
  const waited = await waitForAssistantAnswer({
    read: async () => {
      const texts = await readAssistantMessageTexts(assistantMessages)
      const text = selectNewAssistantText(texts, beforeCount, beforeTexts)
      const streaming = await stopButton.first().isVisible().catch(() => false)
      bridgeDebug(`chatgpt image answer scan messages=${texts.length} baseline=${beforeCount} chars=${text.length} streaming=${streaming}`)
      return { text, streaming }
    },
    answerTimeoutMs: answerTimeout,
    emptyRetryTimeoutMs: emptyRetryTimeout,
    stableMs,
    codeStableMs,
    intervalMs: answerPollIntervalMs,
  })
  mark('answer-ready')
  return { page, answer: waited.answer, retry: waited.retry }
}

export async function chatChatGPTWithImage(options) {
  const { runtime_dir, browser, image_path, prompt, web_search = false, headless = true } = options
  const startedAt = Date.now()
  const mark = phase => bridgeDebug(`chatgpt image timing phase=${phase} elapsed_ms=${Date.now() - startedAt}`)
  await initChatGPT({ runtime_dir, headless, browser })
  mark('context-ready')
  let page = state.chatgpt.page
  if (!page) throw new Error('ChatGPT Playwright page not initialized')
  mark('page-selected')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      bridgeDebug('chatgpt image response empty; starting a new chat and retrying image request')
      page = await startNewChat(page)
    }
    const result = await sendImageAndReadAnswer({ page, image_path, prompt, web_search })
    page = result.page
    if (result.answer) return { text: result.answer, model: 'chatgpt-web-session', image: true, web_search }
  }
  throw new Error('ChatGPT image response was empty after new-chat retry')
}
