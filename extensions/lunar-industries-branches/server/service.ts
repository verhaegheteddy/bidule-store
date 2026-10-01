import type { ForgeClient, GitBranch, GitSource } from '@bidule/ext-git/contract'
import type { TaskSource } from '@bidule/sdk/tasks'
import type { Job, Links, ListedRepo, Listing } from '../contract.ts'
import { BranchesError } from './errors.ts'
import { issueOf, list, reviewDescription, templateOf } from './names.ts'

const K = 'lunar-industries-branches'

export interface BranchesDeps {
  git: () => Promise<GitSource>
  // null without a source of tasks.
  tasks: () => Promise<TaskSource | null>
  setting: (key: string) => Promise<unknown>
  save: (key: string, value: string) => Promise<void>
  // A repo's review target changed.
  changed: () => void
}

// A forge's refusal (ForgeFailure: an Error with the HTTP status), as the page shows it.
function refused(err: unknown): BranchesError {
  if (err instanceof BranchesError) return err
  const status = typeof err === 'object' && err !== null ? Reflect.get(err, 'status') : undefined
  const message = err instanceof Error ? err.message : String(err)
  return new BranchesError(message, typeof status === 'number' && status >= 500 ? 502 : 422)
}

function targetsOf(text: unknown): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(String(text || '{}'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && Boolean(e[1])))
  } catch {
    return {}
  }
}

/**
 * Taken from quack-board (Simon's Branches page: board_controller, forge_controller, views.reviewTargets): the user's
 * branches with their repo's forge, and what can be done on the forge for one (review, pipeline, jobs), always through
 * the `git` role and its forges.
 */
export class BranchesService {
  constructor(protected deps: BranchesDeps) {}

  async #text(key: string) {
    return String((await this.deps.setting(`${K}.${key}`)) ?? '').trim()
  }

  async #template() {
    return templateOf((await this.#text('naming')) || 'issue', (await this.#text('template')) || '{ref}-{slug}')
  }

  async #targets() {
    return targetsOf(await this.deps.setting(`${K}.targets`))
  }

  // The branches of the user's repos (newest first, the git role's order), without the default and integration ones,
  // and the repos with where their reviews can go.
  async list(): Promise<Listing> {
    const git = await this.deps.git()
    const [all, repos] = await Promise.all([git.branches(), git.repos()])
    const hidden = new Set(list(await this.#text('hidden')).map((n) => n.toLowerCase()))
    const template = await this.#template()
    const own = await this.#targets()
    const forges = new Map(
      await Promise.all(repos.map(async (r) => [r.path, (await git.forgeOf(r.path).catch(() => null))?.kind ?? null] as const))
    )
    const targets = new Map<string, string[]>()
    for (const b of all) {
      if (!b.isDefault && !hidden.has(b.name.toLowerCase())) continue
      const names = targets.get(b.repo) ?? []
      targets.set(b.repo, b.isDefault ? [b.name, ...names.filter((n) => n !== b.name)] : names.includes(b.name) ? names : [...names, b.name])
    }
    const listed: ListedRepo[] = repos
      .map((r) => ({
        path: r.path,
        label: r.label,
        forge: forges.get(r.path) ?? null,
        targets: targets.get(r.path) ?? [],
        reviewTarget: own[r.path] ?? null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'))
    return {
      branches: all
        .filter((b) => !b.isDefault && !hidden.has(b.name.toLowerCase()))
        .map((b) => ({ ...b, forge: forges.get(b.repo) ?? null, issueNumber: issueOf(template, b.name) })),
      repos: listed,
      defaultTarget: (await this.#text('reviewTarget')) || null,
    }
  }

  async #branch(repo: string, name: string): Promise<{ git: GitSource; b: GitBranch; client: ForgeClient }> {
    const git = await this.deps.git()
    const b = (await git.branches()).find((x) => x.repo === repo && x.name === name)
    if (!b) throw new BranchesError('Branche inconnue', 404)
    const client = await git.forgeOf(repo)
    if (!client) throw new BranchesError(`${b.repoLabel} n'a pas de remote GitHub ou GitLab, ou pas de jeton pour sa forge`)
    return { git, b, client }
  }

  // A write on the forge, then git read again (its review and CI follow): the page reloads on `git.changed`.
  async #act<T>(git: GitSource, work: () => Promise<T>): Promise<T> {
    let done: T
    try {
      done = await work()
    } catch (err) {
      throw refused(err)
    }
    void git.sync().catch(() => undefined)
    return done
  }

  async link(repo: string, name: string, taskId: string | null): Promise<void> {
    const git = await this.deps.git()
    if (!(await git.branches()).some((b) => b.repo === repo && b.name === name)) throw new BranchesError('Branche inconnue', 404)
    await git.link(repo, name, taskId)
  }

  // Where its review, its latest pipeline and its issue are: read on the forge now, for the branch shown.
  async links(repo: string, name: string): Promise<Links> {
    const { b, client } = await this.#branch(repo, name)
    const issueNumber = issueOf(await this.#template(), name)
    try {
      const [review, pipeline, issue] = await Promise.all([
        client.review(name),
        b.headSha ? client.pipeline(b.headSha) : null,
        issueNumber ? client.issue(issueNumber) : null,
      ])
      return { reviewUrl: review?.url ?? null, pipelineUrl: pipeline?.url ?? null, issueUrl: issue?.url ?? null }
    } catch (err) {
      throw refused(err)
    }
  }

  async jobs(repo: string, name: string): Promise<Job[]> {
    const { b, client } = await this.#branch(repo, name)
    try {
      const pipeline = b.headSha ? await client.pipeline(b.headSha) : null
      return pipeline ? await client.jobs(pipeline.id) : []
    } catch (err) {
      throw refused(err)
    }
  }

  async runPipeline(repo: string, name: string): Promise<void> {
    const { git, client } = await this.#branch(repo, name)
    await this.#act(git, () => client.runPipeline(name))
  }

  async retry(repo: string, name: string): Promise<void> {
    const { git, b, client } = await this.#branch(repo, name)
    await this.#act(git, async () => {
      const pipeline = b.headSha ? await client.pipeline(b.headSha) : null
      if (!pipeline) throw new BranchesError(`${name} n'a pas de pipeline à relancer`)
      await client.retryPipeline(pipeline.id)
    })
  }

  async play(repo: string, name: string, jobId: number): Promise<void> {
    const { git, client } = await this.#branch(repo, name)
    await this.#act(git, () => client.playJob(jobId))
  }

  // A draft review towards the target asked, else the repo's, else the settings'; titled after the branch's task.
  async review(repo: string, name: string, target: string | null): Promise<void> {
    const { git, b, client } = await this.#branch(repo, name)
    const into = target || (await this.#targets())[repo] || (await this.#text('reviewTarget')) || null
    if (!into) throw new BranchesError('Choisis la branche cible de la MR')
    const source = b.taskId ? await this.deps.tasks() : null
    const task = source && b.taskId ? ((await source.board()).tasks.find((t) => t.id === b.taskId) ?? null) : null
    const description = reviewDescription(issueOf(await this.#template(), name), task?.url ?? null)
    await this.#act(git, () =>
      client.createReview({ source: name, target: into, title: task?.title ?? name, description, draft: true })
    )
  }

  // Where the repo's reviews go by default; null to fall back on the settings'.
  async setTarget(repo: string, target: string | null): Promise<void> {
    const git = await this.deps.git()
    if (!(await git.repos()).some((r) => r.path === repo)) throw new BranchesError('Dépôt inconnu', 404)
    const own = await this.#targets()
    if (target) own[repo] = target
    else delete own[repo]
    await this.deps.save(`${K}.targets`, JSON.stringify(own))
    this.deps.changed()
  }
}
