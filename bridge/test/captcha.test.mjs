import assert from 'node:assert/strict'
import test from 'node:test'
import { captchaSolvingEnabled, passCaptchaIfChallenged } from '../captcha.js'

function fakePage(challenged) {
  const waits = []
  return {
    waits,
    evaluate: async () => challenged,
    waitForTimeout: async ms => waits.push(ms),
  }
}

test('captcha solver gate follows HIREMEOPS_AUTO_CAPTCHA', () => {
  const previous = process.env.HIREMEOPS_AUTO_CAPTCHA
  delete process.env.HIREMEOPS_AUTO_CAPTCHA
  assert.equal(captchaSolvingEnabled(), false)
  process.env.HIREMEOPS_AUTO_CAPTCHA = '1'
  assert.equal(captchaSolvingEnabled(), true)
  if (previous == null) delete process.env.HIREMEOPS_AUTO_CAPTCHA
  else process.env.HIREMEOPS_AUTO_CAPTCHA = previous
})

test('unchallenged page skips solver work', async () => {
  const page = fakePage(false)
  assert.deepEqual(await passCaptchaIfChallenged(page), { challenged: false, solved: true })
  assert.deepEqual(page.waits, [])
})

test('disabled solver reports an unresolved challenge', async () => {
  const previous = process.env.HIREMEOPS_AUTO_CAPTCHA
  delete process.env.HIREMEOPS_AUTO_CAPTCHA
  const page = fakePage(true)
  assert.deepEqual(await passCaptchaIfChallenged(page, { settleMs: 7 }), { challenged: true, solved: false })
  assert.deepEqual(page.waits, [7])
  if (previous == null) delete process.env.HIREMEOPS_AUTO_CAPTCHA
  else process.env.HIREMEOPS_AUTO_CAPTCHA = previous
})
