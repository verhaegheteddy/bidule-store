import type { Task } from '@bidule/sdk'
import type { ForgeKind, ListedBranch, Listing } from '../contract.ts'

// Taken from quack-board (Simon's pages/branches/branches.ts): where a branch stands among its four steps (linked to
// a task, under review, CI, merged), what the list says of it, and the list itself, by repo.

export type Step = 'task' | 'review' | 'ci' | 'merge' | 'done'
export const STEPS: { id: Exclude<Step, 'done'>; label: string }[] = [
  { id: 'task', label: 'Tâche' },
  { id: 'review', label: 'Revue' },
  { id: 'ci', label: 'CI' },
  { id: 'merge', label: 'Fusion' },
]
export type StepState = 'done' | 'current' | 'todo'

export const REVIEW: Record<ForgeKind, string> = { gitlab: 'MR', github: 'PR' }

export function stepOf(b: ListedBranch): Step {
  if (!b.taskId) return 'task'
  if (b.reviewState === 'merged') return 'done'
  if (!b.forge || !b.reviewNumber || b.reviewState === 'closed') return 'review'
  if (b.ci === 'pending' || b.ci === 'fail') return 'ci'
  return 'merge'
}

// What the list says under a branch's name.
export function statusOf(b: ListedBranch, step: Step, review: string): string {
  if (step === 'task') return 'Sans tâche'
  if (step === 'done') return 'Fusionnée'
  if (!b.forge) return 'Liée, sans forge'
  if (step === 'review') return b.reviewState === 'closed' ? `${review} fermée` : 'À proposer'
  if (b.ci === 'fail') return 'En revue, CI en échec'
  if (b.ci === 'pending') return 'En revue, CI en cours'
  return 'Prête à fusionner'
}

export const branchKey = (b: { repo: string; name: string }) => `${b.repo}\u0000${b.name}`

// A branch with what the list and the detail show.
export function rowOf(b: ListedBranch, tasks: Task[]) {
  const review = b.forge ? REVIEW[b.forge] : 'MR'
  const step = stepOf(b)
  const reached = step === 'done' ? STEPS.length : STEPS.findIndex((s) => s.id === step)
  return {
    ...b,
    key: branchKey(b),
    task: tasks.find((t) => t.id === b.taskId) ?? null,
    review,
    reviewLabel: b.reviewNumber ? `${review} ${b.forge === 'gitlab' ? '!' : '#'}${b.reviewNumber}` : null,
    step,
    status: statusOf(b, step, review),
    // The list's progress bar: the steps done so far.
    progress: STEPS.map((_, i) => i < reached),
    steps: STEPS.map((s, i) => ({ ...s, state: (i < reached ? 'done' : i === reached ? 'current' : 'todo') as StepState })),
  }
}
export type Row = ReturnType<typeof rowOf>

/**
 * The repos as the list shows them: the branches newest first (the git role's order), the merged ones last and only
 * when asked; the repos without a working branch too. A repo without a target of its own takes the settings' one when
 * it has that branch.
 */
export function reposOf(listing: Listing, tasks: Task[], showMerged: boolean) {
  const byRepo = new Map<string, ListedBranch[]>()
  for (const b of listing.branches) byRepo.set(b.repo, [...(byRepo.get(b.repo) ?? []), b])
  const known = new Map(listing.repos.map((r) => [r.path, r]))
  for (const r of listing.repos) if (!byRepo.has(r.path)) byRepo.set(r.path, [])
  return [...byRepo].map(([path, branches]) => {
    const repo = known.get(path)
    const targets = repo?.targets ?? []
    const fallback = listing.defaultTarget
    const inherited = fallback && targets.includes(fallback) ? fallback : null
    const shown = showMerged ? branches : branches.filter((b) => b.reviewState !== 'merged')
    return {
      path,
      label: repo?.label ?? branches[0]?.repoLabel ?? path,
      target: repo?.reviewTarget ?? inherited,
      targets,
      count: branches.length,
      merged: branches.filter((b) => b.reviewState === 'merged').length,
      rows: [...shown]
        .sort((a, b) => Number(a.reviewState === 'merged') - Number(b.reviewState === 'merged'))
        .map((b) => rowOf(b, tasks)),
    }
  })
}
export type RepoView = ReturnType<typeof reposOf>[number]

// The branches to link: recent (a commit these last 14 days), without a task, not merged.
const RECENT_DAYS = 14
export const isRecent = (at: string | null, now = Date.now()) =>
  Boolean(at && now - new Date(at).getTime() < RECENT_DAYS * 864e5)
export const orphansOf = (branches: ListedBranch[], now = Date.now()) =>
  branches.filter((b) => !b.taskId && b.reviewState !== 'merged' && isRecent(b.lastCommitAt, now))

// What the mascot says on the page: a red CI first (in the mascot's own teasing words), then the branches to link.
export function hintOf(listing: Listing, tease: string | null, now = Date.now()): { line: string; mode: 'listen' | 'panic' } {
  const failing = listing.branches.find((b) => b.ci === 'fail' && b.reviewState !== 'merged')
  if (failing) return { mode: 'panic', line: tease ? `${tease} (${failing.name})` : `La CI de ${failing.name} est rouge ! On regarde ?` }
  if (!listing.branches.length) return { mode: 'listen', line: 'Je ne vois aucune branche. Vérifie le dossier des dépôts dans les Réglages.' }
  const n = orphansOf(listing.branches, now).length
  if (n) return { mode: 'listen', line: `${n} branche${n > 1 ? 's' : ''} récente${n > 1 ? 's' : ''} sans tâche. On les rattache ?` }
  return { mode: 'listen', line: 'Chaque branche a sa tâche. Coin !' }
}

export const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/**
 * The tasks a search finds (the task picker): every word in the title, the reference or a branch's name; tasks not
 * done first, 8 at most.
 */
export function findTasks(tasks: Task[], done: Set<string>, branches: ListedBranch[], query: string, max = 8): Task[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const names = new Map<string, string[]>()
  for (const b of branches) if (b.taskId) names.set(b.taskId, [...(names.get(b.taskId) ?? []), b.name])
  const found = tasks.filter((t) => {
    const text = fold(`${t.title} ${t.ref ?? ''} ${(names.get(t.id) ?? []).join(' ')}`)
    return words.every((w) => text.includes(w))
  })
  return [...found.filter((t) => !done.has(t.status)), ...found.filter((t) => done.has(t.status))].slice(0, max)
}

// « il y a 3 h »: the branch's last commit.
export function relTime(at: string | null, now = Date.now()): string {
  if (!at) return '—'
  const minutes = Math.round((now - new Date(at).getTime()) / 60_000)
  if (minutes < 60) return `il y a ${Math.max(1, minutes)} min`
  if (minutes < 24 * 60) return `il y a ${Math.round(minutes / 60)} h`
  const days = Math.round(minutes / 1440)
  return days < 30 ? `il y a ${days} j` : new Date(at).toLocaleDateString('fr-FR')
}
