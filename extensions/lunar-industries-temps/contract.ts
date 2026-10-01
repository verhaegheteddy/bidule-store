// Lunar Industries - Temps: Simon's Temps module (quack-board), an unofficial one competing with Bidule's own (`temps`).
// A day is worth 1, shared out in twentieths between lines (a task, or none: a meeting, an absence, a deployment),
// each with the label of the Time Log; proposed from git and the source of tasks, then sent to the Time Log (the
// `timeLog` role's fields/read/sendDay). Types only: the interface reads this file.
//
// Its routes, under /api/ext/lunar-industries-temps (shares in twentieths):
//   GET    days/:day                 DayView (the day's draft brought up to date first)
//   POST   days/:day/recompute       DayView « Recalculer »
//   POST   days/:day/edit            DayView « Modifier » (a recorded day becomes a draft)
//   POST   days/:day/absent          DayView « Marquer absent »
//   POST   days/:day/send            DayView, sent to the Time Log
//   PUT    days/:day/draft           { lines: LineInput[] } → DayView
//   DELETE days/:day/draft           DayView, back to the Time Log's lines or the proposal
//   PATCH  days/:day/draft/:id       { taskId } or { confirmed: true } → DayView (a line without a task settled)
//   GET    weeks/:day                { days: DaySummary[] } the week holding the day, Monday first
//   GET    months/:year/:month       { days: DaySummary[] }
//   GET    summary                   Summary

import type { LogField, LogValue } from '@bidule/sdk/tasks'

/**
 * - `recorded`: the Time Log has lines for the day, and there is no draft;
 * - `absent`: a recorded day whose only line is the absence label;
 * - `modified`: a recorded day the user is changing (a draft copied from the Time Log, not sent yet);
 * - `to_validate`: activity, or a draft, but nothing in the Time Log;
 * - `to_fill`: a past work day with nothing at all: missing from the Time Log;
 * - `off`: the same, on a day that is not a work day: nothing expected;
 * - `empty`: today, a work day, with nothing yet;
 * - `future`: nothing to do.
 */
export type DayState = 'future' | 'empty' | 'to_fill' | 'off' | 'to_validate' | 'recorded' | 'absent' | 'modified'

export type Props = Record<string, LogValue>

// A line of the day as the page shows it: from the Time Log for a recorded day, from the draft otherwise.
export type DayLine = {
  id: string
  key: string
  source: 'log' | 'draft'
  taskId: string | null
  label: string
  share: number
  repo: string | null
  branch: string | null
  // Some activity, too little to reach 0.05.
  tiny: boolean
  // A line without a task kept on purpose (or a deployment, or added by hand).
  confirmed: boolean
  reason: string
  url: string | null
  props: Props
}

// A signal of the day, with the line it supports: the evidence behind the proposal.
export type DaySignal = {
  minute: number
  kind: string
  key: string
  repo: string | null
  branch: string | null
  detail: string
}

export type DayView = {
  day: string
  isToday: boolean
  state: DayState
  total: number
  // When the Time Log last changed the day's lines: when it was sent, or edited there since.
  sentAt: string | null
  lines: DayLine[]
  signals: DaySignal[]
  // The labels a line takes, and the one a line added by hand starts with.
  labels: string[]
  defaultLabel: string
  // The Time Log's other properties a line may fill in.
  extras: LogField[]
  // Null when the Time Log can be read and written a whole day at a time (the timeLog role's fields, read and
  // sendDay), else why not: the day can be prepared, not sent.
  logProblem: string | null
}

export type DaySummary = { day: string; state: DayState; total: number }

export type Summary = {
  todayState: DayState
  // Days to validate or fill among the last 7 (today included).
  pendingDays: number
  // ISO numbers, 1 = Monday.
  workDays: number[]
}

// A draft line as the page sends it.
export type LineInput = {
  taskId: string | null
  label: string
  share: number
  confirmed?: boolean
  repo?: string | null
  branch?: string | null
  props?: Props
}

declare module '@bidule/sdk/contracts' {
  interface Events {
    // The days changed (a draft saved, a day sent, new activity): whoever shows them reloads.
    'lunar-industries-temps.changed': Record<string, never>
  }
}
