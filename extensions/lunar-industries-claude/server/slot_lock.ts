import { execFile } from 'node:child_process'
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseWslPath, wslPath } from './wsl.ts'

/**
 * Taken from quack-board (domain/slot_lock.ts, Simon's): the executable slot. A repo's main checkout is the only
 * folder that runs the app (one local database, one dev URL), so one piece of work at a time is tested there. Its
 * lock has the format of the team's `worktree` skill (wt_lock.sh), so that the sessions of the terminal and those of
 * the app see each other: a folder `<root>/.worktrees-locks/<repo>.lock`, made by mkdir (which only one can do),
 * holding a file `info` with the holder's pid, session name and date. A lock is alive while its pid is a running
 * Claude Code session, registered in `~/.claude/sessions/<pid>.json`.
 */

export const LOCKS_DIR = '.worktrees-locks'

export interface Holder {
  pid: string
  session: string
}

export interface LockInfo extends Holder {
  repo: string
  since: string
  alive: boolean
}

export interface LockHost {
  // The folder the locks are in, as this process reaches it.
  dir: string
  alive(pid: string): Promise<boolean>
}

export type Acquired = { ok: true; repos: string[] } | { ok: false; busy: LockInfo }

// A repo's lock is named after its folder, as the skill does.
export const lockName = (repo: string) => basename(repo.replace(/[\\/]+$/, ''))

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

function isRunning(pid: string): boolean {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (err) {
    // EPERM: it runs, under another user.
    return err instanceof Error && Reflect.get(err, 'code') === 'EPERM'
  }
}

// Where a workspace's locks are, and how to tell a live holder: here, or inside the WSL distro of a workspace in WSL.
export function lockHost(root: string, wslHome?: string): LockHost {
  const dir = join(root, LOCKS_DIR)
  const inWsl = process.platform === 'win32' ? parseWslPath(root) : null
  if (inWsl && wslHome) {
    const registry = wslPath(inWsl.distro, `${wslHome}/.claude/sessions`)
    return {
      dir,
      alive: async (pid) =>
        (await exists(join(registry, `${pid}.json`))) &&
        new Promise((resolve) =>
          execFile('wsl.exe', ['-d', inWsl.distro, '-e', 'kill', '-0', pid], { windowsHide: true }, (err) => resolve(!err))
        ),
    }
  }
  const registry = join(homedir(), '.claude', 'sessions')
  return { dir, alive: async (pid) => (await exists(join(registry, `${pid}.json`))) && isRunning(pid) }
}

// The pid of a session's Claude Code, found in the registry it writes as it starts; null once it ended.
export async function pidOfSession(configDir: string, sessionId: string): Promise<string | null> {
  const registry = join(configDir, 'sessions')
  const files = await readdir(registry).catch((): string[] => [])
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const entry = (await readFile(join(registry, file), 'utf8')
      .then((text) => JSON.parse(text) as { pid?: unknown; sessionId?: unknown })
      .catch(() => null)) ?? { pid: undefined, sessionId: undefined }
    if (entry.sessionId === sessionId && typeof entry.pid === 'number') return String(entry.pid)
  }
  return null
}

async function read(host: LockHost, repo: string): Promise<LockInfo | null> {
  const text = await readFile(join(host.dir, `${repo}.lock`, 'info'), 'utf8').catch(() => null)
  if (text === null) {
    return (await exists(join(host.dir, `${repo}.lock`))) ? { repo, pid: '', session: '', since: '', alive: false } : null
  }
  const field = (key: string) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? ''
  const pid = field('pid')
  return { repo, pid, session: field('session'), since: field('since'), alive: await host.alive(pid) }
}

/**
 * Takes the lock of every repo asked, or of none: in alphabetical order, so that two sessions asking for the same
 * repos in another order cannot block each other.
 */
export async function acquire(host: LockHost, repos: string[], holder: Holder): Promise<Acquired> {
  await mkdir(host.dir, { recursive: true })
  const names = [...new Set(repos)].sort()
  const taken: string[] = []
  for (const repo of names) {
    try {
      await mkdir(join(host.dir, `${repo}.lock`))
    } catch {
      for (const t of taken) await rm(join(host.dir, `${t}.lock`), { recursive: true, force: true })
      const busy = await read(host, repo)
      return { ok: false, busy: busy ?? { repo, pid: '', session: '', since: '', alive: false } }
    }
    await writeFile(join(host.dir, `${repo}.lock`, 'info'), `pid=${holder.pid}\nsession=${holder.session}\nsince=${new Date().toISOString()}\n`)
    taken.push(repo)
  }
  return { ok: true, repos: names }
}

// Gives the locks back; only those `pid` holds, when it is given.
export async function release(host: LockHost, repos: string[], pid?: string): Promise<string[]> {
  const released: string[] = []
  for (const repo of repos) {
    const lock = await read(host, repo)
    if (!lock || (pid && lock.pid !== pid)) continue
    await rm(join(host.dir, `${repo}.lock`), { recursive: true, force: true })
    released.push(repo)
  }
  return released
}

// The locks held, all of them or those of the repos given.
export async function lockStatus(host: LockHost, repos?: string[]): Promise<LockInfo[]> {
  const entries = await readdir(host.dir).catch((): string[] => [])
  const names = entries.filter((e) => e.endsWith('.lock')).map((e) => e.slice(0, -'.lock'.length))
  const wanted = repos ? names.filter((n) => repos.includes(n)) : names
  const found = await Promise.all(wanted.sort().map((n) => read(host, n)))
  return found.filter((l): l is LockInfo => l !== null)
}
