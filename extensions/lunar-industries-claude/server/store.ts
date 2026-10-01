import type { ServerContext } from '@bidule/api/extensions'
import type { SessionStatus } from '../contract.ts'

// A permission asked by Claude Code and the user's answer: Claude Code's history does not keep them.
export type DecisionRow = { id: string; tool: string; detail: string; allow: boolean; at: string }

// What one model cost in a session, as Claude Code prices it (`modelUsage` of the result message).
export type ModelUsage = {
  inputTokens: number
  outputTokens: number
  thinkingTokens?: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  costBasis?: 'list' | 'managed' | 'unknown'
}
export type UsageByModel = Record<string, ModelUsage>

/**
 * Taken from quack-board (models/claude_session.ts, Simon's): a Claude session started from the app, keyed by Claude
 * Code's own session id, as a plain object; its JSON columns read and written as lists.
 */
export type SessionRow = {
  id: string
  taskId: string | null
  cwd: string
  repos: string[]
  worktrees: string[]
  mode: string
  status: SessionStatus
  title: string
  decisions: DecisionRow[]
  model: string | null
  effort: string | null
  usage: UsageByModel
  costUsd: number | null
  turns: number | null
  login: 'subscription' | 'apiKey' | null
  // 'terminal': a session of the terminal given a row to carry its task; null: started from the app.
  origin: 'terminal' | null
  createdAt: string
  updatedAt: string
}

const SESSIONS = 'lunar_industries_claude_sessions'
const ARCHIVES = 'lunar_industries_claude_archives'

const json = <T>(text: unknown, fallback: T): T => {
  try {
    return text ? (JSON.parse(String(text)) as T) : fallback
  } catch {
    return fallback
  }
}

type Db = ServerContext['db']
type Raw = Record<string, unknown>

function toRow(r: Raw): SessionRow {
  return {
    id: String(r.id),
    taskId: (r.task_id as string | null) ?? null,
    cwd: String(r.cwd),
    repos: json<string[]>(r.repos, []),
    worktrees: json<string[]>(r.worktrees, []),
    mode: String(r.mode),
    status: r.status as SessionStatus,
    title: String(r.title),
    decisions: json<DecisionRow[]>(r.decisions, []),
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    usage: json<UsageByModel>(r.usage, {}),
    costUsd: (r.cost_usd as number | null) ?? null,
    turns: (r.turns as number | null) ?? null,
    login: (r.login as SessionRow['login']) ?? null,
    origin: (r.origin as SessionRow['origin']) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

const toRaw = (row: SessionRow) => ({
  id: row.id,
  task_id: row.taskId,
  cwd: row.cwd,
  repos: JSON.stringify(row.repos),
  worktrees: JSON.stringify(row.worktrees),
  mode: row.mode,
  status: row.status,
  title: row.title,
  decisions: JSON.stringify(row.decisions),
  model: row.model,
  effort: row.effort,
  usage: JSON.stringify(row.usage),
  cost_usd: row.costUsd,
  turns: row.turns,
  login: row.login,
  origin: row.origin,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
})

export class SessionStore {
  constructor(protected db: Db) {}

  async find(id: string): Promise<SessionRow | null> {
    const r = (await this.db.from(SESSIONS).where('id', id).first()) as Raw | null
    return r ? toRow(r) : null
  }

  async all(): Promise<SessionRow[]> {
    return ((await this.db.from(SESSIONS).orderBy('created_at', 'desc')) as Raw[]).map(toRow)
  }

  // A new row, or the same one written again (its last change now).
  async save(row: SessionRow): Promise<void> {
    row.updatedAt = new Date().toISOString()
    const raw = toRaw(row)
    const known = await this.db.from(SESSIONS).where('id', row.id).first()
    if (known) await this.db.from(SESSIONS).where('id', row.id).update(raw)
    else await this.db.table(SESSIONS).insert(raw)
  }

  // A row as a new session starts it.
  fresh(fields: Pick<SessionRow, 'id' | 'cwd' | 'taskId' | 'repos' | 'title' | 'mode' | 'status'> & Partial<SessionRow>): SessionRow {
    const now = new Date().toISOString()
    return {
      worktrees: [],
      decisions: [],
      model: null,
      effort: null,
      usage: {},
      costUsd: null,
      turns: null,
      login: null,
      origin: null,
      createdAt: now,
      updatedAt: now,
      ...fields,
    }
  }

  // At the API's start: no process survived the previous one, the sessions it ran are saved.
  async recover(): Promise<void> {
    await this.db.from(SESSIONS).whereNot('status', 'saved').update({ status: 'saved' })
  }

  async archived(): Promise<Set<string>> {
    return new Set(((await this.db.from(ARCHIVES).select('session_id')) as Raw[]).map((r) => String(r.session_id)))
  }

  async archive(id: string, archived: boolean): Promise<void> {
    await this.db.from(ARCHIVES).where('session_id', id).delete()
    if (archived) await this.db.table(ARCHIVES).insert({ session_id: id, created_at: new Date().toISOString() })
  }
}
