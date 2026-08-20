import { readFileSync } from 'node:fs'

export const CHATGPT_PAGE_REQUEST = readFileSync(
  new URL('./chatgpt-web-page.evaluate.js', import.meta.url),
  'utf8',
).trim()
