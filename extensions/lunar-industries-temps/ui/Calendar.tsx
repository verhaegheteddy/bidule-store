import { useEffect, useRef } from 'react'
import type { DaySummary } from '../contract.ts'
import { dayKey, monthTitle, STATE_DOT, STATE_LABEL } from './format.ts'

export type MonthCursor = { y: number; m: number }

const LETTERS = [
  { short: 'L', name: 'lundi' },
  { short: 'M', name: 'mardi' },
  { short: 'M', name: 'mercredi' },
  { short: 'J', name: 'jeudi' },
  { short: 'V', name: 'vendredi' },
  { short: 'S', name: 'samedi' },
  { short: 'D', name: 'dimanche' },
]

// Taken from quack-board (pages/temps/calendar, Simon's): a month, a dot of each day's state; a click picks the day.
// The arrows move day by day and week by week; Escape closes it.
export function Calendar({
  cursor,
  onCursor,
  month,
  day,
  today,
  onPick,
  onClose,
}: {
  cursor: MonthCursor
  onCursor: (c: MonthCursor) => void
  month: DaySummary[]
  day: string
  today: string
  onPick: (day: string) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The day shown takes the focus, else the first of the month.
    const target = box.current?.querySelector<HTMLButtonElement>('.lit-cal-day[aria-pressed="true"]') ?? box.current?.querySelector<HTMLButtonElement>('.lit-cal-day')
    target?.focus()
  }, [cursor.y, cursor.m])
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.lit-cal-toggle')) onClose()
    }
    addEventListener('mousedown', away)
    return () => removeEventListener('mousedown', away)
  }, [onClose])
  const states = new Map(month.map((d) => [d.day, d.state]))
  const lead = (new Date(cursor.y, cursor.m, 1).getDay() + 6) % 7
  const count = new Date(cursor.y, cursor.m + 1, 0).getDate()
  const cells: (string | null)[] = [...Array<null>(lead).fill(null)]
  for (let i = 1; i <= count; i++) cells.push(dayKey(new Date(cursor.y, cursor.m, i)))
  while (cells.length % 7) cells.push(null)
  const shift = (delta: number) => {
    const x = new Date(cursor.y, cursor.m + delta, 1)
    onCursor({ y: x.getFullYear(), m: x.getMonth() })
  }
  const move = (from: string, delta: number) => {
    const d = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8)) + delta)
    const key = dayKey(d)
    if (d.getMonth() !== cursor.m) shift(d.getMonth() > cursor.m || d.getFullYear() > cursor.y ? 1 : -1)
    queueMicrotask(() => box.current?.querySelector<HTMLButtonElement>(`[data-day="${key}"]`)?.focus())
  }
  return (
    <div
      ref={box}
      className="menu lit-cal"
      role="dialog"
      aria-label="Calendrier"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="row">
        <button type="button" className="btn icon" aria-label="Mois précédent" onClick={() => shift(-1)}>
          ‹
        </button>
        <span className="grow baloo lit-cal-title">{monthTitle(cursor.y, cursor.m)}</span>
        <button type="button" className="btn icon" aria-label="Mois suivant" onClick={() => shift(1)}>
          ›
        </button>
      </div>
      <div className="lit-cal-grid" role="grid" aria-label={monthTitle(cursor.y, cursor.m)}>
        <div className="lit-cal-week" role="row">
          {LETTERS.map((l, i) => (
            <span key={i} className="legend lit-cal-letter" role="columnheader" aria-label={l.name}>
              {l.short}
            </span>
          ))}
        </div>
        {Array.from({ length: cells.length / 7 }, (_, w) => (
          <div key={w} className="lit-cal-week" role="row">
            {cells.slice(w * 7, w * 7 + 7).map((key, i) =>
              key ? (
                <span key={key} role="gridcell">
                  <button
                    type="button"
                    data-day={key}
                    className={`lit-cal-day${key === today ? ' today' : ''}${key > today ? ' future' : ''}`}
                    aria-pressed={key === day}
                    aria-label={`${Number(key.slice(8))}${
                      ['empty', 'future', 'off'].includes(states.get(key) ?? 'empty') ? '' : `, ${STATE_LABEL[states.get(key)!]}`
                    }`}
                    onClick={() => onPick(key)}
                    onKeyDown={(e) => {
                      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
                      if (step === undefined) return
                      e.preventDefault()
                      move(key, step)
                    }}
                  >
                    {Number(key.slice(8))}
                    <span className="dot lit-cal-dot" style={{ background: STATE_DOT[states.get(key) ?? 'empty'] }} />
                  </button>
                </span>
              ) : (
                <span key={`x${w}-${i}`} role="gridcell" />
              )
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
