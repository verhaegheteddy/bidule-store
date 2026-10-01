import type { GitBranch, GitSource } from '@bidule/ext-git/contract'
import type { BranchRef, Branches, KanbanBranch } from '../contract.ts'
import { KanbanError } from './errors.ts'

const keyOf = (b: BranchRef) => `${b.repo}\u0000${b.name}`

const shown = (b: GitBranch): KanbanBranch => ({
  repo: b.repo,
  repoLabel: b.repoLabel,
  name: b.name,
  taskId: b.taskId,
  isDefault: b.isDefault,
  lastCommitAt: b.lastCommitAt,
  reviewNumber: b.reviewNumber,
  reviewRef: b.reviewRef,
  reviewState: b.reviewState,
  ci: b.ci,
})

/**
 * Taken from quack-board (Simon's board_controller, setBranches; forge links): the cards' branches, through the `git`
 * role. `git` is null when nobody holds the role: the board then shows no branch at all.
 */
export class KanbanService {
  constructor(protected git: () => Promise<GitSource | null>) {}

  async #git(): Promise<GitSource> {
    const git = await this.git()
    if (!git) throw new KanbanError('Aucun dépôt git : le rôle git n’est tenu par aucune extension', 409)
    return git
  }

  // Every branch git knows but the repos' default ones (main…), which belong to no task.
  async branches(): Promise<Branches> {
    const git = await this.git()
    if (!git) return { available: false, branches: [] }
    return { available: true, branches: (await git.branches()).filter((b) => !b.isDefault).map(shown) }
  }

  /**
   * The task's branches are exactly these now: the others it had are unlinked, the new ones linked (taken from
   * another task if need be). An unknown branch changes nothing.
   */
  async setBranches(taskId: string, wanted: BranchRef[]): Promise<Branches> {
    const git = await this.#git()
    const all = await git.branches()
    const known = new Set(all.map(keyOf))
    const missing = wanted.find((b) => !known.has(keyOf(b)))
    if (missing) throw new KanbanError(`Branche inconnue : ${missing.name}`, 404)
    const keep = new Set(wanted.map(keyOf))
    for (const b of all.filter((b) => b.taskId === taskId && !keep.has(keyOf(b)))) await git.link(b.repo, b.name, null)
    for (const b of wanted) {
      const current = all.find((x) => keyOf(x) === keyOf(b))
      if (current?.taskId !== taskId) await git.link(b.repo, b.name, taskId)
    }
    return this.branches()
  }

  // Where a mark of a card leads: the branch's review on its forge, else its pipeline; null when neither is known.
  async reviewUrl(ref: BranchRef): Promise<string | null> {
    const git = await this.#git()
    const forge = await git.forgeOf(ref.repo)
    if (!forge) return null
    const review = await forge.review(ref.name)
    if (review) return review.url
    const sha = (await git.branches()).find((b) => keyOf(b) === keyOf(ref))?.headSha
    return sha ? ((await forge.pipeline(sha))?.url ?? null) : null
  }
}
