import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForAssistantAnswer } from '../bridge/rustproxyhub/chatgpt-web-flow.mjs'
import { extractChatGPTAssistantText } from '../bridge/rustproxyhub/chatgpt-web-response.mjs'

const iterations = Math.max(1, Number(process.env.BENCHMARK_ITERATIONS || 5000))
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputPath = resolve(
  repoRoot,
  process.env.BENCHMARK_OUTPUT || 'reports/quality/benchmarks.json',
)
const results = []
const payload = {
  mapping: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
    `message-${index}`,
    {
      message: {
        id: `message-${index}`,
        create_time: index,
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: [`answer ${index}`] },
      },
    },
  ])),
}
function run(name, fn) {
  const start = performance.now()
  for (let index = 0; index < iterations; index += 1) fn()
  const elapsed = performance.now() - start
  const ops = Math.round(iterations / (elapsed / 1000))
  results.push({ name, iterations, elapsed_ms: Number(elapsed.toFixed(2)), ops_per_second: ops })
  console.log(`${name}: ${elapsed.toFixed(2)} ms total, ${ops} ops/s`)
}

run('response extraction', () => extractChatGPTAssistantText(payload))

const runAsync = async (name, fn) => {
  const start = performance.now()
  for (let index = 0; index < iterations; index += 1) await fn()
  const elapsed = performance.now() - start
  const ops = Math.round(iterations / (elapsed / 1000))
  results.push({ name, iterations, elapsed_ms: Number(elapsed.toFixed(2)), ops_per_second: ops })
  console.log(`${name}: ${elapsed.toFixed(2)} ms total, ${ops} ops/s`)
}

await runAsync('stable answer wait', () => waitForAssistantAnswer({
  read: async () => ({ text: 'answer', streaming: false }),
  stableMs: 0,
  codeStableMs: 0,
  sleep: async () => {},
}))

await mkdir(resolve(outputPath, '..'), { recursive: true })
await writeFile(outputPath, `${JSON.stringify({
  generated_at: new Date().toISOString(),
  iterations,
  benchmarks: results,
}, null, 2)}\n`)
