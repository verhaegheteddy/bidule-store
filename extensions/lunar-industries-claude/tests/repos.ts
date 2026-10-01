import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The identity of the commits git makes in these tests (the merges too: set in process.env by the tests).
export const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...IDENTITY } })
    .toString()
    .trim()

// A repo cloned from a bare origin that has `launchpad`, with an untracked (ignored) file to copy.
export async function cloned() {
  const dir = await mkdtemp(join(tmpdir(), 'wt-real-'))
  const origin = join(dir, 'origin.git')
  sh(dir, 'init', '--bare', '-b', 'launchpad', origin)
  const repo = join(dir, 'app')
  sh(dir, 'clone', '-q', origin, repo)
  await writeFile(join(repo, 'README.md'), 'app\n')
  await writeFile(join(repo, '.gitignore'), 'src/env/\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'init')
  sh(repo, 'push', '-q', 'origin', 'launchpad')
  await mkdir(join(repo, 'src', 'env'), { recursive: true })
  await writeFile(join(repo, 'src', 'env', 'dev.ts'), 'export const dev = true\n')
  return { repo, origin }
}

/**
 * A repo cloned from a bare origin: `launchpad` (its main checkout), `staging` from it, and a work branch `7-ajout`
 * with a commit of its own, all pushed. `conflict`: staging and the work branch both change the README.
 */
export async function realRepo(conflict = false) {
  const dir = await mkdtemp(join(tmpdir(), 'tools-git-'))
  const origin = join(dir, 'origin.git')
  sh(dir, 'init', '--bare', '-b', 'launchpad', origin)
  const repo = join(dir, 'app')
  sh(dir, 'clone', '-q', origin, repo)
  await writeFile(join(repo, 'README.md'), 'app\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'init')
  sh(repo, 'push', '-q', 'origin', 'launchpad')
  sh(repo, 'branch', 'staging')
  if (conflict) {
    sh(repo, 'switch', '-q', 'staging')
    await writeFile(join(repo, 'README.md'), 'staging\n')
    sh(repo, 'commit', '-qam', 'staging fix')
    sh(repo, 'switch', '-q', 'launchpad')
  }
  sh(repo, 'push', '-q', 'origin', 'staging')
  sh(repo, 'switch', '-q', '-c', '7-ajout')
  await writeFile(join(repo, conflict ? 'README.md' : 'role.ts'), 'export const role = 1\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'feat: role')
  sh(repo, 'push', '-q', 'origin', '7-ajout')
  sh(repo, 'switch', '-q', 'launchpad')
  return { repo, origin }
}
