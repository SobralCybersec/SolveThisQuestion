import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('./chatgpt-web-page.evaluate.js', import.meta.url),
  'utf8',
).trim()

const requestStart = source.indexOf('(async ({')
if (requestStart < 0) throw new Error('ChatGPT page request function not found')

const helperSource = source.slice(0, requestStart)
const requestSource = source.slice(requestStart)

export const CHATGPT_PAGE_REQUEST = new Function(`return async function chatGPTPageRequest(input) {
${helperSource}
return await ${requestSource}(input)
}`)()
