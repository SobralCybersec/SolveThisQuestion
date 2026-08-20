const DEFAULT_CHATGPT_SESSION_KEY = '__rust_proxy_hub_default_chatgpt_thread__'

export function chatGPTSessionKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  return key && key.length <= 256 ? key : DEFAULT_CHATGPT_SESSION_KEY
}
