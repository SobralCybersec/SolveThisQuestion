const DEFAULT_PROMPT_DEADLINE_MS = 60_000
const DEFAULT_SEND_CHECK_INTERVAL_MS = 100
const DEFAULT_BUTTON_POLL_INTERVAL_MS = 150
export const DEFAULT_RESPONSE_POLL_ATTEMPTS = 40
export const DEFAULT_RESPONSE_POLL_INTERVAL_MS = 250
export const DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS = 10_000

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

export async function composerText(composer) {
  return (await composer.inputValue().catch(async () => composer.innerText().catch(() => ''))).trim()
}

export async function submitChatGPTPrompt(options = {}) {
  const {
    page,
    composer,
    selector,
    deadlineMs = DEFAULT_PROMPT_DEADLINE_MS,
    sendCheckIntervalMs = DEFAULT_SEND_CHECK_INTERVAL_MS,
    buttonPollIntervalMs = DEFAULT_BUTTON_POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = delay,
    readText = composerText,
    onSubmitted = () => {},
  } = options
  const deadline = now() + deadlineMs
  while (now() < deadline) {
    const sendButton = page.locator(selector).last()
    const ready = await sendButton.count()
      && await sendButton.isVisible().catch(() => false)
      && !await sendButton.isDisabled().catch(() => true)
    if (ready) {
      await sendButton.click({ force: true }).catch(() => {})
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!await readText(composer)) {
          onSubmitted('button')
          return 'button'
        }
        await sleep(sendCheckIntervalMs)
      }
    }
    await sleep(buttonPollIntervalMs)
  }

  await composer.press('Enter').catch(() => {})
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!await readText(composer)) {
      onSubmitted('keyboard')
      return 'keyboard'
    }
    await sleep(sendCheckIntervalMs)
  }
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
    } else if (text) {
      const stableWindow = text.includes('```') ? codeStableMs : stableMs
      if (!state?.streaming && now() - lastChange >= stableWindow) {
        answer = text
        break
      }
    }
    if (!lastText && now() - startedAt >= emptyRetryTimeoutMs) {
      return { answer: '', retry: true }
    }
    await sleep(intervalMs)
  }

  return { answer: answer || lastText, retry: !answer && !lastText }
}
