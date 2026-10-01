import { describe, expect, test } from 'vitest'
import { findTasks, hintOf, orphansOf, reposOf, rowOf, statusOf, stepOf } from '../ui/steps.ts'
import { listed, task } from './fakes.ts'

describe('a branch’s step', () => {
  test('a task, then a review, then its CI, then the merge', () => {
    expect(stepOf(listed({ name: 'a' }))).toBe('task')
    expect(stepOf(listed({ name: 'a', taskId: 't' }))).toBe('review')
    expect(stepOf(listed({ name: 'a', taskId: 't', forge: null, reviewNumber: 3 }))).toBe('review')
    expect(stepOf(listed({ name: 'a', taskId: 't', reviewNumber: 3, reviewState: 'closed' }))).toBe('review')
    expect(stepOf(listed({ name: 'a', taskId: 't', reviewNumber: 3, reviewState: 'open', ci: 'fail' }))).toBe('ci')
    expect(stepOf(listed({ name: 'a', taskId: 't', reviewNumber: 3, reviewState: 'open', ci: 'ok' }))).toBe('merge')
    expect(stepOf(listed({ name: 'a', taskId: 't', reviewState: 'merged' }))).toBe('done')
  })

  test('what the list says of it', () => {
    const say = (b: ReturnType<typeof listed>) => statusOf(b, stepOf(b), 'MR')
    expect(say(listed({ name: 'a' }))).toBe('Sans tâche')
    expect(say(listed({ name: 'a', taskId: 't', forge: null }))).toBe('Liée, sans forge')
    expect(say(listed({ name: 'a', taskId: 't' }))).toBe('À proposer')
    expect(say(listed({ name: 'a', taskId: 't', reviewNumber: 3, reviewState: 'closed' }))).toBe('MR fermée')
    expect(say(listed({ name: 'a', taskId: 't', reviewNumber: 3, reviewState: 'open', ci: 'pending' }))).toBe('En revue, CI en cours')
    expect(say(listed({ name: 'a', taskId: 't', reviewNumber: 3, reviewState: 'open', ci: 'ok' }))).toBe('Prête à fusionner')
  })

  test('the steps reached, and the review named after its forge', () => {
    const r = rowOf(listed({ name: 'a', taskId: 't', reviewNumber: 3, reviewState: 'open', ci: 'fail', forge: 'github' }), [task('t', 'T')])
    expect(r.progress).toEqual([true, true, false, false])
    expect(r.steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo'])
    expect(r.reviewLabel).toBe('PR #3')
    expect(r.task?.title).toBe('T')
    expect(rowOf(listed({ name: 'b', reviewNumber: 4 }), []).reviewLabel).toBe('MR !4')
  })
})

describe('the list', () => {
  const listing = {
    branches: [
      listed({ name: 'old', reviewState: 'merged' }),
      listed({ name: 'new' }),
      listed({ name: 'x', repo: '/r/lib', repoLabel: 'lib' }),
    ],
    repos: [
      { path: '/r/app', label: 'app', forge: 'gitlab' as const, targets: ['main', 'develop'], reviewTarget: null },
      { path: '/r/lib', label: 'lib', forge: null, targets: ['main'], reviewTarget: 'main' },
      { path: '/r/empty', label: 'empty', forge: null, targets: [], reviewTarget: null },
    ],
    defaultTarget: 'develop',
  }

  test('by repo, merged branches hidden unless asked, then last; the settings’ target when the repo has it', () => {
    const repos = reposOf(listing, [], false)
    expect(repos.map((r) => r.path)).toEqual(['/r/app', '/r/lib', '/r/empty'])
    expect(repos[0].rows.map((r) => r.name)).toEqual(['new'])
    expect(repos[0].merged).toBe(1)
    expect(repos[0].target).toBe('develop')
    expect(repos[1].target).toBe('main')
    expect(repos[2].rows).toEqual([])
    expect(reposOf(listing, [], true)[0].rows.map((r) => r.name)).toEqual(['new', 'old'])
  })

  test('the recent branches without a task, and what the mascot says', () => {
    const now = Date.now()
    const stale = listed({ name: 's', lastCommitAt: new Date(now - 20 * 864e5).toISOString() })
    expect(orphansOf([...listing.branches, stale], now).map((b) => b.name)).toEqual(['new', 'x'])
    expect(hintOf(listing, null, now).line).toBe('2 branches récentes sans tâche. On les rattache ?')
    const red = { ...listing, branches: [listed({ name: 'b', ci: 'fail' })] }
    expect(hintOf(red, 'Coin ! Ta CI saigne.', now)).toEqual({ mode: 'panic', line: 'Coin ! Ta CI saigne. (b)' })
    expect(hintOf({ ...listing, branches: [] }, null, now).line).toMatch(/aucune branche/)
  })

  test('a task is found by its title, its ID or a branch, those not done first', () => {
    const tasks = [task('1', 'Fini', { status: 'Terminé' }), task('2', 'Écran de connexion', { ref: 'TSK-4' }), task('3', 'Autre fini')]
    const done = new Set(['Terminé'])
    const branches = [listed({ name: 'feat/tsk-9-paiement', taskId: '3' })]
    expect(findTasks(tasks, done, branches, 'ecran').map((t) => t.id)).toEqual(['2'])
    expect(findTasks(tasks, done, branches, 'tsk-4').map((t) => t.id)).toEqual(['2'])
    expect(findTasks(tasks, done, branches, 'paiement').map((t) => t.id)).toEqual(['3'])
    expect(findTasks(tasks, done, branches, 'fini').map((t) => t.id)).toEqual(['3', '1'])
  })
})
