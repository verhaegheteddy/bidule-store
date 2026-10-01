import { exec, execFile } from 'node:child_process'
import { appendFile, copyFile, glob, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, sep } from 'node:path'
import type { GitSource } from '@bidule/ext-git/contract'
import { parseWslPath } from './wsl.ts'

/**
 * Taken from quack-board (domain/worktrees.ts, Simon's): git worktrees, one folder per branch, so that several
 * sessions work on a repo at once without taking each other's branch. They follow the team's `worktree` skill:
 * `<repo>/.claude/worktrees/<branch>/` (this module only: Bidule's own Claude extension keeps a folder per task). The
 * main checkout stays the only folder that runs the app (see slot_lock.ts). git runs through the `git` role (inside
 * WSL on Windows); paths given to git are relative to the repo.
 */

export const WORKTREES_DIR = '.claude/worktrees'
const EXCLUDED = `${WORKTREES_DIR}/`

// A refusal the user can act on: its message says why.
export class WorktreeError extends Error {}

export interface Worktree {
  path: string
  branch: string | null
  head: string
  // The repo's own folder, not a worktree.
  main: boolean
}

export interface AddOptions {
  // The branch a new branch starts from; by default the repo's integration branch (see baseOf).
  base?: string
  // Untracked files to copy from the main checkout: globs relative to the repo.
  seed?: string[]
  // A command to run in the new worktree (`npm ci`).
  prepare?: string | null
}

export interface Added {
  path: string
  // How the branch was found: already in its worktree, a local branch, the remote's, or new from `base`.
  from: 'existing' | 'local' | 'remote' | 'new'
  base: string | null
  seeded: string[]
  // Why the preparation failed, if it did: the worktree is there anyway, to prepare by hand.
  prepareError: string | null
}

export const relativePath = (branch: string) => `${WORKTREES_DIR}/${branch}`
export const worktreePath = (repo: string, branch: string) => join(repo, ...relativePath(branch).split('/'))

const out = async (git: GitSource, folder: string, args: string[], timeout?: number) =>
  (await git.run(folder, args, timeout)).trim()

const hasRef = (git: GitSource, repo: string, ref: string) =>
  git.run(repo, ['show-ref', '--verify', '--quiet', ref]).then(
    () => true,
    () => false
  )

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

// `git worktree list --porcelain`: blocks of `key value` lines, separated by an empty line.
export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, i) => {
      const fields = new Map(
        block.split('\n').map((line) => {
          const at = line.indexOf(' ')
          return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)]
        })
      )
      const ref = fields.get('branch')
      return {
        path: fields.get('worktree') ?? '',
        branch: ref ? ref.replace(/^refs\/heads\//, '') : null,
        head: fields.get('HEAD') ?? '',
        main: i === 0,
      }
    })
}

export async function listWorktrees(git: GitSource, repo: string): Promise<Worktree[]> {
  return parseWorktrees(await git.run(repo, ['worktree', 'list', '--porcelain']))
}

// The branch a new branch of the repo starts from: its review target, else the branch its main checkout has out.
export async function baseOf(git: GitSource, repo: string, target: string | null): Promise<string> {
  return target || out(git, repo, ['branch', '--show-current'])
}

// `.claude/worktrees/` in the repo's own exclude file: never in `git status`, nothing versioned.
export async function excludeWorktrees(git: GitSource, repo: string): Promise<void> {
  const found = await out(git, repo, ['rev-parse', '--git-path', 'info/exclude'])
  const file = isAbsolute(found) ? found : join(repo, ...found.split('/'))
  const current = await readFile(file, 'utf8').catch(() => '')
  if (current.split(/\r?\n/).includes(EXCLUDED)) return
  await mkdir(dirname(file), { recursive: true })
  const prefix = current && !current.endsWith('\n') ? '\n' : ''
  await appendFile(file, `${prefix}# Claude sessions' worktrees (Lunar Industries - Claude)\n${EXCLUDED}\n`)
}

// Copies the untracked files the repo needs to build: `git worktree add` copies only what git tracks.
async function seed(repo: string, target: string, patterns: string[]): Promise<string[]> {
  const copied: string[] = []
  for (const pattern of patterns) {
    for await (const relative of glob(pattern, { cwd: repo })) {
      const source = join(repo, relative)
      if (!(await stat(source)).isFile()) continue
      const destination = join(target, relative)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
      copied.push(relative.split(sep).join('/'))
    }
  }
  return copied
}

// Installing dependencies takes minutes.
const PREPARE_MS = 15 * 60_000

// Runs a command line in a folder, where its tools live: inside its WSL distro on Windows (a login shell: the user's
// PATH), else here.
export function shellIn(folder: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const inWsl = process.platform === 'win32' ? parseWslPath(folder) : null
    const done = (err: Error | null) => (err ? reject(err) : resolve())
    if (inWsl) {
      execFile('wsl.exe', ['-d', inWsl.distro, '--cd', inWsl.linux, '-e', 'sh', '-lc', command], { timeout: PREPARE_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, done)
    } else {
      exec(command, { cwd: folder, timeout: PREPARE_MS, maxBuffer: 16 * 1024 * 1024 }, done)
    }
  })
}

/**
 * The worktree of `branch` in `repo`, created if needed: the branch is taken up when it exists (locally, else on the
 * remote), else created from `origin/<base>` after a fetch. Refused when the branch is out in another folder.
 */
export async function addWorktree(git: GitSource, repo: string, branch: string, options: AddOptions = {}): Promise<Added> {
  const path = worktreePath(repo, branch)
  const rel = relativePath(branch)
  const done = (from: Added['from'], base: string | null = null): Added => ({ path, from, base, seeded: [], prepareError: null })

  if (await exists(path)) {
    const current = await out(git, path, ['branch', '--show-current']).catch(() => '')
    if (current === branch) return done('existing')
    throw new WorktreeError(`Le dossier ${rel} existe déjà et porte la branche « ${current || '?'} », pas « ${branch} »`)
  }

  // Without the network, the local refs are used.
  await git.run(repo, ['fetch', '--quiet', 'origin'], 60_000).catch(() => undefined)

  let added: Added
  if (await hasRef(git, repo, `refs/heads/${branch}`)) {
    const worktrees = await listWorktrees(git, repo)
    const taken = worktrees.find((w) => w.branch === branch)
    if (taken) throw new WorktreeError(`La branche « ${branch} » est déjà sortie dans ${taken.path}`)
    await git.run(repo, ['worktree', 'add', rel, branch])
    added = done('local')
  } else if (await hasRef(git, repo, `refs/remotes/origin/${branch}`)) {
    await git.run(repo, ['worktree', 'add', '--track', '-b', branch, rel, `origin/${branch}`])
    added = done('remote')
  } else {
    const base = options.base || (await baseOf(git, repo, null))
    if (!base) throw new WorktreeError('Branche de départ inconnue : le dépôt n’est sur aucune branche')
    const start = (await hasRef(git, repo, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base
    await git.run(repo, ['worktree', 'add', '-b', branch, rel, start])
    added = done('new', base)
  }

  await excludeWorktrees(git, repo)
  added.seeded = await seed(repo, path, options.seed ?? [])
  if (options.prepare) {
    await shellIn(path, options.prepare).catch((err: Error) => {
      added.prepareError = err.message.split('\n')[0]
    })
  }
  return added
}

// Removes a branch's worktree; the branch and its commits stay. Never forced: refused while it has uncommitted work.
export async function removeWorktree(git: GitSource, repo: string, branch: string): Promise<void> {
  const path = worktreePath(repo, branch)
  if (!(await exists(path))) throw new WorktreeError(`Pas de worktree pour « ${branch} »`)
  if (await out(git, path, ['status', '--porcelain'])) {
    throw new WorktreeError(`Le worktree de « ${branch} » a des modifications non committées : il est gardé`)
  }
  await git.run(repo, ['worktree', 'remove', relativePath(branch)])
  await git.run(repo, ['worktree', 'prune'])
}

// A file changed in a worktree, with its lines added and removed (null for a binary or a new untracked file).
export type ChangedFile = { path: string; added: number | null; removed: number | null }

// `git diff --numstat`: « added<TAB>removed<TAB>path », « - » for a binary file.
export function parseNumstat(text: string): ChangedFile[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...path] = line.split('\t')
      const n = (v: string) => (v === '-' ? null : Number(v))
      return { path: path.join('\t'), added: n(added), removed: n(removed) }
    })
}

// What a worktree's branch changes since it left `origin/<base>`, commits and uncommitted work, then new files.
export async function changedFiles(git: GitSource, worktree: string, base: string): Promise<ChangedFile[]> {
  const from = (await out(git, worktree, ['merge-base', 'HEAD', `origin/${base}`]).catch(() => '')) || 'HEAD'
  const tracked = parseNumstat(await out(git, worktree, ['diff', '--numstat', from]))
  const untracked = await out(git, worktree, ['ls-files', '--others', '--exclude-standard'])
  return [
    ...tracked,
    ...untracked
      .split('\n')
      .filter(Boolean)
      .map((path) => ({ path, added: null, removed: null })),
  ]
}

/**
 * Where a session starts: the configured root, else the folder its repos share (the workspace holding them), else
 * the home folder git runs in (WSL's default distro's on Windows).
 */
export async function workspaceRoot(configured: string, repos: string[], git: GitSource): Promise<string> {
  if (configured.trim()) return git.resolvePath(configured.trim())
  const home = () => git.resolvePath('~')
  if (!repos.length) return home()
  const parts = repos.map((r) => dirname(r).split(sep))
  const shared: string[] = []
  for (let i = 0; i < parts[0].length; i++) {
    if (parts.some((p) => p[i] !== parts[0][i])) break
    shared.push(parts[0][i])
  }
  const common = shared.join(sep)
  // Nothing shared but the filesystem's root: the home folder is a better start.
  if (!common || common === parse(repos[0]).root.replace(/[\\/]$/, '')) return home()
  return common
}
