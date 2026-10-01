import type { DayState } from '../contract.ts'

// Taken from quack-board (core/format.ts, Simon's): how the days read on the page.

export const DAY_SHARES = 20

// How each state of a day reads, in the week, the calendar and the tab.
export const STATE_LABEL: Record<DayState, string> = {
  recorded: 'dans le Time Log',
  absent: 'absent',
  modified: 'modifié, non envoyé',
  to_validate: 'à valider',
  to_fill: 'à remplir',
  off: 'non travaillé',
  empty: 'aucune activité pour l’instant',
  future: 'à venir',
}
export const STATE_DOT: Record<DayState, string> = {
  recorded: 'var(--mint)',
  absent: 'var(--text-off)',
  modified: 'var(--pink)',
  to_validate: 'var(--butter)',
  to_fill: 'var(--butter)',
  off: 'transparent',
  empty: 'transparent',
  future: 'transparent',
}
// The days still to deal with: they make the week's count and the « next day » link.
export const PENDING: DayState[] = ['to_validate', 'modified', 'to_fill']

// A share of a day, stored in twentieths: « 0,35 », « 1 ».
export const fmtShare = (twentieths: number) => String(twentieths / DAY_SHARES).replace('.', ',')
// Minutes since midnight as a clock time: « 09:05 ».
export const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

const pad = (n: number) => String(n).padStart(2, '0')
// Days travel as local ISO dates (« 2026-09-22 »), the key the API uses.
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const parseDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const addDays = (d: Date, n: number) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
// ISO weeks start on Monday.
export const monday = (d: Date) => addDays(d, -((d.getDay() + 6) % 7))
// The ISO week number.
export function weekNumber(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - first.getTime()) / 864e5 + 1) / 7)
}
export const isoWeekday = (key: string) => parseDay(key).getDay() || 7

const DATE = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
// « Mardi 22 septembre ».
export const dayTitle = (key: string) => capital(DATE.format(parseDay(key)))
export const dayName = (key: string) => DATE.format(parseDay(key))
const MONTH = new Intl.DateTimeFormat('fr-FR', { month: 'long' })
const MONTH_SHORT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })
// « 21 – 27 septembre », « 28 sept. – 4 oct. » across two months.
export function weekRange(from: Date): string {
  const to = addDays(from, 6)
  return from.getMonth() === to.getMonth()
    ? `${from.getDate()} – ${to.getDate()} ${MONTH.format(to)}`
    : `${MONTH_SHORT.format(from)} – ${MONTH_SHORT.format(to)}`
}
export const monthTitle = (y: number, m: number) =>
  capital(new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date(y, m, 1)))
// « le mardi 22 septembre à 18:04 ».
export function sentAtText(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `le ${DATE.format(d)} à ${hm(d.getHours() * 60 + d.getMinutes())}`
}

export const DAYS_SHORT = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.']
// « lun. – ven. » for consecutive days, « lun., mer., ven. » otherwise.
export function workText(days: number[]): string {
  if (!days.length) return 'aucun'
  const names = days.map((d) => DAYS_SHORT[d - 1])
  const consecutive = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  return consecutive && days.length > 2 ? `${names[0]} – ${names.at(-1)}` : names.join(', ')
}

// The git branch is the identifier shown everywhere; the tsk-NN- prefix only serves the linking.
export const bshort = (name: string) => name.replace(/^tsk-\d+-/, '')

const LABEL_COLOURS = 5
// A label's colour, from its place among the Time Log's labels: the same every day (the theme's task colours). With
// more labels than colours, the 1st and the 6th share one; an unknown label has none.
export function labelColor(label: string, labels: string[]): { color: string; ink: string } {
  const i = labels.indexOf(label)
  if (i < 0) return { color: 'var(--chip-hover)', ink: 'var(--text)' }
  return { color: `var(--task-${(i % LABEL_COLOURS) + 1})`, ink: 'var(--on-coral)' }
}

/**
 * Moves a border of the bar: the two neighbours trade twentieths, each keeping at least one so neither leaves the bar
 * mid-drag. The last border (`right` null) trades with the part of the day not yet given out. Returns the new shares,
 * or null when nothing changes.
 */
export function shift(shares: number[], left: number, right: number | null, delta: number): number[] | null {
  const next = [...shares]
  if (right === null) {
    const others = shares.reduce((sum, s) => sum + s, 0) - shares[left]
    next[left] = Math.min(Math.max(1, DAY_SHARES - others), Math.max(1, shares[left] + delta))
  } else {
    const pair = shares[left] + shares[right]
    next[left] = Math.min(pair - 1, Math.max(1, shares[left] + delta))
    next[right] = pair - next[left]
  }
  return next.every((s, i) => s === shares[i]) ? null : next
}
