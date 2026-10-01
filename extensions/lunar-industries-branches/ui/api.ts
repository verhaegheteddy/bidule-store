import type { Board } from '@bidule/sdk'
import type { Job, Links, Listing } from '../contract.ts'

// The module's routes (contract.ts lists them).
const BASE = '/api/ext/lunar-industries-branches'

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } })
  const body = (await res.json().catch(() => ({}))) as { error?: string; errors?: { message: string }[]; message?: string }
  // `message`: the core's own answer to an error the module did not catch (a 500), its reason rather than its status.
  if (!res.ok) throw new Error(body.error ?? body.errors?.[0]?.message ?? body.message ?? `Erreur ${res.status}`)
  return body as T
}

const send = (method: string, path: string, body: unknown) => json<{ ok: true }>(`${BASE}/${path}`, { method, body: JSON.stringify(body) })
const branch = (b: { repo: string; name: string }) => `repo=${encodeURIComponent(b.repo)}&name=${encodeURIComponent(b.name)}`
type B = { repo: string; name: string }

export const api = {
  list: () => json<Listing>(`${BASE}/branches`),
  links: (b: B) => json<Links>(`${BASE}/branches/links?${branch(b)}`),
  jobs: (b: B) => json<{ jobs: Job[] }>(`${BASE}/branches/jobs?${branch(b)}`),
  link: (b: B, taskId: string | null) => send('PUT', 'branches/link', { repo: b.repo, name: b.name, taskId }),
  pipeline: (b: B) => send('POST', 'branches/pipeline', { repo: b.repo, name: b.name }),
  retry: (b: B) => send('POST', 'branches/retry', { repo: b.repo, name: b.name }),
  play: (b: B, job: number) => send('POST', `branches/jobs/${job}/play`, { repo: b.repo, name: b.name }),
  review: (b: B, target: string) => send('POST', 'branches/review', { repo: b.repo, name: b.name, target }),
  target: (repo: string, target: string | null) => send('PUT', 'repos/target', { repo, target }),
}

// The core's board (the `tasks` role): the tasks a branch is linked to.
export async function board(): Promise<Board | null> {
  const b = await json<Board | { source: null }>('/api/board').catch(() => null)
  return b && b.source ? (b as Board) : null
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
