import type { Board } from '@bidule/sdk'
import type {
  Attachments,
  ClaudePlace,
  Decision,
  RepoSettings,
  SessionContext,
  SessionEffort,
  SessionEvents,
  SessionMode,
  SessionModel,
  SessionSummary,
  StartBody,
  Template,
} from '../contract.ts'

// The module's routes (contract.ts lists them), each answering 403 `{ error }` while the module is off.
const BASE = '/api/ext/lunar-industries-claude'

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; errors?: { message: string }[] }
  if (!res.ok) throw Object.assign(new Error(body.error ?? body.errors?.[0]?.message ?? `Erreur ${res.status}`), { status: res.status })
  return body as T
}

const send = <T = { ok: true }>(method: string, path: string, body?: unknown) =>
  json<T>(`${BASE}/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })
const get = <T>(path: string) => json<T>(`${BASE}/${path}`)
const session = (id: string, rest = '') => `sessions/${encodeURIComponent(id)}${rest}`
const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const api = {
  status: () => get<{ enabled: boolean; places: ClaudePlace[] }>('status'),
  sessions: () => get<{ sessions: SessionSummary[] }>('sessions'),
  start: (body: StartBody) => send<{ id: string }>('POST', 'sessions', body),
  events: (id: string, after: number, cwd?: string) => get<SessionEvents>(session(id, `/events${query({ after, cwd })}`)),
  context: (id: string, cwd?: string) => get<SessionContext>(session(id, `/context${query({ cwd })}`)),
  message: (id: string, body: { text: string } & Attachments) => send('POST', session(id, '/messages'), body),
  decide: (id: string, request: string, body: Decision) =>
    send('POST', session(id, `/decisions/${encodeURIComponent(request)}`), body),
  mode: (id: string, mode: SessionMode) => send('PUT', session(id, '/mode'), { mode }),
  model: (id: string, model: string | null) => send('PUT', session(id, '/model'), { model }),
  effort: (id: string, effort: SessionEffort | null) => send('PUT', session(id, '/effort'), { effort }),
  archive: (id: string, archived: boolean) => send('PUT', session(id, '/archive'), { archived }),
  task: (id: string, taskId: string | null, cwd?: string) => send('PUT', session(id, '/task'), { taskId, cwd }),
  interrupt: (id: string) => send('POST', session(id, '/interrupt')),
  stop: (id: string) => send('POST', session(id, '/stop')),
  watch: (id: string, cwd: string) => send('POST', session(id, '/watch'), { cwd }),
  unwatch: (id: string) => send('DELETE', session(id, '/watch')),
  templates: () => get<{ templates: Template[] }>('templates'),
  models: () => get<{ models: SessionModel[] }>('models'),
  repos: () => get<{ repos: RepoSettings[] }>('repos'),
}

// The core's board (the `tasks` role): the tasks a session starts from or gets attached to.
export async function board(): Promise<Board | null> {
  const b = await json<Board | { source: null }>('/api/board').catch(() => null)
  return b && b.source ? (b as Board) : null
}

// What to tell the user.
export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
