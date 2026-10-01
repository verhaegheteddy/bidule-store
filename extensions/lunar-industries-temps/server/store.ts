import type { ServerContext } from '@bidule/api/extensions'
import type { Props } from '../contract.ts'

// A line of a day's draft (shares in twentieths).
export type DraftRow = {
  id: number
  day: string
  taskId: string | null
  label: string
  repo: string | null
  branch: string | null
  share: number
  tiny: boolean
  confirmed: boolean
  reason: string
  props: Props
}
export type NewDraftRow = Omit<DraftRow, 'id' | 'day' | 'tiny' | 'reason' | 'repo' | 'branch' | 'props'> &
  Partial<Pick<DraftRow, 'tiny' | 'reason' | 'repo' | 'branch' | 'props'>>

// An entry of the user's Time Log, as the Time Log answered (shares in twentieths).
export type LogRow = {
  id: string
  day: string
  taskId: string | null
  label: string
  share: number
  url: string | null
  props: Props
  lastEdited: string | null
}

/** What the module keeps: the drafts, which days are the user's, the mirror of the Time Log. */
export interface TempsStore {
  drafts(day: string): Promise<DraftRow[]>
  // The days among these that have a draft.
  daysWithDraft(days: string[]): Promise<Set<string>>
  // Replaces a day's draft; `edited` also says whether it is the user's now.
  writeDraft(day: string, rows: NewDraftRow[], edited?: boolean): Promise<void>
  edited(day: string): Promise<boolean>
  editedDays(days: string[]): Promise<Set<string>>
  setEdited(day: string, edited: boolean): Promise<void>
  // The Time Log's entries still there, of a day or of several.
  logged(days: string[]): Promise<LogRow[]>
  // For each task, what the user last logged on it (its label and properties become the proposal).
  lastLogged(): Promise<Map<string, { label: string; props: Props }>>
  usedLabels(): Promise<string[]>
  // Makes the mirror match what the Time Log has for a period: entries read are stored as they are, the period's
  // others hidden (archived, moved to another day).
  recordLog(entries: LogRow[], from: string, to: string): Promise<void>
}

const DRAFTS = 'lunar_industries_temps_drafts'
const DAYS = 'lunar_industries_temps_days'
const LOG = 'lunar_industries_temps_log'

type Raw = Record<string, unknown>

export function parseProps(json: unknown): Props {
  try {
    const value: unknown = JSON.parse(String(json ?? '{}'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Props) : {}
  } catch {
    return {}
  }
}

const draftOf = (r: Raw): DraftRow => ({
  id: Number(r.id),
  day: String(r.day),
  taskId: (r.task_id as string | null) ?? null,
  label: String(r.label ?? ''),
  repo: (r.repo as string | null) ?? null,
  branch: (r.branch as string | null) ?? null,
  share: Number(r.share ?? 0),
  tiny: Boolean(r.tiny),
  confirmed: Boolean(r.confirmed),
  reason: String(r.reason ?? ''),
  props: parseProps(r.props),
})

const logOf = (r: Raw): LogRow => ({
  id: String(r.id),
  day: String(r.day),
  taskId: (r.task_id as string | null) ?? null,
  label: String(r.label ?? ''),
  share: Number(r.share ?? 0),
  url: (r.url as string | null) ?? null,
  props: parseProps(r.props),
  lastEdited: (r.last_edited as string | null) ?? null,
})

export class DbStore implements TempsStore {
  constructor(protected db: ServerContext['db']) {}

  async drafts(day: string): Promise<DraftRow[]> {
    const rows = (await this.db.from(DRAFTS).where('day', day).orderBy('share', 'desc').orderBy('id')) as Raw[]
    return rows.map(draftOf)
  }

  async daysWithDraft(days: string[]): Promise<Set<string>> {
    if (!days.length) return new Set()
    const rows = (await this.db.from(DRAFTS).whereIn('day', days).distinct('day')) as Raw[]
    return new Set(rows.map((r) => String(r.day)))
  }

  async writeDraft(day: string, rows: NewDraftRow[], edited?: boolean): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx.from(DRAFTS).where('day', day).delete()
      if (rows.length) {
        await trx.table(DRAFTS).multiInsert(
          rows.map((r) => ({
            day,
            task_id: r.taskId,
            label: r.label,
            repo: r.repo ?? null,
            branch: r.branch ?? null,
            share: r.share,
            tiny: r.tiny ? 1 : 0,
            confirmed: r.confirmed ? 1 : 0,
            reason: r.reason ?? '',
            props: JSON.stringify(r.props ?? {}),
          }))
        )
      }
      if (edited !== undefined) {
        await trx.table(DAYS).insert({ day, edited: edited ? 1 : 0 }).onConflict('day').merge()
      }
    })
  }

  async edited(day: string): Promise<boolean> {
    const row = (await this.db.from(DAYS).where('day', day).first()) as Raw | null
    return Boolean(row?.edited)
  }

  async editedDays(days: string[]): Promise<Set<string>> {
    if (!days.length) return new Set()
    const rows = (await this.db.from(DAYS).whereIn('day', days).where('edited', 1)) as Raw[]
    return new Set(rows.map((r) => String(r.day)))
  }

  async setEdited(day: string, edited: boolean): Promise<void> {
    await this.db.table(DAYS).insert({ day, edited: edited ? 1 : 0 }).onConflict('day').merge()
  }

  async logged(days: string[]): Promise<LogRow[]> {
    if (!days.length) return []
    const rows = (await this.db.from(LOG).whereNull('deleted_at').whereIn('day', days).orderBy('share', 'desc')) as Raw[]
    return rows.map(logOf)
  }

  async lastLogged(): Promise<Map<string, { label: string; props: Props }>> {
    const rows = (await this.db.from(LOG).whereNull('deleted_at').whereNotNull('task_id').orderBy('day', 'desc')) as Raw[]
    const out = new Map<string, { label: string; props: Props }>()
    for (const r of rows.map(logOf)) {
      if (r.taskId && !out.has(r.taskId)) out.set(r.taskId, { label: r.label, props: r.props })
    }
    return out
  }

  async usedLabels(): Promise<string[]> {
    const rows = (await this.db.from(LOG).whereNull('deleted_at').distinct('label')) as Raw[]
    return rows.map((r) => String(r.label)).filter(Boolean)
  }

  async recordLog(entries: LogRow[], from: string, to: string): Promise<void> {
    await this.db.transaction(async (trx) => {
      for (const e of entries) {
        await trx
          .table(LOG)
          .insert({
            id: e.id,
            day: e.day,
            task_id: e.taskId,
            label: e.label,
            share: e.share,
            url: e.url,
            props: JSON.stringify(e.props),
            last_edited: e.lastEdited,
            deleted_at: null,
          })
          .onConflict('id')
          .merge()
      }
      await trx
        .from(LOG)
        .whereNull('deleted_at')
        .where('day', '>=', from)
        .where('day', '<=', to)
        .whereNotIn(
          'id',
          entries.map((e) => e.id)
        )
        .update({ deleted_at: new Date().toISOString() })
    })
  }
}
