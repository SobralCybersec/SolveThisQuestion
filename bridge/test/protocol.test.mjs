import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('bridge API returns correlated structured error for unsupported calls', async t => {
  const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const child = spawn(process.execPath, [path.join(bridgeDir, 'rustproxyhub/index.mjs')], {
    cwd: bridgeDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGTERM'))
  child.stdin.write(`${JSON.stringify({ id: 'api-test', provider: 'unknown', method: 'status' })}\n`)

  let output = ''
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge API response timeout')), 10000)
    child.stdout.on('data', chunk => {
      output += chunk
      const line = output.split('\n').find(Boolean)
      if (!line) return
      clearTimeout(timer)
      resolve(JSON.parse(line))
    })
    child.once('error', reject)
  })
  assert.deepEqual(result, {
    id: 'api-test',
    result: null,
    error: 'Unsupported helper call: unknown:status',
  })
  child.kill('SIGTERM')
  await once(child, 'exit').catch(() => {})
})

test('bridge drains queued response before stdin close', async () => {
  const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const child = spawn(process.execPath, [path.join(bridgeDir, 'rustproxyhub/index.mjs')], {
    cwd: bridgeDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge EOF response timeout')), 10000)
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const line = buffer.split('\n').find(Boolean)
      if (!line) return
      clearTimeout(timer)
      resolve(JSON.parse(line))
    })
    child.once('error', reject)
  })
  child.stdin.end(`${JSON.stringify({ id: 'eof-test', provider: 'unknown', method: 'status' })}\n`)
  const result = await output
  assert.deepEqual(result, {
    id: 'eof-test',
    result: null,
    error: 'Unsupported helper call: unknown:status',
  })
  await once(child, 'exit')
})
