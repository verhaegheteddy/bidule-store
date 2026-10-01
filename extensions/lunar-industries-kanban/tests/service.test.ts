import type { ForgeClient, GitBranch, GitSource } from '@bidule/ext-git/contract'
import { describe, expect, test } from 'vitest'
import { KanbanService } from '../server/service.ts'

const branch = (name: string, patch: Partial<GitBranch> = {}): GitBranch =>
  ({
    repo: '/r/app',
    repoLabel: 'app',
    name,
    taskId: null,
    manual: false,
    isDefault: false,
    lastCommitAt: null,
    headSha: `sha-${name}`,
    reviewNumber: null,
    reviewRef: null,
    reviewState: null,
    ci: null,
    ...patch,
  }) as GitBranch

// The git role: its branches, links written on them, a forge for every repo.
function fakeGit(list: GitBranch[], forge: Partial<ForgeClient> | null = null) {
  const links: string[] = []
  const git = {
    branches: async () => list,
    link: async (repo: string, name: string, taskId: string | null) => {
      links.push(`${name}→${taskId}`)
      const b = list.find((x) => x.repo === repo && x.name === name)
      if (b) b.taskId = taskId
      return true
    },
    forgeOf: async () => forge as ForgeClient | null,
  } as unknown as GitSource
  return { git, links }
}

describe('the cards’ branches', () => {
  test('without the git role, no branch and no error', async () => {
    const service = new KanbanService(async () => null)
    expect(await service.branches()).toEqual({ available: false, branches: [] })
    await expect(service.setBranches('t', [])).rejects.toThrow(/rôle git/)
  })

  test('the repos’ default branches are left out', async () => {
    const { git } = fakeGit([branch('main', { isDefault: true }), branch('feat/a')])
    const { branches } = await new KanbanService(async () => git).branches()
    expect(branches.map((b) => b.name)).toEqual(['feat/a'])
  })

  test('a task’s branches are exactly those given: others unlinked, new ones linked, kept ones untouched', async () => {
    const { git, links } = fakeGit([branch('kept', { taskId: 't' }), branch('dropped', { taskId: 't' }), branch('new', { taskId: 'x' })])
    const after = await new KanbanService(async () => git).setBranches('t', [
      { repo: '/r/app', name: 'kept' },
      { repo: '/r/app', name: 'new' },
    ])
    expect(links).toEqual(['dropped→null', 'new→t'])
    expect(after.branches.filter((b) => b.taskId === 't').map((b) => b.name)).toEqual(['kept', 'new'])
  })

  test('an unknown branch changes nothing', async () => {
    const { git, links } = fakeGit([branch('dropped', { taskId: 't' })])
    await expect(new KanbanService(async () => git).setBranches('t', [{ repo: '/r/app', name: 'nope' }])).rejects.toThrow(/inconnue/)
    expect(links).toEqual([])
  })

  test('a mark leads to the review, else to the pipeline of the branch’s last commit, else nowhere', async () => {
    const ref = { repo: '/r/app', name: 'feat/a' }
    const withReview = fakeGit([branch('feat/a')], { review: async () => ({ number: 1, state: 'open', draft: false, url: 'https://r/1', description: '' }) })
    expect(await new KanbanService(async () => withReview.git).reviewUrl(ref)).toBe('https://r/1')
    const pipelines: string[] = []
    const withPipeline = fakeGit([branch('feat/a')], {
      review: async () => null,
      pipeline: async (sha: string) => {
        pipelines.push(sha)
        return { id: 3, status: 'ok', url: 'https://p/3' }
      },
    })
    expect(await new KanbanService(async () => withPipeline.git).reviewUrl(ref)).toBe('https://p/3')
    expect(pipelines).toEqual(['sha-feat/a'])
    const noForge = fakeGit([branch('feat/a')])
    expect(await new KanbanService(async () => noForge.git).reviewUrl(ref)).toBeNull()
  })
})
