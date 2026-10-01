// Taken from quack-board (tests/unit/engine.spec.ts, Simon's « Time engine » and « Shares »), on the git role's
// events instead of the app's tables.
import { describe, expect, test } from 'vitest'
import {
  dayStart,
  integrationOf,
  MAIN_KEY,
  placeKey,
  proposeShares,
  reconstruct,
  type BranchInfo,
  type DayInput,
  type WorkEvent,
} from '../server/engine.ts'

const DAY = '2026-09-21'
const NEXT_DAY = new Date(2026, 8, 22)
const at = (h: number, m: number) => {
  const d = dayStart(DAY)
  d.setMinutes(h * 60 + m)
  return d.toISOString()
}

function input(branches: [string, string, BranchInfo][], events: WorkEvent[]): DayInput {
  return {
    events,
    branches: new Map(branches.map(([repo, name, info]) => [placeKey(repo, name), info])),
    repoLabel: (repo) => repo,
    integration: integrationOf(['main', 'master', 'develop', 'launchpad', 'factory', 'orbit'], ['launchpad', 'orbit']),
  }
}
const git = (time: string, kind: WorkEvent['kind'], repo: string, branch: string, detail = ''): WorkEvent => ({
  at: time,
  kind,
  repo,
  branch,
  detail,
  taskId: null,
})

describe('Time engine', () => {
  test('a task worked on in several moments makes one line, weighed by its spread', () => {
    const day = input(
      [
        ['cam', 'tsk-42-ipu-bridge', { taskId: 't42', isDefault: false }],
        ['board', 'tsk-57-notion-sync', { taskId: 't57', isDefault: false }],
        ['cam', 'fix-selinux', { taskId: null, isDefault: false }],
        ['cam', 'main', { taskId: null, isDefault: true }],
      ],
      [
        git(at(9, 2), 'checkout', 'cam', 'tsk-42-ipu-bridge'),
        git(at(9, 48), 'commit', 'cam', 'tsk-42-ipu-bridge', 'a'),
        git(at(10, 12), 'commit', 'cam', 'tsk-42-ipu-bridge', 'b'),
        git(at(10, 28), 'checkout', 'board', 'tsk-57-notion-sync'),
        git(at(11, 52), 'commit', 'board', 'tsk-57-notion-sync', 'c'),
        git(at(12, 5), 'commit', 'cam', 'fix-selinux', 'd'),
        git(at(13, 28), 'checkout', 'cam', 'main'),
        { at: at(13, 30), kind: 'task', repo: null, branch: null, detail: 'edit', taskId: 't57' },
      ]
    )
    const lines = reconstruct(DAY, day, NEXT_DAY)
    expect(lines.map((l) => [l.taskId ?? l.branch, l.weight])).toEqual([
      ['t42', 86], // 9:02, stretched to the next checkout at 10:28
      ['t57', 97 + 15], // 10:28 to the orphan commit at 12:05, then the task's edit at 13:30
      ['fix-selinux', 15], // an 85 min gap follows (lunch): only the tail is kept
    ])
    // Weights only compare the lines: the day splits into 8, 11 and 1 twentieths.
    expect(proposeShares(lines.map((l) => l.weight))).toEqual([8, 11, 1])
  })

  test('a task moved to in progress opens its activity until its next commit', () => {
    const day = input(
      [['r', 'id-1-a', { taskId: 't1', isDefault: false }]],
      [
        { at: at(9, 0), kind: 'status', repo: null, branch: null, detail: 'Backlog → En cours', taskId: 't1', toGroup: 'doing' },
        git(at(11, 0), 'commit', 'r', 'id-1-a', 'c'),
      ]
    )
    const [line] = reconstruct(DAY, day, NEXT_DAY)
    // 9:00 to 11:00 in one piece despite the silence, plus the commit's tail.
    expect(line.weight).toBe(120 + 15)
  })

  test('commits alone, the status forgotten, still make a proposal', () => {
    const day = input(
      [['r', 'id-1-a', { taskId: 't1', isDefault: false }]],
      [git(at(9, 0), 'commit', 'r', 'id-1-a', 'a'), git(at(11, 0), 'commit', 'r', 'id-1-a', 'b')]
    )
    expect(reconstruct(DAY, day, NEXT_DAY).map((l) => [l.taskId, l.weight])).toEqual([['t1', 30]])
    expect(proposeShares([30])).toEqual([20])
  })

  test('a commit git reached only through a tag or the stash belongs to no branch', () => {
    const day = input(
      [],
      [git(at(10, 0), 'commit', 'app', 'refs/tags/v0.1.3', 'a'), git(at(10, 20), 'commit', 'app', 'refs/stash', 'b')]
    )
    expect(reconstruct(DAY, day, NEXT_DAY)).toEqual([])
  })

  test('commits on main hopping between repos make one line', () => {
    const commits: [number, number, string][] = [
      [16, 21, 'deploy'],
      [16, 22, 'iam'],
      [16, 23, 'deploy'],
      [18, 1, 'deploy'],
      [18, 2, 'platform'],
      [19, 17, 'platform'],
      [19, 27, 'deploy'],
    ]
    const day = input(
      ['deploy', 'iam', 'platform'].map((repo) => [repo, 'main', { taskId: null, isDefault: true }]),
      commits.map(([h, m, repo], i) => git(at(h, m), 'commit', repo, 'main', `c${i}`))
    )
    const lines = reconstruct(DAY, day, NEXT_DAY)
    // Two sessions across three repos, 16:21–16:38 and 18:01–19:42, with a break between.
    expect(lines.map((l) => [l.key, l.taskId, l.weight])).toEqual([[MAIN_KEY, null, 17 + 101]])
    expect(lines[0].reason).toMatch(/deploy, iam/)
  })

  test('a deleted branch keeps the task its events carried', () => {
    const day = input([], [{ ...git(at(9, 0), 'commit', 'r', 'id-9-gone', 'a'), taskId: 't9' }])
    expect(reconstruct(DAY, day, NEXT_DAY).map((l) => l.taskId)).toEqual(['t9'])
  })
})

describe('Shares', () => {
  test('the day always adds up to 20 twentieths', () => {
    for (const weights of [[1], [3, 1], [5, 5, 5], [97, 13, 2, 1], [1, 1, 1, 1, 1, 1, 1]]) {
      expect(proposeShares(weights).reduce((a, n) => a + n, 0)).toBe(20)
    }
  })

  test('three equal tasks share 7, 7 and 6', () => {
    expect(proposeShares([60, 60, 60])).toEqual([7, 7, 6])
  })

  test('a very small task falls to 0', () => {
    expect(proposeShares([400, 5])).toEqual([20, 0])
  })

  test('one task takes the whole day, and nothing to weigh gives nothing', () => {
    expect(proposeShares([42])).toEqual([20])
    expect(proposeShares([0, 0])).toEqual([0, 0])
  })
})
