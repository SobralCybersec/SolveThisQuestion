const DEFAULT_PROMPT_DEADLINE_MS = 60_000
const DEFAULT_BUTTON_SUBMIT_TIMEOUT_MS = 5_000
const DEFAULT_SEND_CHECK_INTERVAL_MS = 100
const DEFAULT_BUTTON_POLL_INTERVAL_MS = 150
const DEFAULT_NON_STREAMING_STABLE_READS = 2
export const DEFAULT_RESPONSE_POLL_ATTEMPTS = 60
export const DEFAULT_RESPONSE_POLL_INTERVAL_MS = 50
export const DEFAULT_ASSISTANT_ANSWER_POLL_INTERVAL_MS = 50
export const DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS = 10_000

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

export async function composerText(composer) {
  return (await composer.inputValue().catch(async () => composer.innerText().catch(() => ''))).trim()
}

async function submitButtonReady(button) {
  const enabled = typeof button.isEnabled === 'function'
    ? await button.isEnabled().catch(() => false)
    : !await button.isDisabled().catch(() => true)
  if (!enabled) return false
  const ariaDisabled = typeof button.getAttribute === 'function'
    ? await button.getAttribute('aria-disabled').catch(() => null)
    : null
  if (ariaDisabled === 'true') return false
  return true
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
  const { page, composer, selector, readText, sleep, intervalMs, onSubmitted, waitForClearAfterSubmit } = options
  const sendButton = page.locator(selector).last()
  if (!await submitButtonReady(sendButton)) return null
  try {
    await sendButton.click({ force: true })
  } catch {
    return { attempted: true, submitted: null }
  }
  return {
    attempted: true,
    submitted: waitForClearAfterSubmit
      ? await waitForComposerClear({ composer, readText, sleep, intervalMs, attempts: 20, method: 'button', onSubmitted })
      : (onSubmitted('button'), 'button'),
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
    waitForClearAfterSubmit = true,
    now = () => Date.now(),
    sleep = delay,
    readText = composerText,
    onSubmitted = () => {},
  } = options
  const deadline = now() + Math.min(deadlineMs, buttonSubmitTimeoutMs)
  while (now() < deadline) {
    const buttonAttempt = await tryButtonSubmit({ page, composer, selector, readText, sleep, intervalMs: sendCheckIntervalMs, onSubmitted, waitForClearAfterSubmit })
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

function observeAssistantAnswer(state, previous, now) {
  const text = String(state?.text || '').trim()
  if (text !== previous.text) {
    return { text, lastChange: now(), stableReads: text ? 1 : 0 }
  }
  return {
    text,
    lastChange: previous.lastChange,
    stableReads: text && state?.streaming === false ? previous.stableReads + 1 : previous.stableReads,
  }
}

function assistantAnswerReady(state, observation, options) {
  const { stableMs, codeStableMs, nonStreamingStableReads, now } = options
  const { text, lastChange, stableReads } = observation
  if (!text) return false
  const fastStable = state?.streaming === false && stableReads >= nonStreamingStableReads
  return fastStable || answerIsStable({
    text,
    streaming: state?.streaming,
    lastChange,
    now,
    stableMs,
    codeStableMs,
  })
}

function emptyAnswerTimedOut(text, startedAt, now, timeoutMs) {
  return !text && now() - startedAt >= timeoutMs
}

export async function waitForAssistantAnswer(options = {}) {
  const {
    read,
    answerTimeoutMs = 180_000,
    emptyRetryTimeoutMs = DEFAULT_EMPTY_ANSWER_RETRY_TIMEOUT_MS,
    stableMs = 1_000,
    codeStableMs = 8_000,
    nonStreamingStableReads = DEFAULT_NON_STREAMING_STABLE_READS,
    intervalMs = DEFAULT_ASSISTANT_ANSWER_POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = delay,
  } = options
  const startedAt = now()
  const deadline = startedAt + answerTimeoutMs
  let answer = ''
  let observation = { text: '', lastChange: startedAt, stableReads: 0 }

  while (now() < deadline) {
    const state = await read().catch(() => ({ text: '', streaming: false }))
    observation = observeAssistantAnswer(state, observation, now)
    if (assistantAnswerReady(state, observation, { stableMs, codeStableMs, nonStreamingStableReads, now })) {
      answer = observation.text
      break
    }
    if (emptyAnswerTimedOut(observation.text, startedAt, now, emptyRetryTimeoutMs)) {
      return { answer: '', retry: true }
    }
    await sleep(intervalMs)
  }

  return { answer: answer || observation.text, retry: !answer && !observation.text }
}
