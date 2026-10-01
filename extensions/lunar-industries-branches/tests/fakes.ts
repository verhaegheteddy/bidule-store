import type { ForgeClient, ForgeJob, GitBranch, GitSource, NewReview } from '@bidule/ext-git/contract'
import type { Task, TaskSource } from '@bidule/sdk/tasks'
import type { ListedBranch } from '../contract.ts'
import { BranchesService } from '../server/service.ts'

export function branch(fields: Partial<GitBranch> & { name: string }): GitBranch {
  return {
    repo: '/r/app',
    repoLabel: 'app',
    taskId: null,
    manual: false,
    isDefault: false,
    ahead: 0,
    behind: 0,
    pushed: true,
    lastCommitAt: new Date().toISOString(),
    headSha: 'abc',
    base: null,
    remoteHost: 'gitlab.com',
    remotePath: 'team/app',
    remote: 'origin',
    reviewNumber: null,
    reviewRef: null,
    reviewState: null,
    ci: null,
    ...fields,
  }
}

export const listed = (fields: Partial<ListedBranch> & { name: string }): ListedBranch => ({
  forge: 'gitlab',
  issueNumber: null,
  ...branch(fields),
  ...fields,
})

export function task(id: string, title: string, fields: Partial<Task> = {}): Task {
  return { id, title, status: 'En cours', ref: null, url: `https://notion.so/${id}`, role: 'owner', lastEdited: null, due: null, ...fields }
}

// A forge that records what it is asked to do.
export function fakeForge(fields: Partial<ForgeClient> = {}) {
  const calls: string[] = []
  const reviews: NewReview[] = []
  const jobs: ForgeJob[] = [
    { id: 7, name: 'deploy', stage: 'deploy', status: 'manual', manual: true },
    { id: 8, name: 'test', stage: 'test', status: 'success', manual: false },
  ]
  const client: ForgeClient = {
    kind: 'gitlab',
    name: 'GitLab',
    project: 'team/app',
    review: async () => ({ number: 12, state: 'open', draft: true, url: 'https://gitlab.com/team/app/-/merge_requests/12', description: '' }),
    pipeline: async (sha) => (sha ? { id: 99, status: 'fail', url: 'https://gitlab.com/team/app/-/pipelines/99' } : null),
    jobs: async (id) => (calls.push(`jobs ${id}`), jobs),
    issue: async (n) => ({ number: n, state: 'open', url: `https://gitlab.com/team/app/-/issues/${n}`, description: '' }),
    runPipeline: async (b) => void calls.push(`run ${b}`),
    retryPipeline: async (id) => void calls.push(`retry ${id}`),
    playJob: async (id) => void calls.push(`play ${id}`),
    createReview: async (r) => {
      reviews.push(r)
      return { number: 13, state: 'open', draft: true, url: 'u', description: r.description }
    },
    markReady: async () => undefined,
    mergeReview: async () => undefined,
    createIssue: async () => ({ number: 1, state: 'open', url: 'u', description: '' }),
    createBranch: async () => undefined,
    ...fields,
  }
  return { client, calls, reviews }
}

export function fakeGit(branches: GitBranch[], forge: ForgeClient | null) {
  const links: string[] = []
  let syncs = 0
  const git = {
    repos: async () => [...new Set(branches.map((b) => b.repo))].map((path) => ({ path, label: branches.find((b) => b.repo === path)!.repoLabel })),
    branches: async () => branches,
    forgeOf: async () => forge,
    link: async (repo: string, name: string, taskId: string | null) => (links.push(`${repo} ${name} ${taskId}`), true),
    sync: async () => void syncs++,
  } as unknown as GitSource
  return { git, links, syncs: () => syncs }
}

export function service(
  git: GitSource,
  { tasks = [], settings = {} }: { tasks?: Task[]; settings?: Record<string, string> } = {},
) {
  const saved: Record<string, string> = { ...settings }
  let changed = 0
  const source = { board: async () => ({ source: 'Notion', configured: true, columns: [], tasks }) } as unknown as TaskSource
  const s = new BranchesService({
    git: async () => git,
    tasks: async () => source,
    setting: async (key) => saved[key],
    save: async (key, value) => void (saved[key] = value),
    changed: () => void changed++,
  })
  return { s, saved, changed: () => changed }
}
