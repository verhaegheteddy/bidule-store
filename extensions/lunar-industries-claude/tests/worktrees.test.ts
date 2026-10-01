import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addWorktree, parseWorktrees, removeWorktree, workspaceRoot, WorktreeError, worktreePath } from '../server/worktrees.ts'
import { FakeGit, real, recording } from './fakes.ts'
import { cloned } from './repos.ts'

// Taken from quack-board (tests/unit/worktrees.spec.ts, Simon's). git runs through the `git` role: a fake one that
// records the commands, or one that runs git.

const recorded = (refs: string[] = [], list = '') => {
  const git = new FakeGit()
  git.run = recording(git, refs, { list })
  // Without the folder: the commands as the repo's git runs them.
  const commands = () => git.commands.map((c) => c.slice(c.indexOf(' ') + 1))
  return { git, commands }
}

describe('Worktrees · the commands', () => {
  it('a new branch starts from the remote integration branch, by a path relative to the repo', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'wt-'))
    const { git, commands } = recorded(['refs/remotes/origin/launchpad'])
    const added = await addWorktree(git, repo, '42-ajout', { base: 'launchpad' })
    expect(added.from).toBe('new')
    expect(commands().slice(0, 5)).toEqual([
      'fetch --quiet origin',
      'show-ref --verify --quiet refs/heads/42-ajout',
      'show-ref --verify --quiet refs/remotes/origin/42-ajout',
      'show-ref --verify --quiet refs/remotes/origin/launchpad',
      'worktree add -b 42-ajout .claude/worktrees/42-ajout origin/launchpad',
    ])
  })

  it('a branch on the remote only is taken up, tracking it', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'wt-'))
    const { git, commands } = recorded(['refs/remotes/origin/42-ajout'])
    const added = await addWorktree(git, repo, '42-ajout')
    expect(added.from).toBe('remote')
    expect(commands()).toContain('worktree add --track -b 42-ajout .claude/worktrees/42-ajout origin/42-ajout')
  })

  it('a local branch already out elsewhere is refused, saying where', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'wt-'))
    const { git, commands } = recorded(['refs/heads/42-ajout'], 'worktree /work/app\nHEAD abc\nbranch refs/heads/42-ajout\n')
    await expect(addWorktree(git, repo, '42-ajout')).rejects.toThrow('La branche « 42-ajout » est déjà sortie dans /work/app')
    expect(commands().join('\n')).not.toContain('worktree add')
  })

  it('reads git’s list of worktrees', () => {
    const list = [
      'worktree /work/app',
      'HEAD aaa',
      'branch refs/heads/launchpad',
      '',
      'worktree /work/app/.claude/worktrees/42-ajout',
      'HEAD bbb',
      'branch refs/heads/42-ajout',
      '',
      'worktree /work/app/.claude/worktrees/detached',
      'HEAD ccc',
      'detached',
      '',
    ].join('\n')
    expect(parseWorktrees(list)).toEqual([
      { path: '/work/app', branch: 'launchpad', head: 'aaa', main: true },
      { path: '/work/app/.claude/worktrees/42-ajout', branch: '42-ajout', head: 'bbb', main: false },
      { path: '/work/app/.claude/worktrees/detached', branch: null, head: 'ccc', main: false },
    ])
  })

  it('a session starts in the folder its repos share', async () => {
    const git = new FakeGit()
    expect(await workspaceRoot('', ['/home/me/workspace/app', '/home/me/workspace/api'], git)).toBe('/home/me/workspace')
    expect(await workspaceRoot('/opt/work', ['/home/me/workspace/app'], git)).toBe('/opt/work')
    expect(await workspaceRoot('', ['/home/me/workspace/app'], git)).toBe('/home/me/workspace')
  })

  it('without a repo, or with nothing shared, a session starts in the home ~ resolves to', async () => {
    const git = new FakeGit()
    expect(await workspaceRoot('', [], git)).toBe(homedir())
    expect(await workspaceRoot('', ['/a/app', '/b/app'], git)).toBe(homedir())
  })

  it('a session without a repo is refused when ~ cannot be resolved (WSL unreachable)', async () => {
    const git = new FakeGit()
    git.resolvePath = async () => {
      throw new Error('WSL injoignable')
    }
    await expect(workspaceRoot('', [], git)).rejects.toThrow('WSL injoignable')
  })
})

describe('Worktrees · with git', () => {
  const git = new FakeGit(real)

  it('creates, excludes, copies the untracked files, prepares, then removes', async () => {
    const { repo } = await cloned()
    const added = await addWorktree(git, repo, '42-ajout', { base: 'launchpad', seed: ['src/env/*.ts'], prepare: 'touch prepared' })
    const path = worktreePath(repo, '42-ajout')
    expect(added).toMatchObject({ path, from: 'new', base: 'launchpad', seeded: ['src/env/dev.ts'], prepareError: null })
    await access(join(path, 'prepared'))
    expect(await readFile(join(path, 'src', 'env', 'dev.ts'), 'utf8')).toBe('export const dev = true\n')
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/worktrees/\n')
    // Excluded: the worktrees do not show in the main checkout's status.
    expect((await git.run(repo, ['status', '--porcelain'])).trim()).toBe('')

    // Asked again, the same worktree is given back.
    expect((await addWorktree(git, repo, '42-ajout')).from).toBe('existing')

    await git.run(path, ['clean', '-fdxq'])
    await removeWorktree(git, repo, '42-ajout')
    await expect(access(path)).rejects.toThrow()
    // The branch stays in the repo.
    expect(await git.run(repo, ['branch', '--list', '42-ajout'])).toContain('42-ajout')
  })

  it('a failed preparation leaves the worktree, saying why', async () => {
    const { repo } = await cloned()
    const added = await addWorktree(git, repo, '44-prep', { base: 'launchpad', prepare: 'exit 3' })
    expect(added.prepareError).toBeTruthy()
    await access(added.path)
  })

  it('keeps a worktree that has changes not committed', async () => {
    const { repo } = await cloned()
    const { path } = await addWorktree(git, repo, '43-autre', { base: 'launchpad' })
    await writeFile(join(path, 'README.md'), 'changed\n')
    await expect(removeWorktree(git, repo, '43-autre')).rejects.toThrow(WorktreeError)
    await access(path)
  })

  it('refuses the branch the main checkout has out', async () => {
    const { repo } = await cloned()
    await expect(addWorktree(git, repo, 'launchpad')).rejects.toThrow(/déjà sortie dans/)
  })
})
