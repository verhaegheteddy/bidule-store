import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquire, LOCKS_DIR, lockName, lockStatus, pidOfSession, release, type LockHost } from '../server/slot_lock.ts'

// Taken from quack-board (tests/unit/slot_lock.spec.ts, Simon's). Locks in a temporary workspace; the pids in
// `living` are running sessions.
async function host(living: string[] = []): Promise<LockHost> {
  const root = await mkdtemp(join(tmpdir(), 'slot-'))
  return { dir: join(root, LOCKS_DIR), alive: async (pid) => living.includes(pid) }
}

describe('Executable slot · the lock', () => {
  it('takes every repo asked, in the skill’s format', async () => {
    const h = await host(['100'])
    const taken = await acquire(h, ['insight', 'api-php'], { pid: '100', session: 'Tâche 42' })
    expect(taken).toEqual({ ok: true, repos: ['api-php', 'insight'] })
    const info = await readFile(join(h.dir, 'insight.lock', 'info'), 'utf8')
    expect(info).toMatch(/^pid=100\nsession=Tâche 42\nsince=\d{4}-\d\d-\d\dT[^\n]+\n$/)
  })

  it('takes none when one is held, and says by whom', async () => {
    const h = await host(['100'])
    await acquire(h, ['insight'], { pid: '100', session: 'Tâche 42' })
    const second = await acquire(h, ['api-php', 'insight'], { pid: '200', session: 'Tâche 43' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.busy).toMatchObject({ repo: 'insight', pid: '100', alive: true })
    // api-php, taken first in alphabetical order, was given back.
    expect((await lockStatus(h)).map((l) => l.repo)).toEqual(['insight'])
  })

  it('gives back only the holder’s locks', async () => {
    const h = await host(['100'])
    await acquire(h, ['insight'], { pid: '100', session: 'a' })
    expect(await release(h, ['insight'], '200')).toEqual([])
    expect(await release(h, ['insight'], '100')).toEqual(['insight'])
    expect(await lockStatus(h)).toEqual([])
  })

  it('a lock is named after the repo’s folder, and a session’s pid read in the registry', async () => {
    expect(lockName('/home/me/workspace/insight/')).toBe('insight')
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'))
    await mkdir(join(config, 'sessions'))
    await writeFile(join(config, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'abc', kind: 'interactive' }))
    expect(await pidOfSession(config, 'abc')).toBe('4242')
    expect(await pidOfSession(config, 'other')).toBeNull()
  })
})
