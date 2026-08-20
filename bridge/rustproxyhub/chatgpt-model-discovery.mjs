function discoveryInfo(endpoints) {
  return {
    provider: 'chatgpt',
    source: 'playwright',
    api: 'chat_completions',
    endpoints,
  }
}

async function discoverWebModels(options) {
  const { state, listModels, endpoints, errors } = options
  const discovery = discoveryInfo(endpoints)
  if (!state.chatgpt.page) return { data: [], errors, discovery }
  try {
    const web = await listModels()
    return { data: web?.data || [], errors, discovery: web?.discovery || discovery }
  } catch (error) {
    errors.push(`ChatGPT web model discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    return { data: [], errors, discovery }
  }
}

function modelItems(options) {
  const { ids, isCodexModelId } = options
  const seen = new Set()
  const items = [...ids]
    .filter(id => !isCodexModelId(id) && !seen.has(id) && seen.add(id))
    .map(id => ({ id, provider: 'chatgpt', api: 'chat_completions' }))
  return items.length ? items : [{ id: 'chatgpt-web-session', provider: 'chatgpt', api: 'chat_completions' }]
}

export async function listChatGPTHybridModels(options) {
  const { state, listModels, endpoints, addKnownModels, addModelCandidate, isCodexModelId } = options
  const errors = []
  const web = await discoverWebModels({ state, listModels, endpoints, errors })
  const ids = new Set()
  addKnownModels(ids)
  for (const item of web.data || []) addModelCandidate(ids, 'chatgpt', item?.id)
  if (state.chatgpt.cachedHeaders?.model) addModelCandidate(ids, 'chatgpt', state.chatgpt.cachedHeaders.model)
  return { data: modelItems({ ids, isCodexModelId }), errors: web.errors, discovery: web.discovery }
}
