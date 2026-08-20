import { DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS, submitChatGPTPrompt, waitForAssistantAnswer } from './chatgpt-web-flow.mjs'
import { bridgeDebug, envBool, isOnHost, sleep } from './browser-runtime.mjs'
import {
  CHATGPT_INPUT_SELECTOR,
  CHATGPT_SEND_SELECTOR,
  ensureChatGPTInteractivePage,
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
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
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
  const fileInput = page.locator('input[type="file"]').first()
  if (await fileInput.count() === 0) throw new Error('ChatGPT image upload control not found')
  await fileInput.setInputFiles(imagePath)
  await sleep(500)
  page = await selectChatGPTPage()
  if (!isOnHost(page.url(), 'chatgpt.com')) await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
  if (envBool('SCREEN_AGENT_CHATGPT_THINK', false)) await enableThinkMode(page)
  if (webSearch) await enableWebSearch(page)
  return page
}

async function readAssistantMessageText(message) {
  const innerText = await message.innerText().catch(() => '')
  if (innerText.trim()) return innerText.trim()
  return String(await message.textContent().catch(() => '')).trim()
}

async function readAssistantMessageTexts(messages) {
  const count = await messages.count()
  const texts = []
  for (let index = 0; index < count; index += 1) {
    texts.push(await readAssistantMessageText(messages.nth(index)))
  }
  return texts
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
  let page = await prepareImagePage(initialPage, image_path, web_search)
  const assistantMessages = page.locator('[data-message-author-role="assistant"]:visible')
  const beforeTexts = await readAssistantMessageTexts(assistantMessages)
  const beforeCount = beforeTexts.length
  const composer = page.locator(CHATGPT_INPUT_SELECTOR).first()
  await composer.waitFor({ state: 'visible', timeout: 30000 })
  await composer.fill(imagePrompt(prompt, web_search))
  await submitChatGPTPrompt({
    page,
    composer,
    selector: CHATGPT_SEND_SELECTOR,
    onSubmitted: method => bridgeDebug(`chatgpt prompt submitted via ${method}`),
  })
  const answerTimeout = Number(process.env.SCREEN_AGENT_ANSWER_TIMEOUT_MS || 180000)
  const emptyRetryTimeout = Number(process.env.SCREEN_AGENT_EMPTY_ANSWER_RETRY_TIMEOUT_MS || DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS)
  const stableMs = Number(process.env.SCREEN_AGENT_ANSWER_STABLE_MS || 2500)
  const codeStableMs = Number(process.env.SCREEN_AGENT_ANSWER_CODE_STABLE_MS || 8000)
  const stopButton = page.locator('button[data-testid="stop-button"], button[aria-label="Stop streaming"]')
  const waited = await waitForAssistantAnswer({
    read: async () => {
      const texts = await readAssistantMessageTexts(assistantMessages)
      const text = selectNewAssistantText(texts, beforeCount, beforeTexts)
      const streaming = await stopButton.count() && await stopButton.first().isVisible().catch(() => false)
      bridgeDebug(`chatgpt image answer scan messages=${texts.length} baseline=${beforeCount} chars=${text.length} streaming=${Boolean(streaming)}`)
      return { text, streaming }
    },
    answerTimeoutMs: answerTimeout,
    emptyRetryTimeoutMs: emptyRetryTimeout,
    stableMs,
    codeStableMs,
  })
  return { page, answer: waited.answer, retry: waited.retry }
}

export async function chatChatGPTWithImage(options) {
  const { runtime_dir, browser, image_path, prompt, web_search = false, headless = true } = options
  await initChatGPT({ runtime_dir, headless, browser })
  let page = await ensureChatGPTInteractivePage({ runtime_dir, browser })
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
