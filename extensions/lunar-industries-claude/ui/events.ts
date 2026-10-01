import type { SessionEvent, SessionStatus } from '../contract.ts'

// The conversation's lines, as the page draws them (taken from Simon's conversation.ts and tool-call.ts).

export type ToolCallEvent = Extract<SessionEvent, { kind: 'tool' }>
export type ToolResultEvent = Extract<SessionEvent, { kind: 'tool_result' }>
export type Permission = Extract<SessionEvent, { kind: 'permission' }>
export type DecisionEvent = Extract<SessionEvent, { kind: 'decision' }>
export type Tools = { call: ToolCallEvent; result: ToolResultEvent | null }[]

// A line of the page: consecutive tool calls make one block, each with its result.
export type Item = { kind: 'tools'; seq: number; tools: Tools } | Exclude<SessionEvent, ToolCallEvent | ToolResultEvent>

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'

export const STATUS: Record<SessionStatus, { label: string; tone: Tone }> = {
  running: { label: 'Claude travaille', tone: 'info' },
  waiting: { label: 'Décision attendue', tone: 'warn' },
  idle: { label: 'En attente de message', tone: 'ok' },
  saved: { label: 'Enregistrée', tone: 'neutral' },
}

/**
 * Lines in the order of their number: one already shown is skipped; a gap stops there (`gap`: the page reads the
 * missed ones again from the API).
 */
export function merge(list: SessionEvent[], incoming: SessionEvent[]): { list: SessionEvent[]; added: SessionEvent[]; gap: boolean } {
  let last = list.at(-1)?.seq ?? 0
  const added: SessionEvent[] = []
  let gap = false
  for (const e of incoming) {
    if (e.seq <= last) continue
    if (e.seq > last + 1) {
      gap = true
      break
    }
    added.push(e)
    last = e.seq
  }
  return { list: added.length ? [...list, ...added] : list, added, gap }
}

export function decidedOf(events: SessionEvent[]): Map<string, DecisionEvent> {
  const map = new Map<string, DecisionEvent>()
  for (const e of events) if (e.kind === 'decision') map.set(e.id, e)
  return map
}

// The cards still waiting for the user.
export function pendingOf(events: SessionEvent[]): Permission[] {
  const decided = decidedOf(events)
  return events.filter((e): e is Permission => e.kind === 'permission' && !decided.has(e.id))
}

export function itemsOf(events: SessionEvent[]): Item[] {
  const results = new Map<string, ToolResultEvent>()
  for (const e of events) if (e.kind === 'tool_result') results.set(e.id, e)
  const items: Item[] = []
  for (const e of events) {
    if (e.kind === 'tool_result') continue
    if (e.kind === 'tool') {
      const last = items.at(-1)
      const entry = { call: e, result: results.get(e.id) ?? null }
      if (last?.kind === 'tools') last.tools.push(entry)
      else items.push({ kind: 'tools', seq: e.seq, tools: [entry] })
      continue
    }
    items.push(e)
  }
  return items
}

// What the closed block of several tool calls tells: how many, the files changed, an error, a call still running.
export function toolsSummary(tools: Tools): { label: string; failed: boolean; running: boolean } {
  const files = new Set(tools.flatMap((t) => (t.call.change ? [t.call.change.file] : []))).size
  const plural = files > 1 ? 's' : ''
  const label = [`${tools.length} outils utilisés`, files ? `${files} fichier${plural} modifié${plural}` : '']
    .filter(Boolean)
    .join(' · ')
  return { label, failed: tools.some((t) => t.result && !t.result.ok), running: tools.some((t) => !t.result) }
}

// A file change as diff lines: what is replaced, then its replacement.
export function diffLines(before: string, after: string): { sign: '-' | '+'; text: string }[] {
  const lines = (text: string, sign: '-' | '+') => (text ? text.split('\n').map((t) => ({ sign, text: t })) : [])
  return [...lines(before, '-'), ...lines(after, '+')]
}

// What a card says Claude wants to do, in words.
export function cardTitle(card: Permission): string {
  if (card.name === 'Bash') return 'Claude veut lancer une commande'
  if (card.name === 'Edit' || card.name === 'MultiEdit') return 'Claude veut modifier un fichier'
  if (card.name === 'Write') return 'Claude veut écrire un fichier'
  if (card.name.startsWith('mcp__workspace__')) return 'Claude veut agir par l’app'
  return `Claude veut utiliser ${card.name}`
}

// The kinds of notification the `notify` setting names (« decision, error, slot »).
export function notifyKinds(setting: unknown): Set<string> {
  return new Set(
    String(setting ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

const RELATIVE = new Intl.RelativeTimeFormat('fr', { style: 'short', numeric: 'auto' })
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Infinity],
]

// « il y a 5 min », « hier »: when a session last moved.
export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return '—'
  let value = (at - now) / 60_000
  if (Math.abs(value) < 1) return 'à l’instant'
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return RELATIVE.format(Math.round(value), unit)
    value /= size
  }
  return '—'
}

// Dollars and tokens as the context panel shows them.
export const cost = (usd: number) => `${usd.toFixed(2).replace('.', ',')} $`
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  const thousands = n / 1000
  if (thousands < 1000) return `${Math.round(thousands)} k`
  return `${(thousands / 1000).toFixed(1).replace('.', ',')} M`
}
