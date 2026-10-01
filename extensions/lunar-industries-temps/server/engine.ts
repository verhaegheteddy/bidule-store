import type { TaskGroup } from '@bidule/sdk/tasks'

/**
 * Taken from quack-board (domain/engine.ts, Simon's): what the user's activity proposes for a day. A day is worth 1,
 * split into twentieths; each piece of activity goes to a line (a task, a branch linked to no task, the default
 * branch, production), and the lines share the day out in proportion to the time their activity covers. Pure: the
 * events and the branches come from the roles (git, tasks), read by days.ts.
 */

// All day arithmetic uses the machine's local time zone, in minutes since local midnight.
const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function dayStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export function addDays(day: string, n: number): string {
  const d = dayStart(day)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}
export const minuteOf = (iso: string) => {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}
// The local day an instant falls on.
export const localDay = (iso: string) => dayKey(new Date(iso))

// A day is worth 1, split into twentieths (0.05).
export const DAY_SHARES = 20

// Only used to weigh the day's lines against each other, never as durations (see reconstruct): a silence longer than
// MAX_GAP minutes is a real break, and an activity followed by one weighs TAIL minutes.
const MAX_GAP = 45
const TAIL = 15

/**
 * Which line of the day a piece of activity belongs to: a task (`t:<id>`), a git branch linked to no task
 * (`b:<repo>\0<branch>`), commits straight on a default branch, whatever the repo (`main`), or commits on a
 * production branch (`deploy`).
 */
export type LineKey = string
export const taskKey = (taskId: string) => `t:${taskId}`
export const branchKey = (repo: string, branch: string) => `b:${repo}\u0000${branch}`
export const MAIN_KEY = 'main'
export const DEPLOY_KEY = 'deploy'

/**
 * One signal of the user's work: from git (a checkout, a commit — `detail` its subject —, a branch created by the
 * app, files edited and not committed yet), or from the source of tasks (an edit of a task, a change of its status).
 * `taskId`: the task a git event's branch is linked to (kept once the branch is deleted), or the task edited.
 */
export interface WorkEvent {
  at: string
  kind: 'checkout' | 'commit' | 'branch' | 'edit' | 'task' | 'status'
  repo: string | null
  branch: string | null
  detail: string
  taskId: string | null
  // A status change: the group it went to (`doing` opens the task's activity).
  toGroup?: TaskGroup | null
}

export interface BranchInfo {
  taskId: string | null
  isDefault: boolean
}
export const placeKey = (repo: string, branch: string) => `${repo}\u0000${branch}`

// Lower-cased branch names; production ones are integration ones too.
export interface Integration {
  branches: Set<string>
  production: Set<string>
}

export function integrationOf(integration: string[], production: string[]): Integration {
  const names = (list: string[]) => new Set(list.map((n) => n.toLowerCase()))
  const prod = names(production)
  return { branches: new Set([...names(integration), ...prod]), production: prod }
}

// Git's and GitLab's merge messages: « Merge branch 'x' into factory », « … into 'factory' ».
const MERGED = /Merge branch '([^']+)'/

// One line of the proposal. `weight` only compares the lines with each other: it is never shown as a duration.
export interface Activity {
  key: LineKey
  taskId: string | null
  repo: string | null
  branch: string | null
  weight: number
  reason: string
}

interface Span {
  key: LineKey
  first: number
  last: number
}

interface Tally {
  taskId: string | null
  repo: string | null
  branch: string | null
  places: Set<string>
  checkouts: number
  commits: number
  edits: number
  files: number
  moves: number
  intervals: [number, number][]
}

// The branch an event happened on: the one git knows now, else (deleted since) the task the event kept.
function branchOf(e: WorkEvent, branches: Map<string, BranchInfo>): BranchInfo | undefined {
  if (!e.repo || !e.branch) return undefined
  return branches.get(placeKey(e.repo, e.branch)) ?? (e.taskId ? { taskId: e.taskId, isDefault: false } : undefined)
}

// The line an event belongs to, or null when it says nothing about the work (a checkout back to the default branch).
export function lineOf(e: WorkEvent, branches: Map<string, BranchInfo>, integration: Integration): LineKey | null {
  if (e.kind === 'task' || e.kind === 'status') return e.taskId ? taskKey(e.taskId) : null
  if (!e.repo || !e.branch) return null
  // Not a branch: a commit git reached only through a tag or the stash (`git log --all --source`) belongs to none.
  if (e.branch.startsWith('refs/')) return null
  const b = branchOf(e, branches)
  const name = e.branch.toLowerCase()
  const switched = e.kind === 'checkout' || e.kind === 'branch'
  // Feature branches start from an integration branch: checking one out deploys nothing.
  if (switched && (!b || b.isDefault || integration.branches.has(name))) return null
  if (e.kind === 'commit' && integration.production.has(name)) return DEPLOY_KEY
  // A staging deployment is part of the merged task's work.
  const merged = e.kind === 'commit' ? MERGED.exec(e.detail ?? '')?.[1] : undefined
  if (merged && integration.branches.has(name)) {
    if (integration.branches.has(merged.toLowerCase())) return null
    const source = branches.get(placeKey(e.repo, merged))
    if (source?.taskId) return taskKey(source.taskId)
    return source?.isDefault ? null : branchKey(e.repo, merged)
  }
  if (b?.taskId) return taskKey(b.taskId)
  if (b?.isDefault) return MAIN_KEY
  // Commits made on an integration branch itself (a conflict fixed while merging) belong to no task.
  if (integration.branches.has(name)) return null
  return branchKey(e.repo, e.branch)
}

// The length covered by possibly overlapping intervals.
function covered(intervals: [number, number][]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let total = 0
  let end = -Infinity
  for (const [from, to] of sorted) {
    if (to <= end) continue
    total += to - Math.max(from, end)
    end = to
  }
  return total
}

export interface DayInput {
  // The day's events, in order.
  events: WorkEvent[]
  branches: Map<string, BranchInfo>
  // A repo's path → the name the user knows it by.
  repoLabel: (repo: string) => string
  integration: Integration
}

/**
 * Weighs the day's activity, one entry per line. Consecutive activity on the same line forms a span; each span
 * stretches to the next one unless the gap is a real break (> MAX_GAP minutes); on the current day the last span runs
 * until now. A task moved to the in-progress group opens its activity: from the change to the task's last signal of
 * the day, whatever the breaks. A line's weight is the time its spans cover, so a task worked on in several moments
 * still makes one line.
 */
export function reconstruct(day: string, input: DayInput, now = new Date()): Activity[] {
  const { branches, integration } = input
  const label = input.repoLabel
  const tallies = new Map<LineKey, Tally>()
  const spans: Span[] = []
  const lastOf = new Map<LineKey, number>()
  const opened: [LineKey, number][] = []
  for (const e of [...input.events].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = lineOf(e, branches, integration)
    if (!key) continue
    const t = minuteOf(e.at)
    const b = branchOf(e, branches)
    // A merge's line is the merged branch's, not the one the commit is on.
    const [repo, branch] = key.startsWith('b:') ? key.slice(2).split('\u0000') : [null, null]
    const tally = tallies.get(key) ?? {
      taskId: key.startsWith('t:') ? key.slice(2) : null,
      repo,
      branch,
      places: new Set<string>(),
      checkouts: 0,
      commits: 0,
      edits: 0,
      files: 0,
      moves: 0,
      intervals: [],
    }
    tallies.set(key, tally)
    if (e.repo && e.branch && !b?.isDefault) tally.places.add(placeKey(e.repo, e.branch))
    if (e.repo && b?.isDefault) tally.places.add(placeKey(e.repo, ''))
    if (e.kind === 'checkout' || e.kind === 'branch') tally.checkouts += 1
    if (e.kind === 'commit') tally.commits += 1
    if (e.kind === 'edit') tally.files += 1
    if (e.kind === 'task') tally.edits += 1
    if (e.kind === 'status') {
      tally.moves += 1
      if (e.toGroup === 'doing') opened.push([key, t])
    }
    lastOf.set(key, t)
    const cur = spans[spans.length - 1]
    // Staying on the same line survives a longer silence (reading, testing) than switching does.
    if (cur && cur.key === key && t - cur.last <= MAX_GAP * 2) cur.last = t
    else spans.push({ key, first: t, last: t })
  }

  const isToday = day === dayKey(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  spans.forEach((sp, i) => {
    const next = spans[i + 1]
    let end: number
    if (next) end = next.first - sp.last <= MAX_GAP ? next.first : sp.last + TAIL
    else end = isToday && nowMin - sp.last <= MAX_GAP * 2 ? Math.max(nowMin, sp.last + 5) : sp.last + TAIL
    tallies.get(sp.key)?.intervals.push([sp.first, Math.min(Math.max(end, sp.first + 5), 24 * 60)])
  })
  for (const [key, from] of opened) {
    const to = Math.max(lastOf.get(key) ?? from, from + TAIL)
    tallies.get(key)?.intervals.push([from, Math.min(to, 24 * 60)])
  }

  return [...tallies.entries()].map(([key, t]) => {
    const places = [...t.places].map((p) => p.split('\u0000'))
    const repos = [...new Set(places.map((p) => label(p[0])))]
    const parts: string[] = []
    if (t.moves) parts.push(t.moves > 1 ? `${t.moves} changements de statut` : 'un changement de statut')
    if (t.checkouts) parts.push(t.checkouts > 1 ? `${t.checkouts} checkouts` : 'un checkout')
    if (t.commits) parts.push(t.commits > 1 ? `${t.commits} commits` : 'un commit')
    if (t.files) parts.push(t.files > 1 ? `${t.files} fichiers modifiés` : 'un fichier modifié')
    if (t.edits) parts.push(t.edits > 1 ? `${t.edits} modifications de la tâche` : 'une modification de la tâche')
    if (key === MAIN_KEY) parts.push(`sur la branche par défaut de ${repos.slice(0, 3).join(', ')}`)
    else if (key === DEPLOY_KEY) parts.push(`en production sur ${repos.slice(0, 3).join(', ')}`)
    else if (!t.taskId && t.branch && t.repo) parts.push(`sur ${t.branch} (${label(t.repo)}), une branche liée à aucune tâche`)
    return { key, taskId: t.taskId, repo: t.repo, branch: t.branch, weight: covered(t.intervals), reason: parts.join(', ') + '.' }
  })
}

/**
 * Splits a day (20 twentieths) in proportion to the weights, by the largest remainder method: each line gets the
 * whole part of its share, then the twentieths left go to the largest remainders. The total is always 20, unless
 * every weight is 0 (nothing to split: the user shares the day out).
 */
export function proposeShares(weights: number[], total = DAY_SHARES): number[] {
  const sum = weights.reduce((a, w) => a + w, 0)
  if (sum <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (w / sum) * total)
  const shares = exact.map(Math.floor)
  const left = total - shares.reduce((a, n) => a + n, 0)
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x), weight: weights[i] }))
    .sort((a, b) => b.rest - a.rest || b.weight - a.weight || a.i - b.i)
  for (let k = 0; k < left; k++) shares[order[k].i] += 1
  return shares
}
