import { fileURLToPath } from 'node:url'
import type { ServerContext } from '@bidule/api/extensions'
import '@bidule/ext-git/contract'
import '../contract.ts'
import { SessionError } from './errors.ts'
import { list, readSettings, reviewTargetOf } from './settings.ts'
import { SessionService } from './sessions.ts'
import { SessionStore } from './store.ts'
import { workspaceTools } from './tools.ts'
import { addWorktree, baseOf } from './worktrees.ts'

// For the controller, once started (its page's first request starts it).
export let ctx: ServerContext
export let store: SessionStore
export let sessions: SessionService

// The team's skills, loaded by every session (a Claude Code plugin, copied with the module).
export const PLUGIN = fileURLToPath(new URL('../claude/plugin', import.meta.url))

export const settings = () => readSettings(ctx)
// The `git` role with what the sessions' tools need of it (forges, raw commands): an older provider lacks them.
export async function git() {
  const g = await ctx.use('git')
  if (typeof g.run !== 'function' || typeof g.forgeOf !== 'function') {
    throw new SessionError('Le provider git est trop ancien pour les sessions Claude : mettre à jour l’extension git', 409)
  }
  return g
}
export const tasks = async () => (ctx.has('tasks') ? ctx.use('tasks') : null)

// The sessions run only once the user has turned them on (Réglages): the Agent SDK with their Claude account.
export async function enabled(): Promise<void> {
  if (!(await settings()).enabled) {
    throw new SessionError('Les sessions Claude dans l’app sont désactivées (Réglages › Lunar Industries - Claude)', 403)
  }
}

// A branch's worktree in a repo, with the repo's settings: its base, the untracked files to copy, its preparation.
export async function repoWorktree(repo: string, branch: string) {
  const s = await settings()
  const g = await git()
  const own = s.repos[repo] ?? {}
  return addWorktree(g, repo, branch, {
    base: await baseOf(g, repo, reviewTargetOf(s, repo)),
    seed: list((own.worktreeSeed ?? '').replace(/\s+/g, ',')),
    prepare: own.worktreePrepare || null,
  })
}

export async function activate(context: ServerContext) {
  ctx = context
  store = new SessionStore(ctx.db)
  sessions = new SessionService({
    store,
    settings,
    git,
    tasks,
    tell: {
      sessions: (id, status) => void ctx.events.emit('lunar-industries-claude.sessions', { id, status }),
      session: (id, message) => void ctx.events.emit('lunar-industries-claude.session', { id, message }),
    },
    tools: workspaceTools({ git, tasks, settings, store }),
    worktree: repoWorktree,
    plugins: [PLUGIN],
  })
  // No process survived the previous API: the sessions it ran are saved.
  await sessions.recover()
}
