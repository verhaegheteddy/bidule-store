// Taken from quack-board (tests/unit/day.spec.ts, Simon's « Day »), on fake roles and the store in memory.
import { describe, expect, test } from 'vitest'
import { dayStart } from '../server/engine.ts'
import { setup } from './fakes.ts'

// Monday 21 to Friday 25 September 2026.
const [MON, TUE] = ['2026-09-21', '2026-09-22']
const FRIDAY_EVENING = new Date(2026, 8, 25, 18)
const at = (day: string, h: number) => {
  const d = dayStart(day)
  d.setHours(h)
  return d.toISOString()
}

describe('Day', () => {
  test('integration branches: staging merges go to the merged task, production is deployment', async () => {
    const { git, days } = setup({ now: FRIDAY_EVENING })
    git.branch('r', 'id-1-a', { taskId: 't1' })
    for (const name of ['fix-x', 'factory', 'launchpad', 'orbit']) git.branch('r', name)
    git.event(at(TUE, 8), 'checkout', 'r', 'launchpad')
    git.event(at(TUE, 9), 'commit', 'r', 'id-1-a', 'work')
    git.event(at(TUE, 10), 'commit', 'r', 'factory', "Merge branch 'id-1-a' into factory")
    git.event(at(TUE, 11), 'commit', 'r', 'factory', "Merge branch 'fix-x' into 'factory'")
    git.event(at(TUE, 12), 'commit', 'r', 'factory', "Merge branch 'launchpad' into factory")
    git.event(at(TUE, 14), 'commit', 'r', 'orbit', "Merge branch 'launchpad' into orbit")
    const lines = await days.proposal(TUE, (await import('../server/settings.ts')).DEFAULT_SETTINGS)
    expect(lines.map((l) => [l.taskId, l.branch ?? null, l.label, l.confirmed])).toEqual(
      expect.arrayContaining([
        ['t1', null, 'Développement', false],
        [null, 'fix-x', 'Développement', false],
        [null, null, 'Déploiement', true],
      ])
    )
    expect(lines).toHaveLength(3)
  })

  test('the proposal reuses the task’s last label, else the default one', async () => {
    const { git, store, days } = setup({ now: FRIDAY_EVENING })
    git.branch('r', 'id-1-a', { taskId: 't1' })
    git.branch('r', 'id-2-b', { taskId: 't2' })
    await store.recordLog([{ id: 'p', day: MON, taskId: 't1', label: 'Conception', share: 20, url: null, props: {}, lastEdited: null }], MON, MON)
    git.event(at(TUE, 9), 'commit', 'r', 'id-1-a', 'a')
    git.event(at(TUE, 14), 'commit', 'r', 'id-2-b', 'b')
    await days.refreshDraft(TUE)
    const lines = await store.drafts(TUE)
    expect(lines.map((l) => [l.taskId, l.label]).sort()).toEqual([
      ['t1', 'Conception'],
      ['t2', 'Développement'],
    ])
  })

  test('the state of a day is deduced from the Time Log, the draft and the activity', async () => {
    const { git, store, days } = setup({ now: FRIDAY_EVENING })
    const list = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-30']
    const [recorded, absent, modified, toValidate, toFill, future] = list
    const row = (id: string, day: string, taskId: string | null, label: string) => ({ id, day, taskId, label, share: 20, url: null, props: {}, lastEdited: null })
    await store.recordLog(
      [row('a', recorded, 't1', 'Développement'), row('b', absent, null, 'Absent'), row('c', modified, 't1', 'Développement')],
      '2026-09-01',
      '2026-09-30'
    )
    await store.writeDraft(modified, [{ taskId: 't1', label: 'Développement', share: 20, confirmed: true }], true)
    git.event(at(toValidate, 10), 'commit', 'r', 'x', 'x')
    const stateOf = await days.stateReader(list)
    expect(Object.fromEntries(list.map((d) => [d, stateOf(d)]))).toEqual({
      [recorded]: 'recorded',
      [absent]: 'absent',
      [modified]: 'modified',
      [toValidate]: 'to_validate',
      [toFill]: 'to_fill',
      [future]: 'future',
    })
  })

  test('a day with nothing is to fill on a past work day, off on another day', async () => {
    // Thursday 24, Friday 25, Saturday 26 and Sunday 27 September 2026.
    const [thu, fri, sat, sun] = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
    const later = setup({ now: new Date(2027, 0, 1) })
    later.git.event(at(sun, 10), 'commit', 'r', 'x', 'x')
    const stateOf = await later.days.stateReader([thu, fri, sat, sun])
    expect([thu, fri, sat, sun].map(stateOf)).toEqual(['to_fill', 'to_fill', 'off', 'to_validate'])
    // Today, a work day with nothing yet.
    expect(await setup({ now: FRIDAY_EVENING }).days.dayState(fri)).toBe('empty')
    // Today, a day off with nothing.
    expect(await setup({ now: new Date(2026, 8, 26, 18) }).days.dayState(sat)).toBe('off')
    // From Monday to Thursday: an empty Friday is off.
    const fourDays = setup({ now: new Date(2027, 0, 1), settings: { workDays: new Set([1, 2, 3, 4]) } })
    expect(await fourDays.days.dayState(fri)).toBe('off')
    // An empty list: no day is expected.
    expect(await setup({ now: new Date(2027, 0, 1), settings: { workDays: new Set() } }).days.dayState(thu)).toBe('off')
  })

  test('« Absent » makes the whole day one line without a task', async () => {
    const { store, days } = setup({ now: FRIDAY_EVENING })
    await store.draft(TUE, [{ taskId: 't1', share: 20 }])
    await days.absent(TUE)
    expect((await store.drafts(TUE)).map((l) => [l.taskId, l.label, l.share])).toEqual([[null, 'Absent', 20]])
  })

  test('attaching an orphan line links its branch and joins the task’s line', async () => {
    const { git, store, days } = setup({ now: FRIDAY_EVENING })
    git.branch('r', 'fix-x')
    await store.draft(TUE, [
      { taskId: 't1', share: 15 },
      { taskId: null, repo: 'r', branch: 'fix-x', share: 5 },
    ])
    const orphan = (await store.drafts(TUE)).find((l) => l.branch === 'fix-x')!
    await days.resolve(TUE, orphan.id, { taskId: 't1' })
    expect((await store.drafts(TUE)).map((l) => [l.taskId, l.share])).toEqual([['t1', 20]])
    expect(git.links).toEqual([['r', 'fix-x', 't1']])
    expect(await store.edited(TUE)).toBe(true)
  })

  test('a day the user changed no longer follows the signals; « Recalculer » brings it back', async () => {
    const { git, store, days } = setup({ now: FRIDAY_EVENING })
    git.branch('r', 'id-1-a', { taskId: 't1' })
    git.event(at(TUE, 9), 'commit', 'r', 'id-1-a', 'a')
    await days.replace(TUE, [{ taskId: null, label: 'Réunion', share: 20, confirmed: true }])
    await days.refreshDraft(TUE)
    expect((await store.drafts(TUE)).map((l) => l.label)).toEqual(['Réunion'])
    await days.recompute(TUE)
    expect((await store.drafts(TUE)).map((l) => [l.taskId, l.share])).toEqual([['t1', 20]])
    expect(await store.edited(TUE)).toBe(false)
  })

  test('a task listed twice with the same label is refused', async () => {
    const { days } = setup({ now: FRIDAY_EVENING })
    await expect(
      days.replace(TUE, [
        { taskId: 't1', label: 'Développement', share: 10 },
        { taskId: 't1', label: 'Développement', share: 10 },
      ])
    ).rejects.toThrow(/deux fois/)
  })
})
