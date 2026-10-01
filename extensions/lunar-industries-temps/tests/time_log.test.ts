// Taken from quack-board (tests/unit/time_log.spec.ts, Simon's « Time log »), through the timeLog role's sendDay
// and read (a fake Time Log that keeps one entry per task, label and day, as Notion's does).
import { describe, expect, test } from 'vitest'
import { FakeTimeLog, PlainTimeLog, setup } from './fakes.ts'

const DAY = '2026-09-22'
const NEXT_DAY = new Date(2026, 8, 23, 9)

describe('Time log', () => {
  test('a day sent makes one entry per task and label', async () => {
    const log = new FakeTimeLog()
    const sent = setup({ now: NEXT_DAY, log })
    await sent.store.draft(DAY, [
      { taskId: 't1', share: 12, props: { 'Type événement': null } },
      { taskId: null, label: 'Réunion', share: 5, confirmed: true },
      // A line without a task kept on purpose, with the same label: one entry with the other.
      { taskId: null, repo: 'r', branch: 'fix', label: 'Réunion', share: 3, confirmed: true },
      { taskId: 't2', share: 0 },
    ])
    sent.tasks.board.tasks = [{ id: 't1', title: 'Caméra', status: 'x', ref: null, url: null, role: 'owner', lastEdited: null, due: null }]
    await sent.days.send(DAY)
    expect(log.entries.map((e) => [e.day, e.taskId, e.label, e.share])).toEqual([
      [DAY, 't1', 'Développement', 0.6],
      [DAY, null, 'Réunion', 0.4],
    ])
    expect(await sent.store.drafts(DAY)).toHaveLength(0)
    expect(await sent.days.dayState(DAY)).toBe('recorded')
    expect(sent.changes()).toBeGreaterThan(0)
  })

  test('sending again rewrites the same entries and removes the lines taken out', async () => {
    const log = new FakeTimeLog()
    const { store, days } = setup({ now: NEXT_DAY, log })
    await store.draft(DAY, [
      { taskId: 't1', share: 10 },
      { taskId: 't2', share: 10 },
    ])
    await days.send(DAY)
    const [first] = log.entries
    await store.draft(DAY, [{ taskId: 't1', share: 20 }])
    await days.send(DAY)
    expect(log.entries.filter((e) => !e.archived).map((e) => [e.id, e.share])).toEqual([[first.id, 1]])
    expect((await store.logged([DAY])).map((r) => [r.taskId, r.share])).toEqual([['t1', 20]])
  })

  test('refuses a day that is not complete, or a branch left unresolved', async () => {
    const log = new FakeTimeLog()
    const { store, days } = setup({ now: NEXT_DAY, log })
    await store.draft(DAY, [{ taskId: 't1', share: 15 }])
    await expect(days.send(DAY)).rejects.toThrow(/valoir 1/)
    await store.draft(DAY, [
      { taskId: 't1', share: 15 },
      { taskId: null, repo: 'r', branch: 'fix', share: 5 },
    ])
    await expect(days.send(DAY)).rejects.toThrow(/branche sans tâche/)
    expect(log.calls).toHaveLength(0)
  })

  test('a Time Log that cannot write a whole day is said so, and nothing is sent', async () => {
    const { store, days } = setup({ now: NEXT_DAY, log: new PlainTimeLog() })
    await store.draft(DAY, [{ taskId: 't1', share: 20 }])
    await expect(days.send(DAY)).rejects.toThrow(/journée entière/)
    expect((await days.view(DAY)).logProblem).toMatch(/journée entière/)
    expect((await setup({ now: NEXT_DAY, log: null }).days.view(DAY)).logProblem).toMatch(/Aucun Time Log/)
  })

  test('a draft under 1 is saved, but not sent', async () => {
    const log = new FakeTimeLog()
    const { store, days } = setup({ now: NEXT_DAY, log })
    await days.replace(DAY, [{ taskId: 't1', label: 'Développement', share: 18 }])
    expect((await store.drafts(DAY)).map((l) => [l.taskId, l.share])).toEqual([['t1', 18]])
    await expect(days.send(DAY)).rejects.toThrow(/valoir 1/)
    expect(log.calls).toHaveLength(0)
  })

  test('« Absent » sends one line of a whole day without a task', async () => {
    const log = new FakeTimeLog()
    const { days } = setup({ now: NEXT_DAY, log })
    await days.absent(DAY)
    await days.send(DAY)
    expect(log.entries.map((e) => [e.taskId, e.label, e.share])).toEqual([[null, 'Absent', 1]])
    expect(await days.dayState(DAY)).toBe('absent')
  })

  test('the app shows what the Time Log has, after an edit made there', async () => {
    const log = new FakeTimeLog()
    const { store, days } = setup({ now: NEXT_DAY, log })
    await store.draft(DAY, [
      { taskId: 't1', share: 10 },
      { taskId: 't2', share: 10 },
    ])
    await days.send(DAY)
    // Changed directly in the Time Log: one entry gets the whole day, the other is removed.
    log.entries[0].share = 1
    log.entries[1].archived = true
    await days.readLog(DAY, DAY, true)
    expect((await store.logged([DAY])).map((r) => [r.taskId, r.share])).toEqual([['t1', 20]])
  })

  test('« Modifier » makes a recorded day a draft again, sent back over the same entries', async () => {
    const log = new FakeTimeLog()
    const { store, days } = setup({ now: NEXT_DAY, log })
    await store.draft(DAY, [{ taskId: 't1', share: 20 }])
    await days.send(DAY)
    await days.edit(DAY)
    expect(await days.dayState(DAY)).toBe('modified')
    const view = await days.view(DAY)
    expect(view.lines.map((l) => [l.source, l.taskId, l.share])).toEqual([['draft', 't1', 20]])
    await days.send(DAY)
    expect(log.entries.filter((e) => !e.archived)).toHaveLength(1)
    expect(await days.dayState(DAY)).toBe('recorded')
  })
})
