import type { ForgeFailure, GitSource } from '@bidule/ext-git/contract'
import type { Task, TaskSource } from '@bidule/sdk/tasks'
import { branchName } from './settings.ts'

/**
 * Taken from quack-board (domain/start_task.ts, Simon's): starts a task in each repo, through the repo's forge (the
 * git role's `forgeOf`): its issue when needed, its branch on the forge, a draft review, the branch fetched locally,
 * then linked to the task. A failed step stops that repo and says why; nothing already created on the forge is
 * undone.
 */

export type StartInput = {
  // Each repo by its absolute path, with the branch to start from, which is also the review's target.
  repos: { path: string; label: string; base: string }[]
  slug: string
  // Asked for; the template may require one anyway.
  issue: boolean
  review: boolean
  // 'switch' checks the new branch out; 'keep' leaves the working tree as it is.
  checkout: 'keep' | 'switch'
  template: string
}

// `skipped`: a step asked for but left out, which does not stop the ones after it.
export type StartStep = { step: string; ok: boolean; detail: string; skipped?: boolean }
export type StartResult = { repo: string; label: string; branch: string | null; steps: StartStep[] }

class StepFailed extends Error {}

// A forge's refusal in its own words; for git, its last line rather than the command line.
const shortError = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).trim().split('\n').filter(Boolean).at(-1) ?? ''

// The review's and the issue's text link the task, as the issues written by hand do.
const taskLine = (task: Task) =>
  [`Tâche : ${task.ref ? `${task.ref} — ` : ''}${task.title}`, task.url ?? ''].filter(Boolean).join('\n')

export async function startTask(task: Task, input: StartInput, git: GitSource): Promise<StartResult[]> {
  const results: StartResult[] = []
  for (const { path, label, base } of input.repos) {
    const result: StartResult = { repo: path, label, branch: null, steps: [] }
    results.push(result)
    try {
      const client = await git.forgeOf(path)
      if (!client) {
        result.steps.push({ step: 'Forge', ok: false, detail: 'Pas de remote GitHub ou GitLab joignable, ou pas de jeton' })
        continue
      }
      const step = async <T>(name: string, run: () => Promise<T>, done: (v: T) => string) => {
        try {
          const value = await run()
          result.steps.push({ step: name, ok: true, detail: done(value) })
          return value
        } catch (err) {
          result.steps.push({ step: name, ok: false, detail: shortError(err as ForgeFailure) })
          throw new StepFailed()
        }
      }
      const needsIssue = input.issue || input.template.includes('{issue}')
      const issue = needsIssue
        ? await step('Issue', () => client.createIssue({ title: task.title, description: taskLine(task) }), (i) => `#${i.number}`)
        : null
      if (input.template.includes('{ref}') && !task.ref) {
        result.steps.push({ step: 'Nom', ok: false, detail: 'La tâche n’a pas de référence' })
        continue
      }
      const name = branchName(input.template, { issue: issue?.number, ref: task.ref, slug: input.slug })
      result.branch = name
      await step('Branche distante', () => client.createBranch(name, base), () => name)
      if (input.review && client.kind === 'github') {
        // GitHub refuses a pull request without commits (422), and the new branch is its base's commit.
        result.steps.push({
          step: 'MR brouillon',
          ok: true,
          skipped: true,
          detail: 'GitHub refuse une PR sans commit : à créer après un premier push (create_review)',
        })
      } else if (input.review) {
        const description = [issue ? `Closes #${issue.number}` : '', taskLine(task)].filter(Boolean).join('\n\n')
        await step(
          'MR brouillon',
          () => client.createReview({ source: name, target: base, title: task.title, description, draft: true }),
          (r) => `${client.kind === 'gitlab' ? '!' : '#'}${r.number} vers ${base}`
        )
      }
      await step(
        'Branche locale',
        async () => {
          await git.run(path, ['fetch', 'origin', name], 60_000)
          const args = input.checkout === 'switch' ? ['switch', '--track', `origin/${name}`] : ['branch', '--track', name, `origin/${name}`]
          await git.run(path, args)
        },
        () => (input.checkout === 'switch' ? 'créée, et le dépôt est dessus' : 'créée')
      )
      // Read back so the branch is there, then linked by hand to the task.
      await git.sync().catch(() => undefined)
      await git.link(path, name, task.id)
      result.steps.push({ step: 'Liaison', ok: true, detail: task.title })
    } catch (err) {
      if (!(err instanceof StepFailed)) throw err
    }
  }
  return results
}

/**
 * Once a repo is started (its branch linked), a task still to do moves to the source's first in-progress column, as
 * dragging its card would. null when nothing is to change.
 */
export async function moveToInProgress(task: Task, results: StartResult[], tasks: TaskSource): Promise<StartStep | null> {
  const started = results.some((r) => r.steps.some((s) => s.step === 'Liaison' && s.ok))
  if (!started) return null
  const step = 'Statut'
  try {
    const { columns } = await tasks.board()
    if (columns.find((c) => c.name === task.status)?.group !== 'todo') return null
    const column = columns.find((c) => c.group === 'doing')
    if (!column) return null
    await tasks.move(task.id, column.name)
    return { step, ok: true, detail: column.name }
  } catch (err) {
    return { step, ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
