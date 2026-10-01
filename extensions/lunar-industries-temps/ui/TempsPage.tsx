import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { busy, Modal, navigate, openDialog, react, useHint, useOn, type Board, type Task } from '@bidule/sdk'
import type { DayLine, DayState, DaySummary, DayView, LineInput, Props, Summary } from '../contract.ts'
import { api, board as readBoard, errorMessage, moveTask } from './api.ts'
import { Calendar, type MonthCursor } from './Calendar.tsx'
import {
  addDays,
  bshort,
  DAY_SHARES,
  DAYS_SHORT,
  dayKey,
  dayName,
  dayTitle,
  fmtShare,
  hm,
  isoWeekday,
  labelColor,
  monday,
  parseDay,
  PENDING,
  sentAtText,
  shift,
  STATE_DOT,
  STATE_LABEL,
  weekNumber,
  weekRange,
  workText,
} from './format.ts'
import { TaskPicker } from './TaskPicker.tsx'
import './temps.css'

// Kept while the app runs: coming back the same date, the page shows the day chosen again.
let chosen: { on: string; day: string } | null = null
const days = new Map<string, DayView>()

// How long the draft waits after the last change before it is saved.
const SAVE_DELAY = 600

// A line as edited on the page, before it is saved.
type Line = Pick<DayLine, 'taskId' | 'label' | 'share' | 'confirmed' | 'repo' | 'branch' | 'props' | 'tiny' | 'reason' | 'url'> & {
  // The saved line it comes from (settling an orphan goes through it), null for a new one.
  id: string | null
  key: string
}

const lineKey = (l: Pick<Line, 'taskId' | 'repo' | 'branch' | 'label'>) =>
  l.taskId ? `t:${l.taskId}` : l.repo && l.branch ? `b:${l.repo}\u0000${l.branch}` : `none:${l.label}`
// A line's identity on the page: saving changes its id, and a task can have one line per label.
const lineId = (l: Pick<Line, 'key' | 'label'>) => `${l.key}\u0000${l.label}`

const linesOf = (view: DayView | null): Line[] =>
  (view?.lines ?? []).map((l) => ({
    id: l.id,
    key: l.key,
    taskId: l.taskId,
    label: l.label,
    share: l.share,
    confirmed: l.confirmed,
    repo: l.repo,
    branch: l.branch,
    props: l.props,
    tiny: l.tiny,
    reason: l.reason,
    url: l.url,
  }))

// The day as the API gives it, its lines in the order the page shows them (the API sorts them by share); new lines
// come last.
function inPageOrder(data: DayView, shown: Pick<Line, 'key' | 'label'>[]): DayView {
  const order = shown.map(lineId)
  const rank = (l: Pick<Line, 'key' | 'label'>) => {
    const i = order.indexOf(lineId(l))
    return i < 0 ? order.length : i
  }
  return { ...data, lines: [...data.lines].sort((a, b) => rank(a) - rank(b)) }
}

const fail = (err: unknown) => react('panic', errorMessage(err), errorMessage(err))

const EDITABLE: DayState[] = ['to_validate', 'modified', 'empty', 'to_fill', 'off']

// Taken from quack-board (pages/temps, Simon's): the week on the left, the chosen day on the right, shared out in
// twentieths of a day between its lines, then sent to the Time Log.
export function TempsPage() {
  const today = dayKey(new Date())
  const returning = chosen?.on === today
  const [day, setDay] = useState(() => (returning && chosen?.day) || today)
  const [view, setView] = useState<DayView | null>(() => days.get(day) ?? null)
  const [week, setWeek] = useState<DaySummary[] | null>(null)
  const [cal, setCal] = useState<MonthCursor | null>(null)
  const [month, setMonth] = useState<DaySummary[]>([])
  const [taskBoard, setBoard] = useState<Board | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [edits, setEdits] = useState<Line[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState(false)
  const [savedDay, setSavedDay] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editsRef = useRef<Line[] | null>(null)
  const viewRef = useRef<DayView | null>(view)
  const dayRef = useRef(day)
  const workingRef = useRef(false)
  const savingRef = useRef(false)
  const bar = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x0: number; width: number; scale: number; from: Line[]; left: number; right: number | null } | null>(null)

  useEffect(() => {
    chosen = { on: today, day }
    dayRef.current = day
  }, [today, day])
  const show = useCallback((v: DayView) => {
    days.set(v.day, v)
    viewRef.current = v
    setView(v)
  }, [])
  const setLines = (lines: Line[] | null) => {
    editsRef.current = lines
    setEdits(lines)
  }

  // ---------- reading

  const weekKey = dayKey(monday(parseDay(day)))
  const loadWeek = useCallback(() => {
    void api.week(weekKey).then(setWeek, () => undefined)
  }, [weekKey])
  const loadSummary = () => void api.summary().then(setSummary, () => undefined)
  useEffect(() => {
    let live = true
    setSelected(null)
    setMoreOpen(false)
    setLines(null)
    const cached = days.get(day)
    if (cached) {
      viewRef.current = cached
      setView(cached)
    }
    api.day(day).then((v) => live && dayRef.current === day && show(v), fail)
    return () => {
      live = false
    }
  }, [day, show])
  useEffect(loadWeek, [loadWeek])
  useEffect(() => {
    if (cal) void api.month(cal.y, cal.m).then(setMonth, fail)
  }, [cal])
  const loadBoard = () => void readBoard().then(setBoard)
  useEffect(() => {
    loadBoard()
    loadSummary()
  }, [])
  useOn('tasks.changed', loadBoard)

  // In the morning, before any activity, the previous work day still to deal with comes first (once a date).
  const decided = useRef(returning)
  useEffect(() => {
    if (decided.current || !summary) return
    decided.current = true
    if (summary.todayState !== 'empty' && summary.todayState !== 'off') return
    const work = new Set(summary.workDays)
    let d = addDays(parseDay(today), -1)
    for (let i = 0; i < 7 && !work.has(d.getDay() || 7); i++) d = addDays(d, -1)
    const key = dayKey(d)
    if (!work.has(d.getDay() || 7)) return
    void api.week(key).then((list) => {
      const state = list.find((x) => x.day === key)?.state
      if ((state === 'to_validate' || state === 'to_fill') && dayRef.current === today) go(key)
    }, fail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary])

  // ---------- saving the draft

  // Saves the edits waiting, whatever the day's total: only sending needs 1. What the API answers replaces the
  // page's copy unless the user changed something meanwhile (saved in turn).
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPending(false)
    const lines = editsRef.current
    const shown = viewRef.current
    if (!lines || !shown) return
    const d = shown.day
    savingRef.current = true
    setSaving(true)
    try {
      const data = await api.replace(
        d,
        lines.map(
          (l): LineInput => ({
            taskId: l.taskId,
            label: l.label,
            share: l.share,
            confirmed: l.confirmed,
            repo: l.repo,
            branch: l.branch,
            props: l.props,
          })
        )
      )
      setSavedDay(d)
      days.set(d, data)
      loadWeek()
      loadSummary()
      if (d !== dayRef.current || editsRef.current !== lines) return
      show(inPageOrder(data, lines))
      setLines(null)
    } catch (err) {
      fail(err)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [loadWeek, show])
  // Leaving the page saves what is still waiting.
  useEffect(() => () => void flush(), [flush])

  const queueSave = () => {
    if (timer.current) clearTimeout(timer.current)
    setPending(true)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY)
  }
  const dropPending = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setPending(false)
    setLines(null)
  }

  // Changing day saves the draft of the one left first.
  const go = (key: string) => {
    if (key === dayRef.current) return
    void flush()
    setDay(key)
  }

  // ---------- what is shown

  const shownDay = view?.day ?? day
  const state: DayState = view?.state ?? 'empty'
  const editable = Boolean(view) && EDITABLE.includes(state)
  const recorded = state === 'recorded' || state === 'absent'
  const lines = edits ?? linesOf(view)
  const showLines = lines.length > 0 && state !== 'absent'
  const total = lines.reduce((a, l) => a + l.share, 0)
  // A git branch linked to no task is often a forgotten task: it must be attached or kept on purpose.
  const orphans = lines.filter((l) => !l.taskId && l.branch && !l.confirmed)
  const canSend = lines.length > 0 && total === DAY_SHARES && !orphans.length && !working && !view?.logProblem
  const tasks: Task[] = taskBoard?.tasks ?? []
  const columns = taskBoard?.columns ?? []
  const labels = view?.labels ?? []
  const extras = view?.extras ?? []
  const workDays = summary?.workDays ?? [1, 2, 3, 4, 5]
  const isWorkDay = (key: string) => workDays.includes(isoWeekday(key))
  const offWithActivity = showLines && !isWorkDay(shownDay)
  const editing = () => Boolean(editsRef.current || timer.current || savingRef.current || workingRef.current)

  // The API announced a change of the days (new activity, the Time Log read again): the lists are read again, and the
  // day shown too, unless the user is changing it.
  useOn('lunar-industries-temps.changed', () => {
    loadWeek()
    loadSummary()
    if (cal) void api.month(cal.y, cal.m).then(setMonth, () => undefined)
    if (editing()) return
    const d = viewRef.current?.day ?? dayRef.current
    api.day(d).then(
      (data) => {
        if (d !== dayRef.current || editing()) return
        show(inPageOrder(data, linesOf(viewRef.current)))
      },
      () => undefined
    )
  })

  const checks = [
    {
      ok: total === DAY_SHARES,
      text:
        total === DAY_SHARES
          ? 'La journée fait 1 j.'
          : total < DAY_SHARES
            ? `Il reste ${fmtShare(DAY_SHARES - total)} j à répartir (${fmtShare(total)} j sur 1).`
            : `La journée dépasse 1 j de ${fmtShare(total - DAY_SHARES)} j.`,
    },
    {
      ok: !orphans.length,
      text: orphans.length
        ? `${orphans.length} branche${orphans.length > 1 ? 's' : ''} sans tâche à rattacher ou à garder.`
        : 'Chaque ligne a sa tâche ou est gardée sans tâche.',
    },
  ]
  const draftNote = saving || pending ? 'Enregistrement…' : savedDay === shownDay ? 'Brouillon enregistré' : ''

  // Each line with what the page shows about it.
  const rows = useMemo(() => {
    const signals = view?.signals ?? []
    const startColumn = columns.find((c) => c.group === 'doing') ?? null
    return lines.map((l, index) => {
      const t = tasks.find((x) => x.id === l.taskId)
      const evidence = signals.filter((s) => s.key === l.key)
      const branch = l.branch ?? evidence.find((s) => s.branch)?.branch ?? null
      const where = branch ? bshort(branch) : null
      const orphan = !l.taskId && Boolean(l.branch) && !l.confirmed
      // A task not on the board (someone else's) is still a task, not a label.
      const title = t?.title ?? (l.taskId ? 'Tâche inconnue' : l.label)
      const toDo = t ? columns.find((c) => c.name === t.status)?.group === 'todo' : false
      return {
        ...l,
        index,
        rowId: lineId(l),
        ...(orphan ? { color: 'var(--bad-dot)', ink: 'var(--bad-ink)' } : labelColor(l.label, labels)),
        title,
        // A line without a task is named by its label; an orphan branch by its branch, until settled.
        name: orphan && where ? where : title,
        where,
        orphan,
        plain: !l.taskId && !orphan,
        kept: !l.taskId && Boolean(l.branch) && l.confirmed,
        // Commits on a task the source still lists as to do: the status was probably forgotten.
        start: toDo && evidence.some((s) => s.kind === 'commit') ? startColumn : null,
        evidence: evidence.map((s) => ({ time: hm(s.minute), kind: s.kind, detail: s.detail })),
      }
    })
  }, [lines, view, tasks, columns, labels])

  // A day over 1 widens the scale so every segment still fits in the bar.
  const scale = Math.max(DAY_SHARES, total)
  const segments = useMemo(() => {
    const shown = rows.filter((r) => r.share > 0)
    let at = 0
    return shown.map((row, k) => {
      const left = (at / scale) * 100
      at += row.share
      return { row, next: shown[k + 1] ?? null, left, width: (row.share / scale) * 100, size: row.share >= 4 ? 'lg' : row.share >= 2 ? 'md' : 'sm' }
    })
  }, [rows, scale])
  const rest = editable && total < DAY_SHARES
    ? { left: (total / DAY_SHARES) * 100, width: ((DAY_SHARES - total) / DAY_SHARES) * 100, text: DAY_SHARES - total >= 2 ? `${fmtShare(DAY_SHARES - total)} à répartir` : '' }
    : null

  const weekStart = monday(parseDay(day))
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(weekStart, i)
    const key = dayKey(d)
    const found = week?.find((x) => x.day === key)
    const st = found?.state ?? 'empty'
    const isToday = key === today
    return {
      key,
      state: st,
      label: `${DAYS_SHORT[i]} ${d.getDate()}`,
      isToday,
      aria: `${dayName(key)}${isToday ? ", aujourd'hui" : ''}, ${STATE_LABEL[st]}`,
      hollow: st === 'empty' || st === 'future',
      off: !isWorkDay(key),
      total: st === 'absent' ? '—' : found?.total ? `${fmtShare(found.total)} j` : '',
    }
  })
  const weekPending = weekDays.filter((d) => PENDING.includes(d.state))
  const nextDay = weekPending.find((d) => d.key !== shownDay) ?? null

  // What the mascot says about this day.
  const hints: Record<DayState, string> = {
    future: "Ce jour n'est pas encore arrivé. Coin.",
    empty: 'Rien dans git ni dans tes tâches pour l’instant.',
    to_fill: 'Un jour de travail sans rien dans git ni dans tes tâches. Réunions ? Absence ?',
    off: 'Jour non travaillé. Repos !',
    recorded: shownDay === today ? 'Journée dans le Time Log. Je fais une sieste.' : 'Cette journée est déjà dans le Time Log.',
    absent: 'Journée d’absence, bien notée dans le Time Log.',
    modified: 'Tu modifies une journée déjà envoyée : renvoie-la quand c’est bon.',
    to_validate: orphans.length
      ? "Des commits sur une branche sans tâche… c'était pour quoi ?"
      : `J'ai réparti ${shownDay === today ? 'ta journée' : 'cette journée'} d'après git et tes tâches. Tu valides ?`,
  }
  useHint(view ? hints[state] : null, state === 'recorded' ? 'sleep' : 'listen')

  // ---------- editing

  const edit = (change: (lines: Line[]) => Line[]) => {
    setLines(change(lines.map((l) => ({ ...l }))))
    queueSave()
  }
  const step = (index: number, delta: number) =>
    edit((ls) => {
      ls[index].share = Math.min(DAY_SHARES, Math.max(0, ls[index].share + delta))
      return ls
    })
  const setShares = (from: Line[], left: number, right: number | null, delta: number) => {
    const next = shift(
      from.map((l) => l.share),
      left,
      right,
      delta
    )
    if (next) setLines(from.map((l, i) => ({ ...l, share: next[i] })))
  }
  const grab = (e: PointerEvent<HTMLSpanElement>, left: number, right: number | null) => {
    if (e.button !== 0 || !bar.current) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x0: e.clientX, width: bar.current.getBoundingClientRect().width, scale, from: lines, left, right }
  }
  const move = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current
    if (!d) return
    setShares(d.from, d.left, d.right, Math.round(((e.clientX - d.x0) / d.width) * d.scale))
  }
  // A drag saves once, when the grip is released.
  const drop = () => {
    if (!drag.current) return
    drag.current = null
    if (editsRef.current) queueSave()
  }
  const nudge = (e: KeyboardEvent, left: number, right: number | null, delta: number) => {
    e.preventDefault()
    setShares(lines, left, right, delta)
    queueSave()
  }
  const setLabel = (index: number, label: string) => {
    const before = lineId(lines[index])
    const next = lines.map((l) => ({ ...l }))
    next[index].label = label
    next[index].key = lineKey(next[index])
    setLines(next)
    queueSave()
    // The open line stays open under its new identity.
    if (selected === before) setSelected(lineId(next[index]))
  }
  const setProp = (index: number, name: string, value: Props[string]) =>
    edit((ls) => {
      ls[index].props = { ...ls[index].props, [name]: value }
      return ls
    })
  const remove = (index: number) => {
    if (selected === lineId(lines[index])) setSelected(null)
    edit((ls) => ls.filter((_, i) => i !== index))
  }
  // A new line, with a task or without (a meeting, a deployment…), at 0 until given a share.
  const add = (taskId: string) => {
    const line: Line = {
      id: null,
      key: '',
      taskId: taskId || null,
      label: view?.defaultLabel ?? labels[0] ?? '',
      share: 0,
      confirmed: true,
      repo: null,
      branch: null,
      props: {},
      tiny: false,
      reason: '',
      url: null,
    }
    line.key = lineKey(line)
    edit((ls) => [...ls, line])
    setSelected(lineId(line))
  }

  const run = async (action: () => Promise<unknown>) => {
    workingRef.current = true
    setWorking(true)
    try {
      await busy(action())
    } catch (err) {
      fail(err)
    } finally {
      workingRef.current = false
      setWorking(false)
    }
  }
  // The actions below replace the draft: what waits to be saved is dropped.
  const act = (call: (d: string) => Promise<DayView>, after?: () => void) => {
    dropPending()
    setMoreOpen(false)
    void run(async () => {
      show(await call(shownDay))
      loadWeek()
      loadSummary()
      after?.()
    })
  }
  // Settles a line without a task: attached (which links its branch), or kept as such.
  const resolve = async (index: number, change: { taskId?: string; confirmed?: boolean }) => {
    const line = lines[index]
    await flush()
    // After a save the ids change: the line is found again by its branch.
    const saved = viewRef.current?.lines.find((l) => l.key === line.key)
    if (!saved) return
    await run(async () => {
      show(await api.resolve(shownDay, saved.id, change))
      loadWeek()
      if (change.taskId) {
        const task = tasks.find((t) => t.id === change.taskId)
        react('quack', `Coin ! Cette branche va sur ${task?.title ?? 'la tâche'}.`)
      }
    })
  }
  // Nothing is written to the source until the user asks.
  const startTask = (taskId: string, status: string) =>
    void run(async () => {
      setBoard(await moveTask(taskId, status))
      react('quack', `${tasks.find((t) => t.id === taskId)?.title ?? 'La tâche'} passe en ${status}, coin !`)
    })
  const send = () => {
    const n = lines.filter((l) => l.share > 0).length
    openDialog((close) => (
      <Modal label="Envoyer la journée au Time Log" onClose={close}>
        <h2>Envoyer la journée au Time Log ?</h2>
        <p>
          {n} ligne{n > 1 ? 's' : ''} {n > 1 ? 'seront écrites' : 'sera écrite'} dans le Time Log ; les lignes de ce jour qui n'y sont plus
          seront retirées.
        </p>
        <div className="row">
          <span className="grow" />
          <button type="button" className="btn" onClick={close}>
            Annuler
          </button>
          <button
            type="button"
            className="btn-cta"
            onClick={() => {
              close()
              void (async () => {
                await flush()
                await run(async () => {
                  show(await api.send(shownDay))
                  loadWeek()
                  loadSummary()
                  react('quack', 'Coin coin ! Tout est parti dans le Time Log.', 'Journée envoyée dans le Time Log')
                })
              })()
            }}
          >
            Envoyer
          </button>
        </div>
      </Modal>
    ))
  }

  const valueOf = (props: Props, name: string) => {
    const v = props[name]
    return v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v)
  }

  return (
    <div className="page lit-temps">
      {/* The week on the left, the chosen day on the right. */}
      <section className="panel lit-week" aria-label="Choisir un jour">
        <div className="row lit-week-head">
          <button type="button" className="btn icon" aria-label="Semaine précédente" onClick={() => go(dayKey(addDays(parseDay(day), -7)))}>
            ‹
          </button>
          <div className="lit-week-title">
            <div className="baloo lit-week-name">Semaine {weekNumber(weekStart)}</div>
            <div className="legend">{weekRange(weekStart)}</div>
          </div>
          <button type="button" className="btn icon" aria-label="Semaine suivante" onClick={() => go(dayKey(addDays(parseDay(day), 7)))}>
            ›
          </button>
        </div>
        <div className="row lit-week-actions">
          <button type="button" className="btn grow" onClick={() => go(today)}>
            Aujourd'hui
          </button>
          <div className="grow lit-cal-anchor">
            <button
              type="button"
              className="btn lit-cal-toggle"
              aria-expanded={cal !== null}
              aria-haspopup="dialog"
              onClick={() => {
                const d = parseDay(day)
                setCal((c) => (c ? null : { y: d.getFullYear(), m: d.getMonth() }))
              }}
            >
              Calendrier
            </button>
            {cal && (
              <Calendar
                cursor={cal}
                onCursor={setCal}
                month={month}
                day={day}
                today={today}
                onPick={(key) => {
                  go(key)
                  setCal(null)
                }}
                onClose={() => setCal(null)}
              />
            )}
          </div>
        </div>
        {/* One stop for Tab, the arrows go to the previous or next day and show it. */}
        <div
          className="lit-week-days"
          role="listbox"
          aria-label="Jours de la semaine"
          tabIndex={0}
          aria-activedescendant={`lit-day-${day}`}
          onKeyDown={(e) => {
            const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
            if (!delta) return
            e.preventDefault()
            go(dayKey(addDays(parseDay(day), delta)))
          }}
        >
          {weekDays.map((d) => (
            <div
              key={d.key}
              id={`lit-day-${d.key}`}
              role="option"
              aria-selected={d.key === day}
              aria-label={d.aria}
              className={`lit-week-day${d.isToday ? ' today' : ''}${d.off ? ' off' : ''}`}
              onClick={() => go(d.key)}
            >
              <span className={`dot lit-week-dot${d.hollow ? ' hollow' : ''}`} style={{ background: STATE_DOT[d.state] }} />
              <span className="lit-week-day-name">
                {d.label}
                {d.isToday && <span className="lit-week-day-today"> · aujourd'hui</span>}
              </span>
              <span className="lit-week-day-state">{STATE_LABEL[d.state]}</span>
              <span className={`baloo lit-week-day-total${d.state === 'recorded' ? ' recorded' : ''}`}>{d.total}</span>
            </div>
          ))}
        </div>
        <div className="row lit-week-work">
          <span className="legend grow">
            Jours de travail : <span className="lit-nowrap">{workText(workDays)}</span>
          </span>
          <button type="button" className="btn" onClick={() => navigate('/reglages/lunar-industries-temps')}>
            Réglages
          </button>
        </div>
        {weekPending.length > 0 && (
          <div className="lit-week-pending">
            <span className="lit-week-pending-text">
              {weekPending.length} journée{weekPending.length > 1 ? 's' : ''} à valider ou à remplir cette semaine
            </span>
            <button type="button" className="btn-cta" onClick={() => go(weekPending[0].key)}>
              Ouvrir le plus ancien
            </button>
          </div>
        )}
      </section>

      <section className="panel lit-day" aria-labelledby="lit-day-title">
        <div className="row lit-day-head">
          <h2 id="lit-day-title" className="baloo lit-day-title">
            {dayTitle(shownDay)}
          </h2>
          {view && <span className={`tag lit-tone-${recorded ? 'ok' : PENDING.includes(state) ? 'warn' : 'neutral'}`}>{STATE_LABEL[state]}</span>}
          {offWithActivity && <span className="legend">Jour non travaillé d'après tes réglages, mais il y a eu de l'activité.</span>}
          <span className="grow" />
          {editable && (
            <div className="lit-more">
              <button
                type="button"
                className="btn icon"
                aria-label="Autres actions"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                disabled={working}
                onClick={() => setMoreOpen((o) => !o)}
              >
                …
              </button>
              {moreOpen && (
                <div className="menu lit-more-menu" role="menu" onKeyDown={(e) => e.key === 'Escape' && setMoreOpen(false)}>
                  <button type="button" role="menuitem" className="menu-item" autoFocus onClick={() => act(api.absent)}>
                    Marquer absent
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => act(api.recompute, () => react('quack', "J'ai tout recalculé depuis git et tes tâches."))}
                  >
                    Recalculer depuis git et les tâches
                  </button>
                  {state === 'modified' && (
                    <>
                      <div className="menu-sep" role="separator" />
                      <button type="button" role="menuitem" className="menu-item" onClick={() => act(api.discard)}>
                        Abandonner les modifications
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {view?.logProblem && editable && <p className="lit-problem">{view.logProblem}</p>}

        {showLines ? (
          <>
            <div className="lit-bar-wrap">
              <div className="lit-bar" ref={bar}>
                {rest && (
                  <span className="lit-rest" style={{ left: `${rest.left}%`, width: `${rest.width}%` }}>
                    {rest.text}
                  </span>
                )}
                {segments.map((s) => (
                  <span key={s.row.rowId}>
                    <button
                      type="button"
                      className={`lit-seg${s.row.orphan ? ' orphan' : ''}`}
                      data-size={s.size}
                      style={{ left: `${s.left}%`, width: `${s.width}%`, ['--c' as string]: s.row.color, ['--on-c' as string]: s.row.ink }}
                      title={`${s.row.name} · ${s.row.label} · ${fmtShare(s.row.share)} j`}
                      aria-label={`${s.row.name}, ${s.row.label}, ${fmtShare(s.row.share)} j`}
                      aria-pressed={selected === s.row.rowId}
                      onClick={() => setSelected((x) => (x === s.row.rowId ? null : s.row.rowId))}
                    >
                      {s.size === 'lg' && <span className={`ellipsis lit-seg-title${s.row.orphan ? ' mono' : ''}`}>{s.row.name}</span>}
                      {s.size !== 'sm' && <span className="baloo lit-seg-share">{fmtShare(s.row.share)}</span>}
                    </button>
                    {editable && (
                      // After the last segment, the grip moves the end of the day's filled part.
                      <span
                        className="lit-grip"
                        role="separator"
                        tabIndex={0}
                        aria-orientation="vertical"
                        aria-valuemin={1}
                        aria-label={s.next ? `Frontière entre ${s.row.name} et ${s.next.name}` : `Fin de ${s.row.name}`}
                        aria-valuenow={s.row.share}
                        aria-valuetext={`${fmtShare(s.row.share)} j`}
                        style={{ left: `${s.left + s.width}%` }}
                        onPointerDown={(e) => grab(e, s.row.index, s.next?.index ?? null)}
                        onPointerMove={move}
                        onPointerUp={drop}
                        onPointerCancel={drop}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowLeft') nudge(e, s.row.index, s.next?.index ?? null, -1)
                          if (e.key === 'ArrowRight') nudge(e, s.row.index, s.next?.index ?? null, 1)
                        }}
                      />
                    )}
                  </span>
                ))}
              </div>
              <div className="legend lit-scale" aria-hidden="true">
                <span>0</span>
                <span>0,25</span>
                <span>0,5</span>
                <span>0,75</span>
                <span>1 j</span>
              </div>
            </div>

            {/* The bar's key: one row per line, in the bar's order; one line open at a time. */}
            <ul className="lit-lines">
              {rows.map((r) => {
                const open = selected === r.rowId
                return (
                  <li key={r.rowId} className={`lit-line${r.share ? '' : ' zero'}${open ? ' open' : ''}`}>
                    <div className="lit-line-row">
                      <button
                        type="button"
                        className="lit-line-name"
                        aria-expanded={open}
                        onClick={() => setSelected(open ? null : r.rowId)}
                      >
                        <span className="lit-chevron" aria-hidden="true">
                          ›
                        </span>
                        <span className={`dot lit-chip-dot${r.orphan ? ' orphan' : ''}`} style={r.orphan ? undefined : { background: r.color }} />
                        <span className={`ellipsis lit-line-title${r.orphan ? ' mono' : ''}`}>{r.name}</span>
                        {r.where && !r.orphan && <span className="mono ellipsis lit-line-where">{r.where}</span>}
                        {r.orphan && <span className="tag lit-tone-bad">sans tâche</span>}
                        {r.kept && <span className="tag lit-tone-neutral">sans tâche, voulu</span>}
                        {r.tiny && <span className="tag lit-tone-warn">moins de 0,05 j</span>}
                      </button>
                      {editable ? (
                        <>
                          <select className="lit-line-label" aria-label={`Étiquette de ${r.name}`} value={r.label} onChange={(e) => setLabel(r.index, e.target.value)}>
                            {[...new Set([...labels, r.label])].filter(Boolean).map((l) => (
                              <option key={l} value={l}>
                                {l}
                              </option>
                            ))}
                          </select>
                          <span className="row lit-line-step">
                            <button type="button" className="btn icon" aria-label={`Retirer 0,05 à ${r.name}`} disabled={!r.share} onClick={() => step(r.index, -1)}>
                              −
                            </button>
                            <span className="baloo lit-line-share">{fmtShare(r.share)}</span>
                            <button
                              type="button"
                              className="btn icon"
                              aria-label={`Ajouter 0,05 à ${r.name}`}
                              disabled={r.share >= DAY_SHARES}
                              onClick={() => step(r.index, 1)}
                            >
                              +
                            </button>
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="tag lit-tone-neutral">{r.label}</span>
                          <span className="baloo lit-line-share">{fmtShare(r.share)}</span>
                        </>
                      )}
                    </div>

                    {/* A branch whose commits belong to no task: settled here, under its line, before sending. */}
                    {editable && r.orphan && (
                      <div className="lit-line-fix" role="group" aria-label={`Branche ${r.where ?? ''}`}>
                        <p>
                          Des commits sur <span className="mono">{r.where}</span> ne sont liés à aucune tâche. C'était pour quoi ?
                        </p>
                        <div className="row lit-attach">
                          <TaskPicker tasks={tasks} columns={columns} label="Rattacher à une tâche" onPick={(id) => void resolve(r.index, { taskId: id })} />
                          <button type="button" className="btn" disabled={working} onClick={() => void resolve(r.index, { confirmed: true })}>
                            Garder sans tâche
                          </button>
                        </div>
                      </div>
                    )}

                    {open && (
                      <div className="lit-line-detail">
                        {r.taskId && r.title !== r.name && <span className="legend">{r.title}</span>}
                        {r.reason && <span className="legend">Proposé d'après {r.reason}</span>}
                        {r.start && r.taskId && (
                          <button type="button" className="btn lit-started" disabled={working} onClick={() => startTask(r.taskId!, r.start!.name)}>
                            Encore « à faire » malgré des commits : passer en {r.start.name}
                          </button>
                        )}
                        {r.evidence.length > 0 && (
                          <ul className="lit-evidence">
                            {r.evidence.map((s, i) => (
                              <li key={i} className="row">
                                <span className="mono muted">{s.time}</span>
                                <span className="tag lit-tone-neutral">{s.kind}</span>
                                <span className="ellipsis">{s.detail}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {extras.length > 0 &&
                          (editable ? (
                            // The Time Log's other properties for this line.
                            <div className="fields">
                              {extras.map((x) =>
                                x.type === 'select' ? (
                                  <label key={x.name} className="field">
                                    {x.name}
                                    <select value={valueOf(r.props, x.name)} onChange={(e) => setProp(r.index, x.name, e.target.value || null)}>
                                      <option value="">—</option>
                                      {(x.options ?? []).map((o) => (
                                        <option key={o} value={o}>
                                          {o}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                ) : x.type === 'multi_select' ? (
                                  <div key={x.name} className="field">
                                    {x.name}
                                    <div className="row lit-chips" role="group" aria-label={x.name}>
                                      {(x.options ?? []).map((o) => {
                                        const current = Array.isArray(r.props[x.name]) ? (r.props[x.name] as string[]) : []
                                        const on = current.includes(o)
                                        return (
                                          <button
                                            key={o}
                                            type="button"
                                            className="chip-btn"
                                            aria-pressed={on}
                                            onClick={() => setProp(r.index, x.name, on ? current.filter((v) => v !== o) : [...current, o])}
                                          >
                                            {o}
                                          </button>
                                        )
                                      })}
                                    </div>
                                  </div>
                                ) : x.type === 'checkbox' ? (
                                  <label key={x.name} className="field lit-check">
                                    <input type="checkbox" checked={r.props[x.name] === true} onChange={(e) => setProp(r.index, x.name, e.target.checked)} />
                                    {x.name}
                                  </label>
                                ) : (
                                  <label key={x.name} className="field">
                                    {x.name}
                                    <input
                                      type={x.type === 'number' ? 'number' : 'text'}
                                      defaultValue={valueOf(r.props, x.name)}
                                      onBlur={(e) => {
                                        const raw = e.target.value
                                        const value = raw === '' ? null : x.type === 'number' ? Number(raw) : raw
                                        if (value !== (r.props[x.name] ?? null)) setProp(r.index, x.name, value)
                                      }}
                                    />
                                  </label>
                                )
                              )}
                            </div>
                          ) : (
                            extras.map((x) => {
                              const v = valueOf(r.props, x.name)
                              return v ? (
                                <span key={x.name} className="legend">
                                  {x.name} : {v}
                                </span>
                              ) : null
                            })
                          ))}
                        <div className="row lit-line-actions">
                          {r.url && (
                            <a className="btn" href={r.url} target="_blank" rel="noreferrer">
                              Ouvrir dans le Time Log
                            </a>
                          )}
                          {editable && (
                            <button type="button" className="btn" onClick={() => remove(r.index)}>
                              Retirer la ligne
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>

            {editable && (
              <div className="row lit-attach lit-add">
                <TaskPicker tasks={tasks} columns={columns} label="Ajouter une ligne" onPick={add} />
                <button type="button" className="btn" onClick={() => add('')}>
                  Sans tâche (réunion, veille…)
                </button>
              </div>
            )}
          </>
        ) : (
          view && (
            // A day without lines: what it means, and what can be done about it.
            <div className="lit-empty">
              {state === 'to_fill' ? (
                <>
                  <h3 className="baloo">Jour de travail sans activité</h3>
                  <p className="legend">Un jour de travail passé doit figurer dans le Time Log : ajoute une ligne (réunion, veille…) ou marque une absence.</p>
                </>
              ) : state === 'off' ? (
                <>
                  <h3 className="baloo">Jour non travaillé</h3>
                  <p className="legend">D'après tes réglages, rien n'est attendu ce jour-là.</p>
                </>
              ) : state === 'absent' ? (
                <>
                  <h3 className="baloo">Absent ce jour-là</h3>
                  <p className="legend">La journée est notée comme absence dans le Time Log.</p>
                </>
              ) : state === 'future' ? (
                <>
                  <h3 className="baloo">Ce jour n'est pas encore passé</h3>
                  <p className="legend">Il sera proposé une fois passé.</p>
                </>
              ) : (
                <>
                  <h3 className="baloo">Aucune activité pour l'instant</h3>
                  <p className="legend">La journée se remplira avec tes commits et tes changements de statut.</p>
                </>
              )}
              {editable && (
                <>
                  <div className="row lit-attach lit-empty-add">
                    <TaskPicker tasks={tasks} columns={columns} label={state === 'off' ? 'Ajouter une ligne quand même' : 'Ajouter une ligne'} onPick={add} />
                    <button type="button" className="btn" onClick={() => add('')}>
                      Sans tâche
                    </button>
                  </div>
                  {state !== 'off' && (
                    <button type="button" className="btn" disabled={working} onClick={() => act(api.absent)}>
                      Marquer absent
                    </button>
                  )}
                </>
              )}
            </div>
          )
        )}

        {/* The day's send bar: what sending needs, then the button; for a recorded day, when it was sent. */}
        {editable && showLines ? (
          <footer className="lit-foot">
            <ul className="lit-checks">
              {checks.map((c, i) => (
                <li key={i} className={`lit-check-line${c.ok ? ' ok' : ''}`}>
                  <span aria-hidden="true">{c.ok ? '✓' : '!'}</span>
                  {c.text}
                </li>
              ))}
            </ul>
            <span className="legend" aria-live="polite">
              {draftNote}
            </span>
            {state === 'modified' && (
              <button type="button" className="btn" disabled={working} onClick={() => act(api.discard)}>
                Annuler les modifications
              </button>
            )}
            <button type="button" className="btn-cta" disabled={!canSend} onClick={send}>
              {state === 'modified' ? 'Renvoyer au Time Log' : 'Envoyer au Time Log'}
            </button>
          </footer>
        ) : recorded ? (
          <footer className="lit-foot">
            <span className="lit-check-line ok">
              <span aria-hidden="true">✓</span>
              Envoyée dans le Time Log {sentAtText(view?.sentAt ?? null)}
            </span>
            {nextDay && (
              <button type="button" className="btn" onClick={() => go(nextDay.key)}>
                Jour suivant à valider : {dayName(nextDay.key)}
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn" disabled={working} onClick={() => act(api.edit)}>
              Modifier
            </button>
          </footer>
        ) : null}
      </section>
    </div>
  )
}
