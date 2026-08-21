import { send, sendEvent } from './browser-runtime.mjs'
import { handle, shutdownAndExit } from './chatgpt-controller.mjs'

export { browserBackendFromEnv } from './browser-runtime.mjs'

let buffer = ''
let pending = Promise.resolve()

async function processLine(line) {
  if (!line) return
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

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex = buffer.indexOf('\n')
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    pending = pending.then(() => processLine(line))
    newlineIndex = buffer.indexOf('\n')
  }
})

process.stdin.on('end', async () => {
  if (buffer.trim()) pending = pending.then(() => processLine(buffer.trim()))
  await pending
  await shutdownAndExit(0)
})

process.on('SIGTERM', () => {
  void shutdownAndExit(0)
})

process.on('SIGINT', () => {
  void shutdownAndExit(0)
})
