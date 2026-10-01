import type { GitBranch, GitEvent, GitSource } from '@bidule/ext-git/contract'
import type { Board, LogEntry, LogLine, StatusChange, TaskSource, TimeLog } from '@bidule/sdk/tasks'
import { Days } from '../server/days.ts'
import { DEFAULT_SETTINGS, type TempsSettings } from '../server/settings.ts'
import type { DraftRow, LogRow, NewDraftRow, TempsStore } from '../server/store.ts'
import type { Props } from '../contract.ts'

// The module's tables, in memory.
export class MemoryStore implements TempsStore {
  draftRows: DraftRow[] = []
  editedSet = new Set<string>()
  log: (LogRow & { deleted: boolean })[] = []
  #id = 1

  async drafts(day: string) {
    return this.draftRows.filter((r) => r.day === day).sort((a, b) => b.share - a.share || a.id - b.id)
  }
  async daysWithDraft(days: string[]) {
    return new Set(this.draftRows.filter((r) => days.includes(r.day)).map((r) => r.day))
  }
  async writeDraft(day: string, rows: NewDraftRow[], edited?: boolean) {
    this.draftRows = this.draftRows.filter((r) => r.day !== day)
    for (const r of rows) {
      this.draftRows.push({
        id: this.#id++,
        day,
        taskId: r.taskId,
        label: r.label,
        repo: r.repo ?? null,
        branch: r.branch ?? null,
        share: r.share,
        tiny: Boolean(r.tiny),
        confirmed: Boolean(r.confirmed),
        reason: r.reason ?? '',
        props: r.props ?? {},
      })
    }
    if (edited !== undefined) await this.setEdited(day, edited)
  }
  async edited(day: string) {
    return this.editedSet.has(day)
  }
  async editedDays(days: string[]) {
    return new Set(days.filter((d) => this.editedSet.has(d)))
  }
  async setEdited(day: string, edited: boolean) {
    if (edited) this.editedSet.add(day)
    else this.editedSet.delete(day)
  }
  async logged(days: string[]) {
    return this.log.filter((r) => !r.deleted && days.includes(r.day)).sort((a, b) => b.share - a.share)
  }
  async lastLogged() {
    const out = new Map<string, { label: string; props: Props }>()
    for (const r of [...this.log].filter((r) => !r.deleted && r.taskId).sort((a, b) => b.day.localeCompare(a.day))) {
      if (r.taskId && !out.has(r.taskId)) out.set(r.taskId, { label: r.label, props: r.props })
    }
    return out
  }
  async usedLabels() {
    return [...new Set(this.log.filter((r) => !r.deleted).map((r) => r.label))].filter(Boolean)
  }
  async recordLog(entries: LogRow[], from: string, to: string) {
    for (const e of entries) {
      this.log = this.log.filter((r) => r.id !== e.id)
      this.log.push({ ...e, deleted: false })
    }
    const ids = new Set(entries.map((e) => e.id))
    for (const r of this.log) if (r.day >= from && r.day <= to && !ids.has(r.id)) r.deleted = true
  }
  // A line of a draft, as the tests write them.
  draft(day: string, lines: Partial<NewDraftRow>[]) {
    return this.writeDraft(
      day,
      lines.map((l) => ({ taskId: null, label: 'Développement', share: 0, confirmed: false, ...l }))
    )
  }
}

// The user's repos: branches (with their task and whether they are the default), events, links.
export class FakeGit {
  branchRows: GitBranch[] = []
  eventRows: GitEvent[] = []
  links: [string, string, string | null][] = []

  branch(repo: string, name: string, o: { taskId?: string | null; isDefault?: boolean } = {}) {
    this.branchRows.push({
      repo,
      repoLabel: repo,
      name,
      taskId: o.taskId ?? null,
      manual: false,
      isDefault: o.isDefault ?? false,
      ahead: 0,
      behind: 0,
      pushed: false,
      lastCommitAt: null,
      headSha: null,
      base: null,
      remoteHost: null,
      remotePath: null,
      remote: null,
      reviewNumber: null,
      reviewRef: null,
      reviewState: null,
      ci: null,
    })
  }
  event(at: string, kind: GitEvent['kind'], repo: string, branch: string, detail = '') {
    const taskId = this.branchRows.find((b) => b.repo === repo && b.name === branch)?.taskId ?? null
    this.eventRows.push({ at, kind, repo, branch, detail, taskId })
  }
  source(): GitSource {
    return {
      repos: async () => [...new Set(this.branchRows.map((b) => b.repo))].map((path) => ({ path, label: path })),
      branches: async () => this.branchRows,
      events: async (since: string, until: string) => this.eventRows.filter((e) => e.at >= since && e.at < until),
      link: async (repo: string, name: string, taskId: string | null) => {
        this.links.push([repo, name, taskId])
        const b = this.branchRows.find((x) => x.repo === repo && x.name === name)
        if (b) Object.assign(b, { taskId, manual: true })
        return true
      },
    } as unknown as GitSource
  }
}

export class FakeTasks {
  edits: { at: string; taskId: string }[] = []
  changes: StatusChange[] = []
  board: Board = { source: 'Fake', configured: true, columns: [], tasks: [] }
  source(): TaskSource {
    return {
      board: async () => this.board,
      edits: async (since: string, until: string) => this.edits.filter((e) => e.at >= since && e.at < until),
      statusChanges: async (since: string, until: string) => this.changes.filter((c) => c.at >= since && c.at < until),
    } as unknown as TaskSource
  }
}

// A Time Log that reads and writes whole days, as Notion's does: one entry per (task, label) and day.
export class FakeTimeLog implements TimeLog {
  readonly name = 'Fake'
  entries: (LogEntry & { archived: boolean })[] = []
  calls: string[] = []
  #id = 1
  constructor(protected rich = true) {}
  async configured() {
    return true
  }
  async write(): Promise<string> {
    throw new Error('not used')
  }
  async remove(id: string) {
    this.calls.push(`remove ${id}`)
    const e = this.entries.find((x) => x.id === id)
    if (e) e.archived = true
  }
  async fields() {
    return { labels: ['Développement', 'Réunion', 'Absent', 'Déploiement'], extras: [] }
  }
  async read(from: string, to: string): Promise<LogEntry[]> {
    return this.entries
      .filter((e) => !e.archived && e.day >= from && e.day <= to)
      .map((e) => ({ id: e.id, day: e.day, taskId: e.taskId, label: e.label, share: e.share, url: e.url, props: e.props, lastEdited: e.lastEdited }))
  }
  async sendDay(day: string, lines: LogLine[]): Promise<LogEntry[]> {
    this.calls.push(`send ${day}`)
    const pair = (taskId: string | null, label: string | null) => `${taskId ?? ''}|${label ?? ''}`
    const unused = new Map(this.entries.filter((e) => !e.archived && e.day === day).map((e) => [pair(e.taskId, e.label), e]))
    const written: LogEntry[] = []
    for (const line of lines) {
      const key = pair(line.task?.id ?? null, line.label)
      let entry = unused.get(key)
      unused.delete(key)
      if (!entry) {
        entry = { id: `p${this.#id++}`, day, taskId: line.task?.id ?? null, label: line.label, share: 0, url: null, props: {}, lastEdited: '', archived: false }
        this.entries.push(entry)
      }
      Object.assign(entry, { share: line.share, props: line.props ?? {}, lastEdited: new Date().toISOString() })
      written.push({ ...entry })
    }
    for (const e of unused.values()) e.archived = true
    return written
  }
}

// A Time Log with a task and a share only (no labels, no reading back).
export class PlainTimeLog implements TimeLog {
  readonly name = 'Plain'
  async configured() {
    return true
  }
  async write() {
    return 'x'
  }
  async remove() {}
}

export function setup(o: { now: Date; settings?: Partial<TempsSettings>; log?: TimeLog | null }) {
  const store = new MemoryStore()
  const git = new FakeGit()
  const tasks = new FakeTasks()
  const log = o.log === undefined ? new FakeTimeLog() : o.log
  let changes = 0
  const days = new Days({
    store,
    settings: async () => ({ ...DEFAULT_SETTINGS, ...o.settings }),
    git: async () => git.source(),
    tasks: async () => tasks.source(),
    timeLog: async () => log,
    changed: () => (changes += 1),
    now: () => o.now,
  })
  return { store, git, tasks, log, days, changes: () => changes }
}
