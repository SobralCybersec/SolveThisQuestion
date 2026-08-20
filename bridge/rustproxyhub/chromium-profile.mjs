import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function removeStaleChromiumProfileLock(profileDir) {
  const lockPath = path.join(profileDir, 'SingletonLock')
  let target
  try {
    target = fs.readlinkSync(lockPath)
  } catch {
    return false
  }
  const targetText = String(target)
  const separator = targetText.lastIndexOf('-')
  const pid = Number(separator > 0 ? targetText.slice(separator + 1) : '')
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error?.code !== 'ESRCH') return false
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(profileDir, name))
    } catch (error) {
      if (error?.code !== 'ENOENT') return false
    }
  }
  return true
}

function processPidFromLine(trimmed) {
  const separator = trimmed.indexOf(' ')
  if (separator < 1) return null
  const pid = Number(trimmed.slice(0, separator))
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null
  return { pid, args: trimmed.slice(separator + 1) }
}

function profileArgument(args) {
  const marker = '--user-data-dir='
  const start = args.indexOf(marker)
  if (start < 0) return ''
  const value = args.slice(start + marker.length).trimStart()
  const quote = value[0]
  const quoted = quote === '"' || quote === "'"
  const offset = quoted ? 1 : 0
  let end = quoted ? value.indexOf(quote, 1) : value.indexOf(' ')
  if (end < 0) end = value.length
  return value.slice(offset, end)
}

function profilePidFromLine(line, expected) {
  const process = processPidFromLine(line.trim())
  if (!process) return null
  const userData = profileArgument(process.args)
  return userData && path.resolve(userData) === expected ? process.pid : null
}

export function chromiumProcessesUsingProfile(profileDir) {
  if (process.platform === 'win32') return []
  let output
  try {
    output = execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024,
    })
  } catch {
    return []
  }
  const expected = path.resolve(profileDir)
  const pids = []
  for (const line of output.split('\n')) {
    const pid = profilePidFromLine(line, expected)
    if (pid) pids.push(pid)
  }
  return pids
}

export async function closeChromiumProfileInstances(profileDir) {
  let pids = chromiumProcessesUsingProfile(profileDir)
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  const deadline = Date.now() + 2500
  while (pids.length && Date.now() < deadline) {
    await sleep(100)
    pids = chromiumProcessesUsingProfile(profileDir)
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  return pids.length === 0
}

export function isProfileSingletonError(error) {
  return /ProcessSingleton|SingletonLock/i.test(error instanceof Error ? error.message : String(error))
}

// Defense-in-depth: account_id is joined to a filesystem profile path.
// Reject anything outside [A-Za-z0-9_-]{1,64} before path.resolve sees it.
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/
export function assertSafeAccountId(accountId) {
  if (accountId != null && accountId !== '' && !SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error(`unsafe account_id rejected: ${accountId}`)
  }
}

// Known install locations per Chromium-family browser, across platforms. Used
// to fall back to an installed browser when the requested channel's own
// distribution is missing (e.g. 'msedge' requested on a Linux box that only has
// Chromium) instead of hard-failing the launch.
