import type { GitSource } from '@bidule/ext-git/contract'
import type { LogEntry, LogFields, LogLine, TaskSource, TimeLog } from '@bidule/sdk/tasks'
import type { DayLine, DayState, DaySummary, DayView, LineInput, Summary } from '../contract.ts'
import {
  addDays,
  branchKey,
  DAY_SHARES,
  dayKey,
  dayStart,
  DEPLOY_KEY,
  integrationOf,
  lineOf,
  localDay,
  minuteOf,
  placeKey,
  proposeShares,
  reconstruct,
  taskKey,
  type BranchInfo,
  type DayInput,
  type WorkEvent,
} from './engine.ts'
import type { TempsSettings } from './settings.ts'
import type { DraftRow, LogRow, NewDraftRow, TempsStore } from './store.ts'

/**
 * Taken from quack-board (domain/day.ts and domain/time_log.ts, Simon's): the user's days. Each day's draft follows
 * the signals until the user changes it; a day the Time Log has is shown as it is there, and « Modifier » makes it a
 * draft again. Sending writes the whole day to the Time Log (the timeLog role's sendDay), which then holds it.
 */

// Refused edits; the message is shown to the user.
export class DraftError extends Error {}

// The Time Log is mirrored as far back as git is read (35 days), and some weeks ahead (planned absences).
export const LOG_WINDOW_DAYS = 35
const LOG_AHEAD_DAYS = 60
// A period read from the Time Log is read again after this long.
const FRESH_MS = 10 * 60_000

export interface DaysDeps {
  store: TempsStore
  settings: () => Promise<TempsSettings>
  git: () => Promise<GitSource>
  // Null without a source of tasks, or without a Time Log.
  tasks: () => Promise<TaskSource | null>
  timeLog: () => Promise<TimeLog | null>
  // A day changed: whoever shows the days reloads.
  changed: () => void
  now?: () => Date
}

// The Time Log read and written a whole day at a time: its three richer methods.
type RichLog = Required<Pick<TimeLog, 'fields' | 'read' | 'sendDay'>> & TimeLog
const isRich = (log: TimeLog | null): log is RichLog =>
  Boolean(log && typeof log.fields === 'function' && typeof log.read === 'function' && typeof log.sendDay === 'function')

export const NO_RICH_LOG =
  'Le Time Log branché ne sait pas lire ni écrire une journée entière (étiquettes, absences) : il faut un provider du rôle timeLog qui le fasse, comme Notion à jour'

// 1 = Monday … 7 = Sunday, on the local date.
const isoWeekday = (day: string) => dayStart(day).getDay() || 7

const lineKeyOf = (l: { taskId: string | null; repo: string | null; branch: string | null; label: string }) =>
  l.taskId ? taskKey(l.taskId) : l.repo && l.branch ? branchKey(l.repo, l.branch) : `none:${l.label}`

// Two entries of the Time Log cannot share a task and a label; lines without a task are told apart by the branch
// they come from (they merge when sent).
const identity = (l: LineInput) => `${l.taskId ?? `${l.repo ?? ''}\u0000${l.branch ?? ''}`}\u0000${l.label}`

const toTwentieths = (share: number) => Math.round(share * DAY_SHARES)
const logRowOf = (e: LogEntry): LogRow => ({
  id: e.id,
  day: e.day,
  taskId: e.taskId,
  label: e.label ?? '',
  share: toTwentieths(e.share),
  url: e.url,
  props: e.props,
  lastEdited: e.lastEdited,
})

export class Days {
  // When each period was last read from the Time Log (`from|to`).
  #readAt = new Map<string, number>()
  // Why the Time Log could not be read last time, if it could not.
  #readProblem: string | null = null

  constructor(protected deps: DaysDeps) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  #today(): string {
    return dayKey(this.#now())
  }

  get #store() {
    return this.deps.store
  }

  // ---------- what the roles say

  // The user's signals between two days (both included), oldest first.
  async #signals(from: string, to: string): Promise<WorkEvent[]> {
    const since = dayStart(from).toISOString()
    const until = dayStart(addDays(to, 1)).toISOString()
    const git = await this.deps.git()
    const events: WorkEvent[] = (await git.events(since, until)).map((e) => ({
      at: e.at,
      kind: e.kind,
      repo: e.repo,
      branch: e.branch,
      detail: e.detail,
      taskId: e.taskId,
    }))
    const tasks = await this.deps.tasks()
    for (const e of (await tasks?.edits?.(since, until)) ?? []) {
      events.push({ at: e.at, kind: 'task', repo: null, branch: null, detail: 'Tâche modifiée', taskId: e.taskId })
    }
    for (const c of (await tasks?.statusChanges?.(since, until)) ?? []) {
      events.push({
        at: c.at,
        kind: 'status',
        repo: null,
        branch: null,
        detail: `${c.from} → ${c.to}`,
        taskId: c.taskId,
        toGroup: c.toGroup,
      })
    }
    return events.sort((a, b) => a.at.localeCompare(b.at))
  }

  async #input(day: string, s: TempsSettings): Promise<DayInput> {
    const git = await this.deps.git()
    const [branches, repos, events] = await Promise.all([git.branches(), git.repos(), this.#signals(day, day)])
    const labels = new Map(repos.map((r) => [r.path, r.label]))
    return {
      events,
      branches: new Map<string, BranchInfo>(branches.map((b) => [placeKey(b.repo, b.name), { taskId: b.taskId, isDefault: b.isDefault }])),
      repoLabel: (repo) => labels.get(repo) ?? repo,
      integration: integrationOf(s.integrationBranches, s.deployBranches),
    }
  }

  async #log(): Promise<TimeLog | null> {
    return this.deps.timeLog().catch(() => null)
  }

  // Why the day cannot be sent to the Time Log as it is, or null.
  async #logProblem(): Promise<string | null> {
    const log = await this.#log()
    if (!log) return 'Aucun Time Log branché (rôle timeLog)'
    if (!isRich(log)) return NO_RICH_LOG
    if (!(await log.configured().catch(() => false))) return `Le Time Log de ${log.name} n'est pas configuré`
    return this.#readProblem
  }

  async #fields(): Promise<LogFields> {
    const log = await this.#log()
    if (!isRich(log)) return { labels: [], extras: [] }
    return log.fields().catch(() => ({ labels: [], extras: [] }))
  }

  /**
   * Reads the user's Time Log for a period into the mirror, unless it was read lately. A period within the window
   * (35 days back, some ahead) is read as the whole window.
   */
  async readLog(from: string, to: string, force = false): Promise<void> {
    const log = await this.#log()
    if (!isRich(log) || !(await log.configured().catch(() => false))) return
    const today = this.#today()
    const start = addDays(today, -LOG_WINDOW_DAYS)
    const end = addDays(today, LOG_AHEAD_DAYS)
    const [a, b] = from >= start && to <= end ? [start, end] : [from, to]
    const key = `${a}|${b}`
    if (!force && Date.now() - (this.#readAt.get(key) ?? 0) < FRESH_MS) return
    this.#readAt.set(key, Date.now())
    try {
      const entries = await log.read(a, b)
      await this.#store.recordLog(entries.map(logRowOf), a, b)
      this.#readProblem = null
    } catch (err) {
      this.#readAt.delete(key)
      this.#readProblem = `Time Log non relu : ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // ---------- the proposal

  // One line per task (or orphan branch, or the deployments) in proportion to the activity.
  async proposal(day: string, s: TempsSettings): Promise<NewDraftRow[]> {
    const activities = reconstruct(day, await this.#input(day, s), this.#now())
    const shares = proposeShares(activities.map((a) => a.weight))
    const logged = await this.#store.lastLogged()
    const lines = activities.map((a, i): NewDraftRow => {
      const last = a.taskId ? logged.get(a.taskId) : undefined
      const deploy = a.key === DEPLOY_KEY
      return {
        taskId: a.taskId,
        repo: a.repo,
        branch: a.branch,
        label: deploy ? s.deployLabel : last?.label || s.defaultLabel,
        props: last?.props ?? {},
        share: shares[i],
        tiny: a.weight > 0 && shares[i] === 0,
        confirmed: deploy,
        reason: a.reason,
      }
    })
    return lines.sort((a, b) => b.share - a.share)
  }

  /**
   * Brings a day's draft up to date. A day the Time Log already has gets no automatic draft; a draft the user edited
   * is left alone; any other day follows the signals (the computation is deterministic).
   */
  async refreshDraft(day: string): Promise<void> {
    if (day > this.#today()) return
    if (await this.#store.edited(day)) return
    const logged = await this.#store.logged([day])
    await this.#store.writeDraft(day, logged.length ? [] : await this.proposal(day, await this.deps.settings()))
  }

  // ---------- the days' states

  // Reads once what the states of these days depend on, and gives the state of any of them.
  async stateReader(days: string[]): Promise<(day: string) => DayState> {
    const s = await this.deps.settings()
    const today = this.#today()
    const sorted = [...days].sort()
    const [logged, withDraft, editedDays, events] = await Promise.all([
      this.#store.logged(days),
      this.#store.daysWithDraft(days),
      this.#store.editedDays(days),
      this.#signals(sorted[0], sorted[sorted.length - 1]).catch((): WorkEvent[] => []),
    ])
    const active = new Set(events.map((e) => localDay(e.at)))
    return (day) => {
      const rows = logged.filter((r) => r.day === day)
      // What the Time Log has comes first, even for a day to come (a planned absence).
      if (rows.length && editedDays.has(day) && withDraft.has(day)) return 'modified'
      if (rows.length === 1 && !rows[0].taskId && rows[0].label === s.absentLabel) return 'absent'
      if (rows.length) return 'recorded'
      if (day > today) return 'future'
      if (withDraft.has(day) || active.has(day)) return 'to_validate'
      if (!s.workDays.has(isoWeekday(day))) return 'off'
      if (day < today) return 'to_fill'
      return 'empty'
    }
  }

  async dayState(day: string): Promise<DayState> {
    return (await this.stateReader([day]))(day)
  }

  // Each day with its state and its total in twentieths: the Time Log's for a recorded day, the draft's otherwise.
  async summaries(days: string[]): Promise<DaySummary[]> {
    const stateOf = await this.stateReader(days)
    const states = days.map((day) => ({ day, state: stateOf(day) }))
    const fromLog = states.filter((d) => d.state === 'recorded' || d.state === 'absent').map((d) => d.day)
    const totals = new Map(days.map((d) => [d, 0]))
    for (const r of await this.#store.logged(fromLog)) totals.set(r.day, (totals.get(r.day) ?? 0) + r.share)
    for (const day of days.filter((d) => !fromLog.includes(d))) {
      for (const r of await this.#store.drafts(day)) totals.set(day, (totals.get(day) ?? 0) + r.share)
    }
    return states.map(({ day, state }) => ({ day, state, total: totals.get(day) ?? 0 }))
  }

  // ---------- the day

  async view(day: string): Promise<DayView> {
    await this.readLog(day, day)
    await this.refreshDraft(day)
    const s = await this.deps.settings()
    const state = await this.dayState(day)
    const fromLog = state === 'recorded' || state === 'absent'
    const logged = fromLog ? await this.#store.logged([day]) : []
    const drafts = fromLog ? [] : await this.#store.drafts(day)
    const lines: DayLine[] = fromLog
      ? logged.map((r) => ({
          id: r.id,
          key: lineKeyOf({ ...r, repo: null, branch: null }),
          source: 'log',
          taskId: r.taskId,
          label: r.label,
          share: r.share,
          repo: null,
          branch: null,
          tiny: false,
          confirmed: true,
          reason: '',
          url: r.url,
          props: r.props,
        }))
      : drafts.map((d) => ({
          id: String(d.id),
          key: lineKeyOf(d),
          source: 'draft',
          taskId: d.taskId,
          label: d.label,
          share: d.share,
          repo: d.repo,
          branch: d.branch,
          tiny: d.tiny,
          confirmed: d.confirmed,
          reason: d.reason,
          url: null,
          props: d.props,
        }))
    // The day's signals, each with the line it supports: the evidence behind the proposal. What counts for nothing
    // (a checkout of an integration branch) supports no line.
    const input = await this.#input(day, s).catch(() => null)
    const signals = (input?.events ?? []).flatMap((e) => {
      const key = lineOf(e, input!.branches, input!.integration)
      if (!key) return []
      return {
        minute: minuteOf(e.at),
        kind: e.kind,
        key: key === DEPLOY_KEY ? `none:${s.deployLabel}` : key,
        repo: e.repo,
        branch: e.branch,
        detail: e.detail,
      }
    })
    const fields = await this.#fields()
    // The labels offered for a line: the Time Log's; without them, those already used, the default and absence ones.
    const used = fields.labels.length ? [] : await this.#store.usedLabels()
    const labels = [
      ...new Set([
        ...fields.labels,
        ...(fields.labels.length ? [] : [s.defaultLabel, s.absentLabel]),
        ...used,
        ...lines.map((l) => l.label),
      ]),
    ].filter(Boolean)
    return {
      day,
      isToday: day === this.#today(),
      state,
      total: lines.reduce((a, l) => a + l.share, 0),
      sentAt:
        logged
          .map((r) => r.lastEdited)
          .filter((at): at is string => Boolean(at))
          .sort()
          .at(-1) ?? null,
      lines,
      signals,
      labels,
      defaultLabel: s.defaultLabel,
      extras: fields.extras,
      logProblem: await this.#logProblem(),
    }
  }

  // ---------- the user's actions

  // « Modifier »: the day's Time Log lines become a draft the user can change and send again.
  async edit(day: string): Promise<void> {
    const logged = await this.#store.logged([day])
    await this.#store.writeDraft(
      day,
      logged.map((r) => ({ taskId: r.taskId, label: r.label, share: r.share, props: r.props, confirmed: true })),
      true
    )
    this.deps.changed()
  }

  // Drops the user's draft: the day goes back to the Time Log's lines, or to the proposal.
  async discard(day: string): Promise<void> {
    await this.#store.writeDraft(day, [], false)
    await this.refreshDraft(day)
    this.deps.changed()
  }

  // « Recalculer »: back to the proposal; on a recorded day, the proposal becomes a draft to send.
  async recompute(day: string): Promise<void> {
    const logged = await this.#store.logged([day])
    if (!logged.length) return this.discard(day)
    await this.#store.writeDraft(day, await this.proposal(day, await this.deps.settings()), true)
    this.deps.changed()
  }

  // A draft is saved whatever its total: a day must make 1 only to be sent.
  async replace(day: string, lines: LineInput[]): Promise<void> {
    const seen = new Set<string>()
    for (const l of lines) {
      const id = identity(l)
      if (seen.has(id)) throw new DraftError(`La même tâche apparaît deux fois avec l'étiquette « ${l.label} »`)
      seen.add(id)
    }
    await this.#store.writeDraft(
      day,
      lines.map((l) => ({
        taskId: l.taskId,
        label: l.label,
        share: l.share,
        repo: l.taskId ? null : (l.repo ?? null),
        branch: l.taskId ? null : (l.branch ?? null),
        confirmed: Boolean(l.confirmed),
        props: l.props ?? {},
      })),
      true
    )
    this.deps.changed()
  }

  /**
   * Settles a line without a task: attached to a task (which also links its git branch, so the other days follow), or
   * kept without a task. An attached line joins the task's line of the same label.
   */
  async resolve(day: string, id: number, change: { taskId?: string; confirmed?: boolean }): Promise<void> {
    const rows = await this.#store.drafts(day)
    const line = rows.find((r) => r.id === id)
    if (!line) throw new DraftError('Ligne inconnue')
    let next: DraftRow[] = rows
    if (change.taskId) {
      const taskId = change.taskId
      if (line.repo && line.branch) {
        const git = await this.deps.git()
        const branch = (await git.branches()).find((b) => b.repo === line.repo && b.name === line.branch)
        if (branch && !branch.isDefault && !branch.taskId) await git.link(line.repo, line.branch, taskId)
      }
      const twin = rows.find((r) => r.id !== line.id && r.taskId === taskId && r.label === line.label)
      next = twin
        ? rows.filter((r) => r.id !== line.id).map((r) => (r === twin ? { ...r, share: r.share + line.share } : r))
        : rows.map((r) => (r === line ? { ...r, taskId, repo: null, branch: null, confirmed: true } : r))
    } else if (change.confirmed) {
      next = rows.map((r) => (r === line ? { ...r, confirmed: true } : r))
    }
    await this.#store.writeDraft(day, next, true)
    this.deps.changed()
  }

  // « Absent »: the whole day becomes one line without a task, with the absence label.
  async absent(day: string): Promise<void> {
    const s = await this.deps.settings()
    await this.#store.writeDraft(day, [{ taskId: null, label: s.absentLabel, share: DAY_SHARES, confirmed: true }], true)
    this.deps.changed()
  }

  /**
   * Sends a day's draft to the Time Log: lines of the same task (or none) and label merge, lines at 0 go; the Time Log
   * rewrites the day's entry of each (task, label) and removes the day's others, then the mirror holds what it
   * answered and the draft is gone.
   */
  async send(day: string): Promise<{ written: number }> {
    const log = await this.#log()
    if (!log) throw new DraftError('Aucun Time Log branché (rôle timeLog)')
    if (!isRich(log)) throw new DraftError(NO_RICH_LOG)
    if (!(await log.configured())) throw new DraftError(`Le Time Log de ${log.name} n'est pas configuré`)
    const drafts = await this.#store.drafts(day)
    const total = drafts.reduce((a, d) => a + d.share, 0)
    if (total !== DAY_SHARES) throw new DraftError(`La journée doit valoir 1 (${String(total / DAY_SHARES).replace('.', ',')})`)
    if (drafts.some((d) => !d.taskId && d.branch && !d.confirmed)) {
      throw new DraftError('Une branche sans tâche reste à rattacher ou à garder sans tâche')
    }
    const tasks = await this.deps.tasks()
    const titles = new Map(((await tasks?.board().catch(() => null))?.tasks ?? []).map((t) => [t.id, t.title]))
    const merged = new Map<string, LogLine>()
    for (const d of drafts) {
      if (!d.share) continue
      const key = `${d.taskId ?? ''}\u0000${d.label}`
      const line = merged.get(key)
      if (line) line.share += d.share / DAY_SHARES
      else {
        merged.set(key, {
          task: d.taskId ? { id: d.taskId, title: titles.get(d.taskId) ?? d.label } : null,
          label: d.label || null,
          share: d.share / DAY_SHARES,
          props: d.props,
        })
      }
    }
    // Twentieths added as fractions: written as Notion reads them back (0.35, not 0.35000000000000003).
    const lines = [...merged.values()].map((l) => ({ ...l, share: Math.round(l.share * DAY_SHARES) / DAY_SHARES }))
    const entries = await log.sendDay(day, lines)
    await this.#store.recordLog(entries.map(logRowOf), day, day)
    await this.#store.writeDraft(day, [], false)
    this.deps.changed()
    return { written: entries.length }
  }

  // ---------- the lists

  // The 7 days of the week holding `day`, Monday first.
  async week(day: string): Promise<DaySummary[]> {
    const monday = addDays(day, -((dayStart(day).getDay() + 6) % 7))
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
    await this.readLog(days[0], days[6])
    return this.summaries(days)
  }

  async month(year: number, month: number): Promise<DaySummary[]> {
    const count = new Date(year, month, 0).getDate()
    const days = Array.from({ length: count }, (_, i) => dayKey(new Date(year, month - 1, i + 1)))
    await this.readLog(days[0], days[days.length - 1])
    return this.summaries(days)
  }

  // What the tab and the banner say: today's state, the days still to deal with among the last 7.
  async summary(): Promise<Summary> {
    const today = this.#today()
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6))
    await this.readLog(days[0], today)
    const stateOf = await this.stateReader(days)
    return {
      todayState: stateOf(today),
      pendingDays: days.filter((d) => ['to_validate', 'modified', 'to_fill'].includes(stateOf(d))).length,
      workDays: [...(await this.deps.settings()).workDays].sort(),
    }
  }

  // The work moved on (a commit, a task changed): today's proposal follows, and the Time Log is read again.
  async follow(): Promise<void> {
    const today = this.#today()
    await this.readLog(today, today)
    await this.refreshDraft(today)
    this.deps.changed()
  }
}

