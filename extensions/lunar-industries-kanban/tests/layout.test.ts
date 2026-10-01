import type { Board, Task } from '@bidule/sdk'
import { describe, expect, test } from 'vitest'
import type { KanbanBranch } from '../contract.ts'
import { badgeOf, branchKey, branchLabel, groupsOf, linkRows, marksOf, orphansOf, shortBranch } from '../ui/layout.ts'

const task = (id: string, status: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: `Tâche ${id}`,
  status,
  ref: null,
  url: null,
  role: 'owner',
  lastEdited: null,
  due: null,
  ...patch,
})

const board: Board = {
  source: 'Notion',
  configured: true,
  columns: [
    { name: 'À faire', color: 'gray', group: 'todo' },
    { name: 'Backlog', color: 'gray', group: 'todo' },
    { name: 'En cours', color: 'blue', group: 'doing' },
    { name: 'Terminé', color: 'green', group: 'done' },
  ],
  tasks: [task('1', 'À faire'), task('2', 'En cours'), task('3', 'Terminé'), task('4', 'Archivé')],
}

const branch = (name: string, patch: Partial<KanbanBranch> = {}): KanbanBranch => ({
  repo: '/r/app',
  repoLabel: 'app',
  name,
  taskId: null,
  isDefault: false,
  lastCommitAt: new Date().toISOString(),
  reviewNumber: null,
  reviewRef: null,
  reviewState: null,
  ci: null,
  ...patch,
})

describe('columns', () => {
  test('consecutive columns of a group share its heading; a status the source dropped stands alone', () => {
    const groups = groupsOf(board, [], new Set())
    expect(groups.map((g) => [g.label, g.columns.map((c) => c.name)])).toEqual([
      ['À faire', ['À faire', 'Backlog']],
      ['En cours', ['En cours']],
      ['Terminé', ['Terminé']],
      ['', ['Archivé']],
    ])
    expect(groups.at(-1)!.columns[0].unknown).toBe(true)
  })

  test('finished columns start folded, unless the user unfolded them; folded ones take no spare width', () => {
    const folded = groupsOf(board, [], new Set())
    expect(folded[2].columns[0].folded).toBe(true)
    expect(folded[2].grow).toBe(0)
    expect(folded[0].grow).toBe(2)
    const open = groupsOf(board, [], new Set(['Terminé', 'Backlog']))
    expect(open[2].columns[0].folded).toBe(false)
    expect(open[0].columns[1].folded).toBe(true)
  })

  test('hidden columns are left out', () => {
    expect(groupsOf(board, ['Backlog'], new Set())[0].columns.map((c) => c.name)).toEqual(['À faire'])
  })
})

describe('badges', () => {
  const today = '2026-10-01'
  test("due today is urgent, a past date late, a close one warm; a finished task has none", () => {
    expect(badgeOf(task('1', 'x', { due: '2026-10-01T09:00:00' }), false, today)).toEqual({ text: "Aujourd'hui", tone: 'accent' })
    expect(badgeOf(task('1', 'x', { due: '2026-09-28' }), false, today)?.tone).toBe('bad')
    expect(badgeOf(task('1', 'x', { due: '2026-10-03' }), false, today)?.tone).toBe('warn')
    expect(badgeOf(task('1', 'x', { due: '2026-10-20' }), false, today)?.tone).toBe('neutral')
    expect(badgeOf(task('1', 'x', { due: '2026-09-28' }), true, today)).toBeNull()
    expect(badgeOf(task('1', 'x'), false, today)).toBeNull()
  })
})

describe('branches', () => {
  test('a branch is shown without its type and its task ID; the others counted', () => {
    expect(shortBranch('feat/TSK-42-export-csv')).toBe('export-csv')
    expect(shortBranch('tsk-7-fix')).toBe('fix')
    expect(branchLabel([branch('feat/TSK-1-a'), branch('fix/TSK-1-b')])).toBe('a +1')
    expect(branchLabel([])).toBe('sans branche')
  })

  test('the tray holds the recent branches without a task, not merged', () => {
    const now = Date.parse('2026-10-01T12:00:00Z')
    const list = [
      branch('recent', { lastCommitAt: '2026-09-30T12:00:00Z' }),
      branch('old', { lastCommitAt: '2026-09-01T12:00:00Z' }),
      branch('linked', { lastCommitAt: '2026-09-30T12:00:00Z', taskId: 't' }),
      branch('merged', { lastCommitAt: '2026-09-30T12:00:00Z', reviewState: 'merged' }),
    ]
    expect(orphansOf(list, now).map((b) => b.name)).toEqual(['recent'])
  })

  test('one mark per branch with a review or a pipeline', () => {
    const marks = marksOf([
      branch('a', { reviewRef: 'MR !12', reviewNumber: 12, ci: 'fail' }),
      branch('b', { ci: 'pending' }),
      branch('c', { ci: 'none' }),
    ])
    expect(marks.map((m) => [m.text, m.tone, m.tip])).toEqual([
      ['!12', 'bad', 'app · MR !12 · CI en échec'],
      ['CI', 'warn', 'app · CI en cours'],
    ])
  })

  test('the dialog lists the task’s branches first, then free ones, then the others’, merged last', () => {
    const list = [
      branch('merged', { reviewState: 'merged' }),
      branch('other', { taskId: 'x' }),
      branch('free'),
      branch('mine', { taskId: 't' }),
      branch('elsewhere', { repo: '/r/lib', repoLabel: 'lib' }),
    ]
    const rows = linkRows(list, 't', '', () => 'Une autre', new Set([branchKey(list[3])]))
    expect(rows.map((r) => r.name)).toEqual(['mine', 'free', 'other', 'merged', 'elsewhere'])
    expect(rows[0].checked).toBe(true)
    expect(rows[2].note).toBe('liée à Une autre')
    expect(linkRows(list, 't', 'LIB', () => '', new Set()).map((r) => r.name)).toEqual(['elsewhere'])
  })
})
