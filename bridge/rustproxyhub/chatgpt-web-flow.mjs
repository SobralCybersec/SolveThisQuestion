const DEFAULT_PROMPT_DEADLINE_MS = 60_000
const DEFAULT_BUTTON_SUBMIT_TIMEOUT_MS = 5_000
const DEFAULT_SEND_CHECK_INTERVAL_MS = 100
const DEFAULT_BUTTON_POLL_INTERVAL_MS = 150
export const DEFAULT_RESPONSE_POLL_ATTEMPTS = 40
export const DEFAULT_RESPONSE_POLL_INTERVAL_MS = 250
export const DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS = 10_000

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

export async function composerText(composer) {
  return (await composer.inputValue().catch(async () => composer.innerText().catch(() => ''))).trim()
}

async function submitButtonReady(button) {
  if (!await button.count()) return false
  if (!await button.isVisible().catch(() => false)) return false
  const ariaDisabled = typeof button.getAttribute === 'function'
    ? await button.getAttribute('aria-disabled').catch(() => null)
    : null
  if (ariaDisabled === 'true') return false
  return !await button.isDisabled().catch(() => true)
}

async function waitForComposerClear(options) {
  const { composer, readText, sleep, intervalMs, attempts, method, onSubmitted } = options
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!await readText(composer)) {
      onSubmitted(method)
      return method
    }
    await sleep(intervalMs)
  }
  return null
}

async function tryButtonSubmit(options) {
  const { page, composer, selector, readText, sleep, intervalMs, onSubmitted } = options
  const sendButton = page.locator(selector).last()
  if (!await submitButtonReady(sendButton)) return null
  try {
    await sendButton.click({ force: true })
  } catch {
    return { attempted: true, submitted: null }
  }
  return {
    attempted: true,
    submitted: await waitForComposerClear({ composer, readText, sleep, intervalMs, attempts: 20, method: 'button', onSubmitted }),
  }
}

async function tryKeyboardSubmit(options) {
  const { composer, readText, sleep, intervalMs, onSubmitted } = options
  await composer.press('Enter').catch(() => {})
  return waitForComposerClear({ composer, readText, sleep, intervalMs, attempts: 10, method: 'keyboard', onSubmitted })
}

export async function submitChatGPTPrompt(options = {}) {
  const {
    page,
    composer,
    selector,
    deadlineMs = DEFAULT_PROMPT_DEADLINE_MS,
    buttonSubmitTimeoutMs = DEFAULT_BUTTON_SUBMIT_TIMEOUT_MS,
    sendCheckIntervalMs = DEFAULT_SEND_CHECK_INTERVAL_MS,
    buttonPollIntervalMs = DEFAULT_BUTTON_POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = delay,
    readText = composerText,
    onSubmitted = () => {},
  } = options
  const deadline = now() + Math.min(deadlineMs, buttonSubmitTimeoutMs)
  while (now() < deadline) {
    const buttonAttempt = await tryButtonSubmit({ page, composer, selector, readText, sleep, intervalMs: sendCheckIntervalMs, onSubmitted })
    if (buttonAttempt?.submitted) return buttonAttempt.submitted
    if (buttonAttempt?.attempted) break
    await sleep(buttonPollIntervalMs)
  }

  const submitted = await tryKeyboardSubmit({ composer, readText, sleep, intervalMs: sendCheckIntervalMs, onSubmitted })
  if (submitted) return submitted
  throw new Error('ChatGPT composer did not submit prompt')
}

export async function waitForChatGPTResponse(options = {}) {
  const {
    read,
    extractText = () => '',
    attempts = DEFAULT_RESPONSE_POLL_ATTEMPTS,
    intervalMs = DEFAULT_RESPONSE_POLL_INTERVAL_MS,
    sleep = delay,
    onAttempt = () => {},
  } = options
  let lastStatus = 0
  let lastBody = ''
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await read().catch(() => null)
    const status = response?.status?.() || 0
    lastStatus = status
    onAttempt(status, attempt + 1)
    if ([401, 403].includes(status)) return { body: '', status }
    if (response?.ok?.()) {
      const body = await response.text().catch(() => '')
      if (body && body !== 'null') {
        lastBody = body
        if (extractText(body)) return { body, status }
      }
    }
    if (attempt + 1 < attempts) await sleep(intervalMs)
  }
  return { body: lastBody, status: lastStatus }
}

function answerIsStable(options) {
  const { text, streaming, lastChange, now, stableMs, codeStableMs } = options
  if (!text || streaming) return false
  const stableWindow = text.includes('```') ? codeStableMs : stableMs
  return now() - lastChange >= stableWindow
}

export async function waitForAssistantAnswer(options = {}) {
  const {
    read,
    answerTimeoutMs = 180_000,
    emptyRetryTimeoutMs = DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS,
    stableMs = 2_500,
    codeStableMs = 8_000,
    intervalMs = 500,
    now = () => Date.now(),
    sleep = delay,
  } = options
  const startedAt = now()
  const deadline = startedAt + answerTimeoutMs
  let answer = ''
  let lastText = ''
  let lastChange = startedAt

  while (now() < deadline) {
    const state = await read().catch(() => ({ text: '', streaming: false }))
    const text = String(state?.text || '').trim()
    if (text !== lastText) {
      lastText = text
      lastChange = now()
    } else if (answerIsStable({ text, streaming: state?.streaming, lastChange, now, stableMs, codeStableMs })) {
      answer = text
      break
    }
    if (!lastText && now() - startedAt >= emptyRetryTimeoutMs) {
      return { answer: '', retry: true }
    }
    await sleep(intervalMs)
  }

  return { answer: answer || lastText, retry: !answer && !lastText }
}
