import assert from 'node:assert/strict'
import test from 'node:test'
import { BASE_STEALTH_ARGS, HEADLESS_UA, baseLaunchOptions, chromium } from '../rustproxyhub/browser-runtime.mjs'

test('headless launch uses shared stealth args and coherent UA', () => {
  const options = baseLaunchOptions({ headless: true, engine: chromium })
  assert.deepEqual(options.args, [
    ...BASE_STEALTH_ARGS,
    `--user-agent=${HEADLESS_UA}`,
    '--window-size=1920,1080',
  ])
  assert.deepEqual(options.ignoreDefaultArgs, ['--enable-automation'])
  assert.equal(options.viewport, null)
  assert.equal(options.channel, 'chrome')
})

test('explicit executable path disables channel selection', () => {
  const options = baseLaunchOptions({
    headless: false,
    executablePath: '/opt/chromium/chrome',
    channel: 'msedge',
    engine: chromium,
    extraArgs: ['--custom-flag'],
  })
  assert.equal(options.executablePath, '/opt/chromium/chrome')
  assert.equal(options.channel, undefined)
  assert.deepEqual(options.args, [...BASE_STEALTH_ARGS, '--custom-flag'])
})
