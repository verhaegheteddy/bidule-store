import { useEffect, useState, useSyncExternalStore } from 'react'
import { navigate, on, useSettingValues, type Board } from '@bidule/sdk'
import type { RepoSettings, SessionModel, SessionSummary, Template } from '../contract.ts'
import { api, board } from './api.ts'

// What the page and the background share while the app runs (taken from Simon's core/claude-sessions.ts): the
// sessions, read again when the API tells one started or changed state; the session shown.

export const PATH = '/lunar-industries/claude'
const ENABLED = 'lunar-industries-claude.enabled'

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: T) => {
      value = next
      listeners.forEach((l) => l())
    },
    use: () =>
      useSyncExternalStore(
        (l) => (listeners.add(l), () => listeners.delete(l)),
        () => value,
      ),
  }
}

// The module's switch (Réglages › Lunar Industries - Claude); null until the settings are read.
export function useEnabled(): boolean | null {
  const values = useSettingValues()
  if (!values) return null
  return values[ENABLED] === true || values[ENABLED] === 'true'
}

// ---------- the sessions

const sessions = store<SessionSummary[] | null>(null)
export const useSessions = sessions.use

let timer: ReturnType<typeof setTimeout> | undefined
const load = () =>
  api.sessions().then(
    (r) => sessions.set(r.sessions),
    () => sessions.set(sessions.get() ?? []),
  )

// Several changes in a row make one read.
export function refreshSessions(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void load(), 150)
}

// Followed while someone follows them (the background, while the module is on).
let followers = 0
let stop: (() => void) | null = null
export function followSessions(): () => void {
  if (!followers++) {
    void load()
    stop = on('lunar-industries-claude.sessions', refreshSessions)
  }
  return () => {
    if (--followers) return
    stop?.()
    stop = null
    clearTimeout(timer)
  }
}

// ---------- the session shown, kept across visits

const selected = store<string | null>(null)
export const useSelected = selected.use
export const select = (id: string | null) => selected.set(id)

// A session from anywhere (a notification, the Kanban): the page, on that session.
export function openSession(id: string): void {
  selected.set(id)
  refreshSessions()
  navigate(PATH)
}

// ---------- what does not change while the app runs: read once (again after a failure)

function once<T>(read: () => Promise<T>, fallback: T) {
  let pending: Promise<T> | null = null
  const value = store<T>(fallback)
  const get = () => {
    pending ??= read().then(
      (v) => (value.set(v), v),
      () => ((pending = null), fallback),
    )
    return pending
  }
  return {
    get,
    use: () => {
      useEffect(() => void get(), [])
      return value.use()
    },
  }
}

const models = once<SessionModel[]>(() => api.models().then((r) => r.models), [])
const templates = once<Template[]>(() => api.templates().then((r) => r.templates), [])
const repos = once<RepoSettings[]>(() => api.repos().then((r) => r.repos), [])
export const useModels = models.use
export const useTemplates = templates.use
export const useRepos = repos.use

// A repo's name, as the settings know it, else its folder's.
export const repoLabel = (all: RepoSettings[], path: string) =>
  all.find((r) => r.path === path)?.label ?? path.split(/[\\/]/).pop() ?? path

// The board's tasks, read when a component needing them appears.
export function useBoard(): Board | null {
  const [value, setValue] = useState<Board | null>(null)
  useEffect(() => {
    let live = true
    void board().then((b) => live && setValue(b))
    return () => {
      live = false
    }
  }, [])
  return value
}
