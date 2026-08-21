const BROWSER_MANAGED_HEADERS = new Set([
  'cookie',
  'origin',
  'referer',
  'user-agent',
  'accept-encoding',
  'connection',
  'host',
])

// Poll from inside the page. page.context().request leaves over Node's TLS
// stack, so Cloudflare saw a non-Chrome fingerprint carrying Chrome's cookies
// on a chatgpt.com backend call - exactly the mismatch it challenges.
export function readChatGPTConversationInPage(page, conversationId, responseHeaders) {
  const headers = Object.fromEntries(
    Object.entries(responseHeaders).filter(([name, value]) => value && !BROWSER_MANAGED_HEADERS.has(name.toLowerCase())),
  )
  return async () => {
    const result = await page.evaluate(
      async ({ url, requestHeaders }) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
          const response = await fetch(url, {
            headers: requestHeaders,
            credentials: 'include',
            signal: controller.signal,
          })
          return { status: response.status, ok: response.ok, body: await response.text() }
        } finally {
          clearTimeout(timer)
        }
      },
      { url: `https://chatgpt.com/backend-api/conversation/${conversationId}`, requestHeaders: headers },
    )
    return { status: () => result.status, ok: () => result.ok, text: async () => result.body }
  }
}
