import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ForgeClient, ForgeJob, GitSource } from '@bidule/ext-git/contract'
import type { Task, TaskSource } from '@bidule/sdk/tasks'
import { sdk } from './sdk.ts'
import { deployOf, issueOf, list, reviewTargetOf, slugify, templateOf, type Settings } from './settings.ts'
import { acquire, lockHost, lockName, lockStatus, pidOfSession, release } from './slot_lock.ts'
import { moveToInProgress, startTask } from './start_task.ts'
import type { SessionStore } from './store.ts'
import { addWorktree, baseOf, listWorktrees, removeWorktree, worktreePath } from './worktrees.ts'

/**
 * Taken from quack-board (services/claude_tools.ts, Simon's): the workspace's own tools, given to each Claude session
 * as the MCP server `workspace`. They run in the API, through the roles the modules share — `tasks` (the source of
 * tasks), `git` (the repos, and the forges registered with it: GitHub, GitLab). A tool that writes asks the user
 * first, whatever the session's permission mode: every write to the tasks, the forge, git or a lock is confirmed.
 */

export const SERVER = 'workspace'

// Added to the system prompt of each session that has the tools; the page never shows it.
export const TOOLS_PROMPT = `Tu travailles dans l'application Bidule (module Lunar Industries - Claude). Elle te donne ses propres outils (serveur MCP « ${SERVER} », outils mcp__${SERVER}__*) et ses skills (plugin « ${SERVER} »). Utilise-les en priorité :
- pour les tâches (lire une tâche, changer son statut, la commenter), les forges GitLab et GitHub (issue, branche, MR ou PR, pipeline, job, merge d'une MR), les worktrees, le créneau exécutable, les merges entre branches et les pushs : l'outil mcp__${SERVER}__ qui correspond, plutôt qu'un programme en ligne de commande, une requête directe à l'API d'une forge ou une commande git qui écrit (push, merge, checkout) ;
- pour un travail qu'un skill ${SERVER} décrit (de la tâche au staging, issue et MR, déploiement, commentaire au PO, changelog, worktrees) : ce skill.
Ne passe par un autre moyen que si aucun outil ni skill ne couvre le besoin, et dis-le à l'utilisateur.`

// What a tool knows of the session calling it.
export interface ToolContext {
  sessionId: string
  // The session's workspace root: where the executable slot's locks are.
  root: string
  // The session's Claude Code folder (~/.claude), as this process reaches it: its registry gives the pid holding locks.
  configDir: string
  // The home folder inside WSL, for a workspace in WSL.
  wslHome?: string
  // Asks the user; true when allowed.
  confirm(tool: string, detail: string): Promise<boolean>
  // The executable slot is held by another session (`by`): the user is told.
  slotBusy?(by: string): void
}

export interface ToolDeps {
  git: () => Promise<GitSource>
  // null without a source of tasks.
  tasks: () => Promise<TaskSource | null>
  settings: () => Promise<Settings>
  store: SessionStore
}

// A refusal Claude can act on: its message says what is wrong.
export class ToolError extends Error {}

type Shape = z.ZodRawShape

interface ToolDefinition<S extends Shape> {
  name: string
  description: string
  schema: S
  // Writes to the tasks, the forge, git or a lock: confirmed by the user first.
  write: boolean
  // What the confirmation card says the tool is about to do.
  detail?: (args: z.infer<z.ZodObject<S>>) => string
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<unknown>
}

// A tool as a session holds it: its answer to Claude is its result as JSON, or why it failed.
export interface WorkspaceTool {
  name: string
  description: string
  schema: Shape
  write: boolean
  call(given: unknown, ctx: ToolContext): Promise<{ text: string; isError: boolean }>
}

export const toolName = (t: { name: string }) => `mcp__${SERVER}__${t.name}`

function define<S extends Shape>(t: ToolDefinition<S>): WorkspaceTool {
  const schema = z.object(t.schema)
  return {
    name: t.name,
    description: t.description,
    schema: t.schema,
    write: t.write,
    async call(given, ctx) {
      try {
        const parsed = schema.safeParse(given)
        if (!parsed.success) return { text: z.prettifyError(parsed.error), isError: true }
        const args = parsed.data
        if (t.write) {
          const detail = t.detail?.(args) ?? t.name
          if (!(await ctx.confirm(toolName(t), detail))) return { text: "Refusé par l'utilisateur", isError: true }
        }
        return { text: JSON.stringify(await t.run(args, ctx), null, 2), isError: false }
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  }
}

const FAILED = new Set(['failed', 'failure', 'canceled', 'cancelled', 'timed_out'])
const WAITING = new Set(['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'scheduled', 'queued', 'in_progress', 'waiting'])

export type PipelineVerdict =
  | { state: 'waiting' }
  // The job asked waits to be played, the jobs before it have passed.
  | { state: 'ready'; job: { id: number; name: string } }
  | { state: 'done' }
  | { state: 'failed'; jobs: string[] }

// Where a pipeline stands for whoever waits on it: its end, or, for a manual job (a deployment), the moment it can be
// played and then its end.
export function pipelineVerdict(ci: string | null, jobs: { id: number; name: string; status: string }[], job?: string): PipelineVerdict {
  if (!job) {
    if (ci === 'ok') return { state: 'done' }
    if (ci === 'fail') return { state: 'failed', jobs: jobs.filter((j) => FAILED.has(j.status)).map((j) => j.name) }
    return { state: 'waiting' }
  }
  const target = jobs.find((j) => j.name === job)
  if (target && target.status === 'success') return { state: 'done' }
  const failed = jobs.filter((j) => FAILED.has(j.status)).map((j) => j.name)
  if (failed.length) return { state: 'failed', jobs: failed }
  if (target?.status === 'manual' && !jobs.some((j) => WAITING.has(j.status))) return { state: 'ready', job: { id: target.id, name: target.name } }
  return { state: 'waiting' }
}

// The text of a review opened on a branch: it closes the branch's issue and links its task.
export function reviewDescription(issueNumber: number | null, taskUrl: string | null): string {
  return [issueNumber ? `Closes #${issueNumber}` : '', taskUrl ? `Tâche : ${taskUrl}` : ''].filter(Boolean).join('\n\n')
}

export function workspaceTools(deps: ToolDeps, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): WorkspaceTool[] {
  const tasksOf = async () => {
    const tasks = await deps.tasks()
    if (!tasks) throw new ToolError('Aucune source de tâches (rôle tasks)')
    return tasks
  }

  // A task by its id or its reference (TSK-42): the user's board first, else the whole source.
  const findTask = async (key: string): Promise<Task> => {
    const wanted = key.trim()
    const tasks = await tasksOf()
    const onBoard = (await tasks.board()).tasks.find((t) => t.id === wanted || t.ref?.toLowerCase() === wanted.toLowerCase())
    if (onBoard) return onBoard
    const found = (await tasks.search(wanted)).find((t) => t.id === wanted || t.ref?.toLowerCase() === wanted.toLowerCase())
    if (!found) throw new ToolError(`Tâche inconnue : ${key}`)
    return { ...found, role: found.role ?? 'participant' }
  }

  // A repo by its path or its label (as the app lists them).
  const findRepo = async (key: string) => {
    const repo = (await (await deps.git()).repos()).find((r) => r.path === key || r.label === key)
    if (!repo) throw new ToolError(`Dépôt inconnu : ${key} (voir list_repos)`)
    return repo
  }

  const forgeOf = async (repo: { path: string; label: string }): Promise<ForgeClient> => {
    const client = await (await deps.git()).forgeOf(repo.path)
    if (!client) throw new ToolError(`${repo.label} n'a pas de remote GitHub ou GitLab, ou pas de jeton pour sa forge`)
    return client
  }

  const out = async (folder: string, args: string[], timeout?: number) => (await (await deps.git()).run(folder, args, timeout)).trim()
  const headOf = (repo: string, branch: string) => out(repo, ['rev-parse', `refs/heads/${branch}`]).catch(() => '')

  // A branch's review and pipeline, read now on its forge.
  const branchState = async (client: ForgeClient, repo: string, branch: string) => {
    const review = await client.review(branch)
    const sha = await headOf(repo, branch)
    const pipeline = sha ? await client.pipeline(sha) : null
    const jobs: ForgeJob[] = pipeline ? await client.jobs(pipeline.id) : []
    return { review, pipeline, jobs, commit: sha || null }
  }

  // The files a merge left in conflict in a folder; a merge begun and not committed yet.
  const conflictsIn = async (folder: string) => (await out(folder, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
  const merging = (folder: string) =>
    out(folder, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(
      () => true,
      () => false
    )

  // A branch's worktree in a repo, with the repo's settings: its base, the untracked files to copy, its preparation.
  const repoWorktree = async (path: string, branch: string, base?: string) => {
    const r = await findRepo(path)
    const s = await deps.settings()
    const git = await deps.git()
    const own = s.repos[r.path] ?? {}
    return addWorktree(git, r.path, branch, {
      base: base ?? (await baseOf(git, r.path, reviewTargetOf(s, r.path))),
      seed: list((own.worktreeSeed ?? '').replace(/\s+/g, ',')),
      prepare: own.worktreePrepare || null,
    })
  }

  const hostOf = (ctx: ToolContext) => lockHost(ctx.root, ctx.wslHome)
  const lockNames = async (repos: string[]) => (await Promise.all(repos.map(findRepo))).map((r) => lockName(r.path))
  // The session holds the repo's executable slot: only then may it touch the main checkout.
  const holdsSlot = async (ctx: ToolContext, repo: string) => {
    const pid = await pidOfSession(ctx.configDir, ctx.sessionId)
    if (!pid) return false
    return (await lockStatus(hostOf(ctx), [lockName(repo)])).some((l) => l.pid === pid)
  }

  const keepWorktree = async (sessionId: string, change: (paths: string[]) => string[]) => {
    const row = await deps.store.find(sessionId)
    if (!row) return
    row.worktrees = change(row.worktrees)
    await deps.store.save(row)
  }

  return [
    define({
      name: 'list_repos',
      description: 'Les dépôts git que l’application connaît : chemin, nom et branche cible des MR.',
      schema: {},
      write: false,
      run: async () => {
        const s = await deps.settings()
        return (await (await deps.git()).repos()).map((r) => ({ label: r.label, path: r.path, reviewTarget: reviewTargetOf(s, r.path) }))
      },
    }),

    define({
      name: 'read_task',
      description: 'Une tâche, par son identifiant ou sa référence (ID-101) : propriétés, branches liées, contenu de la page et commentaires.',
      schema: { task: z.string().describe('Identifiant ou référence de la tâche') },
      write: false,
      run: async ({ task }) => {
        const t = await findTask(task)
        const tasks = await tasksOf()
        const branches = await (await deps.git()).branchesOf(t.id)
        const page = tasks.page ? await tasks.page(t.id) : { text: '', comments: [] }
        return {
          id: t.id,
          ref: t.ref,
          title: t.title,
          status: t.status,
          due: t.due,
          url: t.url,
          branches: branches.map((b) => ({ repo: b.repoLabel, name: b.name, review: b.reviewRef, ci: b.ci })),
          content: page.text,
          comments: page.comments,
        }
      },
    }),

    define({
      name: 'set_task_status',
      description: 'Change le statut d’une tâche (le nom exact d’une colonne de la source).',
      schema: { task: z.string(), status: z.string() },
      write: true,
      detail: ({ task, status }) => `Passer ${task} au statut « ${status} »`,
      run: async ({ task, status }) => {
        const t = await findTask(task)
        const tasks = await tasksOf()
        const { columns } = await tasks.board()
        if (!columns.some((c) => c.name === status)) {
          throw new ToolError(`« ${status} » n'est pas un statut de la source. Statuts : ${columns.map((c) => c.name).join(', ')}`)
        }
        await tasks.move(t.id, status)
        return { ok: true, task: t.title, status }
      },
    }),

    define({
      name: 'comment_task',
      description: 'Ajoute un commentaire à la page d’une tâche.',
      schema: { task: z.string(), text: z.string().min(1) },
      write: true,
      detail: ({ task, text }) => `Commenter ${task} :\n${text}`,
      run: async ({ task, text }) => {
        const t = await findTask(task)
        const tasks = await tasksOf()
        if (!tasks.comment) throw new ToolError('La source de tâches ne prend pas de commentaires')
        await tasks.comment(t.id, text)
        return { ok: true, task: t.title }
      },
    }),

    define({
      name: 'start_task',
      description:
        'Démarre une tâche dans un ou plusieurs dépôts : issue si besoin, branche sur la forge, MR en brouillon, branche locale (sans changer la branche du checkout principal), liaison à la tâche.',
      schema: {
        task: z.string(),
        repos: z
          .array(z.object({ repo: z.string().describe('Chemin ou nom du dépôt'), base: z.string().optional().describe('Branche de départ et cible de la MR') }))
          .min(1),
        slug: z.string().optional().describe('Titre court de la branche ; par défaut, celui de la tâche'),
        issue: z.boolean().default(false),
        review: z.boolean().default(true),
        inProgress: z.boolean().default(true).describe('Passer la tâche au premier statut « en cours »'),
      },
      write: true,
      detail: ({ task, repos }) => `Démarrer ${task} dans ${repos.map((r) => r.repo).join(', ')} (issue, branche, MR brouillon)`,
      run: async ({ task, repos, slug, issue, review, inProgress }) => {
        const t = await findTask(task)
        const s = await deps.settings()
        const git = await deps.git()
        const targets = []
        for (const r of repos) {
          const repo = await findRepo(r.repo)
          targets.push({ path: repo.path, label: repo.label, base: r.base ?? (await baseOf(git, repo.path, reviewTargetOf(s, repo.path))) })
        }
        const results = await startTask(
          t,
          { repos: targets, slug: slugify(slug ?? t.title), issue: issue || s.createIssue, review, checkout: 'keep', template: templateOf(s) },
          git
        )
        const status = inProgress ? await moveToInProgress(t, results, await tasksOf()) : null
        return { results, status }
      },
    }),

    define({
      name: 'worktree_add',
      description:
        'Crée (ou retrouve) le worktree d’une branche dans <dépôt>/.claude/worktrees/<branche> : la branche est reprise si elle existe, sinon créée depuis la branche d’intégration. Travailler ensuite dans ce dossier par son chemin.',
      schema: { repo: z.string(), branch: z.string(), base: z.string().optional().describe('Branche de départ d’une nouvelle branche') },
      write: true,
      detail: ({ repo, branch }) => `Créer le worktree de ${branch} dans ${repo}`,
      run: async ({ repo, branch, base }, ctx) => {
        const added = await repoWorktree(repo, branch, base)
        await keepWorktree(ctx.sessionId, (paths) => [...new Set([...paths, added.path])])
        return added
      },
    }),

    define({
      name: 'worktree_list',
      description: 'Les worktrees d’un dépôt, avec leur branche.',
      schema: { repo: z.string() },
      write: false,
      run: async ({ repo }) => listWorktrees(await deps.git(), (await findRepo(repo)).path),
    }),

    define({
      name: 'worktree_remove',
      description: 'Retire le worktree d’une branche ; la branche et ses commits restent. Refusé s’il reste des modifications non committées.',
      schema: { repo: z.string(), branch: z.string() },
      write: true,
      detail: ({ repo, branch }) => `Retirer le worktree de ${branch} dans ${repo}`,
      run: async ({ repo, branch }, ctx) => {
        const r = await findRepo(repo)
        await removeWorktree(await deps.git(), r.path, branch)
        await keepWorktree(ctx.sessionId, (paths) => paths.filter((p) => p !== worktreePath(r.path, branch)))
        return { ok: true }
      },
    }),

    define({
      name: 'slot_acquire',
      description:
        'Prend le créneau exécutable (le checkout principal, seul dossier qui fait tourner l’application) de chaque dépôt demandé, tous ou aucun. S’il est pris, dit par quelle session : continuer alors sur ce qui ne demande pas l’application, sans attendre en boucle.',
      schema: { repos: z.array(z.string()).min(1) },
      write: true,
      detail: ({ repos }) => `Prendre le créneau exécutable de ${repos.join(', ')}`,
      run: async ({ repos }, ctx) => {
        const names = await lockNames(repos)
        const pid = await pidOfSession(ctx.configDir, ctx.sessionId)
        if (!pid) throw new ToolError('Session introuvable dans le registre de Claude Code')
        const row = await deps.store.find(ctx.sessionId)
        const taken = await acquire(hostOf(ctx), names, { pid, session: row?.title ?? ctx.sessionId })
        if (!taken.ok) {
          const holder = taken.busy.alive ? taken.busy.session || `le pid ${taken.busy.pid}` : null
          ctx.slotBusy?.(holder ? `le créneau de ${taken.busy.repo}, tenu par ${holder}` : `le créneau de ${taken.busy.repo}`)
        }
        return taken
      },
    }),

    define({
      name: 'slot_release',
      description:
        'Rend le créneau exécutable des dépôts, dès que l’utilisateur a validé. Un checkout principal laissé par `slot_checkout` sur une branche détachée revient d’abord sur sa branche d’intégration.',
      schema: { repos: z.array(z.string()).min(1) },
      write: true,
      detail: ({ repos }) => `Rendre le créneau exécutable de ${repos.join(', ')}`,
      run: async ({ repos }, ctx) => {
        const restored: string[] = []
        const s = await deps.settings()
        const git = await deps.git()
        for (const key of repos) {
          const r = await findRepo(key)
          const detached = await out(r.path, ['symbolic-ref', '-q', 'HEAD']).then(
            () => false,
            () => true
          )
          if (!detached || !(await holdsSlot(ctx, r.path))) continue
          if (await out(r.path, ['status', '--porcelain'])) continue
          const base = await baseOf(git, r.path, reviewTargetOf(s, r.path))
          await out(r.path, ['switch', base])
          restored.push(`${r.label} : ${base}`)
        }
        const pid = await pidOfSession(ctx.configDir, ctx.sessionId)
        return { released: await release(hostOf(ctx), await lockNames(repos), pid ?? undefined), restored }
      },
    }),

    define({
      name: 'slot_status',
      description: 'Les créneaux exécutables pris, par quelle session, et si elle tourne encore.',
      schema: {},
      write: false,
      run: async (_args, ctx) => lockStatus(hostOf(ctx)),
    }),

    define({
      name: 'branch_state',
      description: 'L’état d’une branche sur sa forge, relu à l’instant : MR ou PR, pipeline et ses jobs (dont les jobs manuels de déploiement).',
      schema: { repo: z.string(), branch: z.string() },
      write: false,
      run: async ({ repo, branch }) => {
        const r = await findRepo(repo)
        return branchState(await forgeOf(r), r.path, branch)
      },
    }),

    define({
      name: 'create_review',
      description:
        'Ouvre la MR (GitLab) ou la PR (GitHub) d’une branche vers la branche cible du dépôt, en brouillon par défaut, avec le titre de la tâche liée et un texte qui ferme l’issue de la branche et donne le lien de la tâche. La branche doit être poussée sur origin ; sur GitHub, elle doit aussi avoir au moins un commit de plus que la cible. Committer et pousser d’abord depuis le worktree (`git -C <worktree> push -u origin <branche>`). Une MR ou PR déjà ouverte est renvoyée sans en créer une autre.',
      schema: {
        repo: z.string(),
        branch: z.string(),
        target: z.string().optional().describe('Branche cible ; par défaut, la branche cible des MR du dépôt'),
        title: z.string().optional().describe('Par défaut, le titre de la tâche liée'),
        description: z.string().optional().describe('Texte placé avant la fermeture de l’issue et le lien de la tâche'),
        draft: z.boolean().default(true),
      },
      write: true,
      detail: ({ repo, branch, target, draft }) => `Ouvrir la MR${draft ? ' brouillon' : ''} de ${branch}${target ? ` vers ${target}` : ''} dans ${repo}`,
      run: async ({ repo, branch, target, title, description, draft }) => {
        const r = await findRepo(repo)
        const s = await deps.settings()
        const into = target ?? reviewTargetOf(s, r.path)
        if (!into) throw new ToolError(`Pas de branche cible réglée pour ${r.label} : la donner dans target`)
        try {
          await out(r.path, ['fetch', 'origin', branch, into], 60_000)
        } catch {
          throw new ToolError(`${branch} ou ${into} n'est pas sur origin : pousser la branche d'abord (git -C <worktree> push -u origin ${branch})`)
        }
        const client = await forgeOf(r)
        const open = await client.review(branch)
        if (open?.state === 'open') return { created: false, review: open }
        if (client.kind === 'github' && Number(await out(r.path, ['rev-list', '--count', `origin/${into}..origin/${branch}`])) === 0) {
          throw new ToolError(`GitHub refuse une PR sans commit : ${branch} n'a aucun commit de plus que ${into} sur origin. Committer et pousser d'abord.`)
        }
        const known = (await (await deps.git()).branches()).find((b) => b.repo === r.path && b.name === branch)
        const task = known?.taskId ? await findTask(known.taskId).catch(() => null) : null
        const text = [description ?? '', reviewDescription(issueOf(templateOf(s), branch), task?.url ?? null)].filter(Boolean).join('\n\n')
        const review = await client.createReview({ source: branch, target: into, title: title ?? task?.title ?? branch, description: text, draft })
        return { created: true, review }
      },
    }),

    define({
      name: 'wait_pipeline',
      description:
        'Attend le pipeline du dernier commit d’une branche : jusqu’à sa fin, ou, avec `job` (le nom d’un job manuel de déploiement), jusqu’à ce que ce job puisse être lancé, puis jusqu’à sa fin une fois lancé. S’arrête dès qu’un job échoue. Relit la forge à intervalle croissant, sans rien afficher entre-temps.',
      schema: { repo: z.string(), branch: z.string(), job: z.string().optional(), timeoutMinutes: z.number().int().min(1).max(60).default(40) },
      write: false,
      run: async ({ repo, branch, job, timeoutMinutes }) => {
        const r = await findRepo(repo)
        const client = await forgeOf(r)
        const deadline = Date.now() + timeoutMinutes * 60_000
        let delay = 5_000
        for (;;) {
          const { pipeline, jobs, commit } = await branchState(client, r.path, branch)
          const verdict = pipeline ? pipelineVerdict(pipeline.status, jobs, job) : { state: 'waiting' as const }
          if (verdict.state !== 'waiting') return { ...verdict, pipeline: pipeline?.url ?? null, commit }
          if (Date.now() + delay > deadline) return { state: 'timeout', pipeline: pipeline?.url ?? null, jobs }
          await wait(delay)
          delay = Math.min(delay * 2, 60_000)
        }
      },
    }),

    define({
      name: 'play_job',
      description: 'Lance un job manuel du pipeline d’une branche (un déploiement, par exemple).',
      schema: { repo: z.string(), branch: z.string(), job: z.number().int() },
      write: true,
      detail: ({ repo, branch, job }) => `Lancer le job ${job} du pipeline de ${branch} (${repo})`,
      run: async ({ repo, job }) => {
        await (await forgeOf(await findRepo(repo))).playJob(job)
        return { ok: true }
      },
    }),

    define({
      name: 'merge_branch',
      description:
        'Merge une branche dans une autre (branche d’intégration, de staging ou de production), dans le worktree de la branche cible (créé s’il le faut, puis mis à jour depuis origin), jamais dans le checkout principal. Le merge n’est pas committé : lancer les vérifications du dépôt dans le worktree renvoyé, résoudre les conflits s’il y en a (en union fidèle des deux côtés), puis `push_branch` committe le merge et pousse.',
      schema: { repo: z.string(), source: z.string().describe('La branche à merger'), target: z.string().describe('La branche qui la reçoit') },
      write: true,
      detail: ({ repo, source, target }) => `Merger ${source} dans ${target} (${repo})`,
      run: async ({ repo, source, target }) => {
        const r = await findRepo(repo)
        const { path } = await repoWorktree(r.path, target)
        if (await out(path, ['status', '--porcelain'])) throw new ToolError(`Le worktree de ${target} a des modifications non committées : ${path}`)
        // origin named: a local branch may have no upstream.
        await out(path, ['pull', '--ff-only', 'origin', target], 60_000)
        await out(r.path, ['fetch', 'origin', source], 60_000).catch(() => '')
        // The local branch when there is one (a work branch not pushed yet), else origin's.
        const local = await out(r.path, ['show-ref', '--verify', '--quiet', `refs/heads/${source}`]).then(
          () => true,
          () => false
        )
        const from = local ? source : `origin/${source}`
        const merged = await out(path, ['merge', '--no-ff', '--no-commit', from], 60_000).then(
          (text) => text,
          () => null
        )
        const conflicts = await conflictsIn(path)
        if (merged === null && !conflicts.length) throw new ToolError(`git refuse de merger ${from} dans ${target}`)
        if (!(await merging(path))) return { worktree: path, merged: false, detail: `${target} contient déjà ${source}` }
        return { worktree: path, merged: true, from, conflicts }
      },
    }),

    define({
      name: 'push_branch',
      description:
        'Pousse une branche sur origin. Si son worktree porte un merge commencé par `merge_branch`, il est d’abord committé (refusé tant qu’il reste des conflits). Refusé s’il reste des modifications non committées dans le worktree.',
      schema: { repo: z.string(), branch: z.string() },
      write: true,
      detail: ({ repo, branch }) => `Pousser ${branch} sur origin (${repo})`,
      run: async ({ repo, branch }) => {
        const r = await findRepo(repo)
        const path = worktreePath(r.path, branch)
        const hasWorktree = await out(path, ['rev-parse', '--git-dir']).then(
          () => true,
          () => false
        )
        let committedMerge = false
        if (hasWorktree) {
          if (await merging(path)) {
            const conflicts = await conflictsIn(path)
            if (conflicts.length) throw new ToolError(`Conflits à résoudre d’abord : ${conflicts.join(', ')}`)
            await out(path, ['commit', '--no-edit'])
            committedMerge = true
          }
          const changes = await out(path, ['status', '--porcelain'])
          if (changes) throw new ToolError(`Modifications non committées dans ${path} :\n${changes}`)
        }
        await out(r.path, ['push', '-u', 'origin', branch], 120_000)
        return { pushed: branch, commit: await headOf(r.path, branch), committedMerge }
      },
    }),

    define({
      name: 'merge_review',
      description:
        'Accepte la MR (GitLab) ou la PR (GitHub) ouverte d’une branche : la merge sur la forge, comme son bouton. Une MR en brouillon est refusée, sauf avec `ready: true`, qui la sort d’abord du brouillon.',
      schema: { repo: z.string(), branch: z.string(), ready: z.boolean().default(false).describe('Sortir la MR du brouillon avant de la merger') },
      write: true,
      detail: ({ repo, branch, ready }) => `Merger la MR de ${branch} sur la forge (${repo})${ready ? ', sortie du brouillon' : ''}`,
      run: async ({ repo, branch, ready }) => {
        const client = await forgeOf(await findRepo(repo))
        const review = await client.review(branch)
        if (!review || review.state !== 'open') throw new ToolError(`${branch} n'a pas de MR ouverte (voir create_review)`)
        if (review.draft && !ready) throw new ToolError(`La MR ${review.url} est en brouillon : la sortir du brouillon avec ready: true`)
        if (review.draft) await client.markReady(review.number)
        await client.mergeReview(review.number)
        return { merged: review.url }
      },
    }),

    define({
      name: 'slot_checkout',
      description:
        'Sort une branche dans le checkout principal d’un dépôt, pour que l’utilisateur la teste dans l’application. Demande que la session tienne le créneau exécutable du dépôt (`slot_acquire`) et que le checkout principal n’ait pas de modifications. La branche y est sortie à son dernier commit (HEAD détaché, puisqu’elle a son worktree) : relancer l’outil après un nouveau commit. `slot_release` remet ensuite le checkout principal sur sa branche d’intégration.',
      schema: { repo: z.string(), branch: z.string() },
      write: true,
      detail: ({ repo, branch }) => `Sortir ${branch} dans le checkout principal de ${repo}`,
      run: async ({ repo, branch }, ctx) => {
        const r = await findRepo(repo)
        if (!(await holdsSlot(ctx, r.path))) throw new ToolError(`La session ne tient pas le créneau de ${r.label} : slot_acquire`)
        if (await out(r.path, ['status', '--porcelain'])) throw new ToolError(`Le checkout principal de ${r.label} a des modifications`)
        await out(r.path, ['switch', '--detach', branch])
        return { checkedOut: branch, commit: await out(r.path, ['rev-parse', 'HEAD']) }
      },
    }),

    define({
      name: 'workspace_settings',
      description:
        'Les réglages utiles au travail : nommage des branches, et pour chaque dépôt sa branche cible des MR et son déploiement (branches de staging et de production, jobs de déploiement dont le `{env}` est l’environnement, environnements de staging et celui par défaut, statut d’une tâche en test). Une valeur null n’est pas réglée : la demander.',
      schema: {},
      write: false,
      run: async () => {
        const s = await deps.settings()
        const repos = await (await deps.git()).repos()
        return {
          branchNaming: s.branchNaming,
          branchTemplate: templateOf(s),
          createIssue: s.createIssue,
          integrationBranches: s.integrationBranches,
          repos: repos.map((r) => ({ repo: r.label, path: r.path, reviewTarget: reviewTargetOf(s, r.path), deploy: deployOf(s, r.path) })),
        }
      },
    }),
  ]
}

// The MCP server of a session: the tools, bound to the session that calls them. Always in Claude's prompt, never
// deferred behind its tool search; those that only read say so, which the Plan mode needs.
export function workspaceServer(tools: WorkspaceTool[], ctx: ToolContext) {
  const { createSdkMcpServer, tool } = sdk()
  return createSdkMcpServer({
    name: SERVER,
    alwaysLoad: true,
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.schema,
        async (args) => {
          const { text, isError } = await t.call(args, ctx)
          return { content: [{ type: 'text' as const, text }], isError }
        },
        { annotations: { readOnlyHint: !t.write } }
      )
    ),
  })
}

// Where a session's Claude Code keeps its registry, when it runs on this machine.
export const localConfigDir = () => join(homedir(), '.claude')
