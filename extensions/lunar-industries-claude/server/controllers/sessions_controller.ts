import { basename, join, sep } from 'node:path'
import type { HttpContext } from '@adonisjs/core/http'
import { ctx, enabled, git, sessions, settings, store, tasks } from '@bidule/ext-lunar-industries-claude/server/index'
import { SessionError } from '@bidule/ext-lunar-industries-claude/server/errors'
import { detect, placeOf } from '@bidule/ext-lunar-industries-claude/server/runner'
import { reviewTargetOf } from '@bidule/ext-lunar-industries-claude/server/settings'
import { lockHost, lockName, lockStatus, pidOfSession } from '@bidule/ext-lunar-industries-claude/server/slot_lock'
import type { UsageByModel } from '@bidule/ext-lunar-industries-claude/server/store'
import { localConfigDir } from '@bidule/ext-lunar-industries-claude/server/tools'
import { baseOf, changedFiles, WORKTREES_DIR } from '@bidule/ext-lunar-industries-claude/server/worktrees'
import {
  archiveValidator,
  contextValidator,
  decisionValidator,
  effortValidator,
  eventsValidator,
  messageValidator,
  modelValidator,
  modeValidator,
  startValidator,
  taskValidator,
  watchValidator,
} from '@bidule/ext-lunar-industries-claude/server/validators'
import type { SessionContext, UsageRow } from '../../contract.ts'

// Tokens by model, for the interface. `priced`: the figures come from what the session's turns reported, so their
// dollars mean something; read back from a transcript they do not, and the row says so.
function usageRows(usage: UsageByModel, priced: boolean): UsageRow[] {
  return Object.entries(usage).map(([model, u]) => ({
    model,
    input: u.inputTokens,
    output: u.outputTokens,
    thinking: u.thinkingTokens ?? null,
    cacheRead: u.cacheReadInputTokens,
    cacheWrite: u.cacheCreationInputTokens,
    costUsd: priced ? u.costUSD : null,
    // 'unknown': Claude Code found no price for this model, so its dollars are a guess.
    basis: priced ? (u.costBasis ?? 'list') : null,
  }))
}

const repoPaths = async () => (await (await git()).repos()).map((r) => r.path)

// A task by its id: the user's board first, else the whole source.
async function findTask(id: string) {
  const source = await tasks()
  if (!source) return null
  const onBoard = (await source.board().catch(() => null))?.tasks.find((t) => t.id === id)
  if (onBoard) return onBoard
  return (await source.search(id).catch(() => [])).find((t) => t.id === id) ?? null
}

const ok = { ok: true as const }
const done = (found: boolean, message = 'Session terminée') => {
  if (!found) throw new SessionError(message, 404)
  return ok
}

// Taken from quack-board (ClaudesController, Simon's): the Claude sessions run by the Agent SDK, their conversation,
// their decisions, their settings, and what the page shows beside them.
export default class SessionsController {
  // Whether the sessions are on, and the Claude Code they run (on Windows, the one of WSL's default distro).
  async status() {
    const on = (await settings()).enabled
    return { enabled: on, places: on ? await detect() : [] }
  }

  // The repos the app knows, with what the module's settings say of each.
  async repos() {
    const s = await settings()
    const repos = await (await git()).repos()
    return { repos: repos.map((r) => ({ path: r.path, label: r.label, ...s.repos[r.path] })) }
  }

  async index() {
    await enabled()
    return { sessions: await sessions.list(await repoPaths()) }
  }

  // A session only works on repos the app knows, never in an arbitrary folder; the task's branches in them get their
  // worktrees before Claude's first message.
  async start({ request }: HttpContext) {
    await enabled()
    const { prompt, mode, model, effort, resume, taskId, cwd, images, files, ...asked } = await request.validateUsing(startValidator)
    const known = await repoPaths()
    if (asked.repos.some((r) => !known.includes(r))) throw new SessionError('Dépôt inconnu', 404)
    const ofTask = taskId && !resume ? await (await git()).branchesOf(taskId) : []
    // None chosen: the repos of the task's branches, else every repo the app knows.
    const repos = asked.repos.length ? asked.repos : ofTask.length ? [...new Set(ofTask.map((b) => b.repo))] : known
    const branches = ofTask.filter((b) => repos.includes(b.repo))
    // The next new session starts with the same model and effort, even after the app restarts. Not the mode: it is a
    // setting of its own, and a session started in Plan mode once must not change it.
    if (!resume) {
      await ctx.settings.set('lunar-industries-claude.defaultModel', model ?? '')
      await ctx.settings.set('lunar-industries-claude.defaultEffort', effort ?? '')
    }
    const id = await sessions.start({
      repos,
      prompt,
      mode,
      model,
      effort,
      resume,
      taskId,
      cwd: resume ? cwd : undefined,
      worktrees: branches.map((b) => ({ repo: b.repo, branch: b.name })),
      attached: { images, files },
    })
    return { id }
  }

  // What the page shows beside the conversation: the task, the worktrees and their changed files, where Claude Code
  // runs, the executable slot, what the turns cost.
  async context({ params, request }: HttpContext): Promise<SessionContext> {
    await enabled()
    const { cwd: folder } = await request.validateUsing(contextValidator)
    const row = await store.find(params.id)
    // A session of the terminal has no row until a task is attached to it: the panel still shows what can be known.
    if (!row) {
      if (!folder) throw new SessionError('Session inconnue', 404)
      const where = await placeOf(folder).catch(() => null)
      return {
        id: params.id,
        cwd: folder,
        task: null,
        repos: [],
        worktrees: [],
        where: where?.wsl ? `WSL (${where.wsl.distro})` : 'Ce poste',
        login: null,
        slot: [],
        costUsd: null,
        turns: null,
        // Read back from the transcript: tokens only, since it holds no dollars.
        usage: usageRows(await sessions.tokensOf(params.id, folder), false),
      }
    }
    const kept = usageRows(row.usage, true)
    const s = await settings()
    const g = await git()
    const task = row.taskId ? await findTask(row.taskId) : null
    // Claude may add a worktree in a repo the session was not started on: any repo the app knows.
    const known = await g.repos()
    const repos = known.filter((r) => row.repos.includes(r.path))
    const worktrees = await Promise.all(
      row.worktrees.map(async (path) => {
        const repo = known.find((r) => path.startsWith(join(r.path, WORKTREES_DIR) + sep))
        const branch = repo ? path.slice(join(repo.path, WORKTREES_DIR).length + 1) : basename(path)
        const base = repo ? await baseOf(g, repo.path, reviewTargetOf(s, repo.path)).catch(() => '') : ''
        const files = base ? await changedFiles(g, path, base).catch(() => []) : []
        return { path, repo: repo?.label ?? null, branch, files }
      })
    )
    const place = await placeOf(row.cwd).catch(() => null)
    // The executable slot of the session's repos, held by this session or another.
    const pid = await pidOfSession(place?.configDir ?? localConfigDir(), row.id)
    const locks = await lockStatus(lockHost(row.cwd, place?.wsl?.home), repos.map((r) => lockName(r.path))).catch(() => [])
    return {
      id: row.id,
      cwd: row.cwd,
      task: task ? { id: task.id, ref: task.ref, title: task.title, status: task.status, url: task.url } : null,
      repos: repos.map((r) => ({ label: r.label, path: r.path })),
      worktrees,
      where: place?.wsl ? `WSL (${place.wsl.distro})` : 'Ce poste',
      // What the session is telling now, else what its last turn left on its row.
      login: sessions.loginOf(row.id) ?? row.login,
      slot: locks.map((l) => ({ repo: l.repo, session: l.session, alive: l.alive, mine: pid !== null && l.pid === pid })),
      costUsd: sessions.costOf(row.id) ?? row.costUsd,
      turns: row.turns,
      // What the session's turns reported, else the tokens read back from its transcript, without dollars.
      usage: kept.length ? kept : usageRows(await sessions.tokensOf(row.id, row.cwd), false),
    }
  }

  // The first messages the new session window offers, from the skills loaded.
  async templates() {
    await enabled()
    return { templates: await sessions.templates() }
  }

  // The models the session windows offer, with their effort levels.
  async models() {
    await enabled()
    return { models: await sessions.models(await repoPaths()) }
  }

  async events({ params, request }: HttpContext) {
    await enabled()
    const { after, cwd } = await request.validateUsing(eventsValidator)
    const data = await sessions.eventsOf(params.id, after ?? 0, cwd)
    if (!data) throw new SessionError('Session inconnue', 404)
    return data
  }

  async send({ params, request }: HttpContext) {
    await enabled()
    const { text = '', ...attached } = await request.validateUsing(messageValidator)
    if (!text && !attached.images?.length && !attached.files?.length) throw new SessionError('Message vide', 422)
    return done(sessions.send(params.id, text, attached))
  }

  async decide({ params, request }: HttpContext) {
    await enabled()
    const decision = await request.validateUsing(decisionValidator)
    return done(sessions.decide(params.id, params.request, decision), 'Demande déjà traitée')
  }

  async mode({ params, request }: HttpContext) {
    await enabled()
    const { mode } = await request.validateUsing(modeValidator)
    return done(await sessions.setMode(params.id, mode))
  }

  async model({ params, request }: HttpContext) {
    await enabled()
    const { model } = await request.validateUsing(modelValidator)
    return done(await sessions.setModel(params.id, model))
  }

  async effort({ params, request }: HttpContext) {
    await enabled()
    const { effort } = await request.validateUsing(effortValidator)
    return done(await sessions.setEffort(params.id, effort))
  }

  async archive({ params, request }: HttpContext) {
    await enabled()
    const { archived } = await request.validateUsing(archiveValidator)
    if (!(await sessions.setArchived(params.id, archived))) throw new SessionError('Arrêtez la session avant de l’archiver')
    return ok
  }

  // Attaches a task to a session after the fact, or takes it off: a session of the terminal has none, and one started
  // from the app may have been launched without.
  async task({ params, request }: HttpContext) {
    await enabled()
    const { taskId, cwd } = await request.validateUsing(taskValidator)
    if (taskId && !(await findTask(taskId))) throw new SessionError('Tâche inconnue', 404)
    return done(await sessions.setTask(params.id, taskId, cwd), 'Session inconnue')
  }

  async interrupt({ params }: HttpContext) {
    await enabled()
    return done(await sessions.interrupt(params.id))
  }

  async stop({ params }: HttpContext) {
    await enabled()
    return done(sessions.stop(params.id), 'Session inconnue')
  }

  // A session of the terminal shown on the page: its transcript is read again while the page renews this.
  async watch({ params, request }: HttpContext) {
    await enabled()
    const { cwd } = await request.validateUsing(watchValidator)
    sessions.watch(params.id, cwd)
    return ok
  }

  async unwatch({ params }: HttpContext) {
    sessions.unwatch(params.id)
    return ok
  }
}
