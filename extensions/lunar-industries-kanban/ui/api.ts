import type { Board } from '@bidule/sdk'
import type { BranchRef, Branches } from '../contract.ts'

// The core's routes over the `tasks` role (as any Kanban), and the module's own over the `git` role (contract.ts).
export type Loaded = Board | { source: null }

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } })
  const body = (await res.json().catch(() => ({}))) as { error?: string; errors?: { message: string }[] }
  if (!res.ok) throw new Error(body.error ?? body.errors?.[0]?.message ?? `Erreur ${res.status}`)
  return body as T
}

const BASE = '/api/ext/lunar-industries-kanban'

export const board = () => json<Loaded>('/api/board')
export const moveTask = (id: string, status: string) =>
  json<Board>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) })
export const branches = () => json<Branches>(`${BASE}/branches`)
export const setBranches = (taskId: string, list: BranchRef[]) =>
  json<Branches>(`${BASE}/tasks/${encodeURIComponent(taskId)}/branches`, {
    method: 'PUT',
    body: JSON.stringify({ branches: list }),
  })
export const reviewUrl = (ref: BranchRef) =>
  json<{ url: string | null }>(`${BASE}/review?${new URLSearchParams(ref).toString()}`)

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
