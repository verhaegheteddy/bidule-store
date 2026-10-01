import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import type { ForgeClient, ForgeIssue, ForgeJob, ForgePipeline, ForgeReview, GitBranch, GitSource, NewReview } from '@bidule/ext-git/contract'
import type { Board, TaskColumn, TaskPage, TaskSource } from '@bidule/sdk/tasks'
import type { Settings } from '../server/settings.ts'
import { SessionStore, type SessionRow } from '../server/store.ts'

// The module's settings, by default as a new install has them.
export function settingsWith(patch: Partial<Settings> = {}): Settings {
  return {
    enabled: true,
    root: '',
    settingSources: ['user', 'project', 'local'],
    defaultMode: 'default',
    defaultModel: '',
    defaultEffort: '',
    reviewTarget: '',
    branchNaming: 'issue',
    branchTemplate: '{ref}-{slug}',
    createIssue: false,
    integrationBranches: ['main', 'master', 'develop'],
    deploy: { stagingBranch: '', productionBranch: '', stagingJob: '', productionJob: '', stagingEnvs: [], stagingEnv: '', testStatus: '' },
    repos: {},
    ...patch,
  }
}

/**
 * The git role: the repos and branches given, the forge given for every repo. `run` is the command answer: by
 * default it records the commands, answers the refs listed and lets every other command succeed (see recording());
 * real() runs git for real.
 */
export class FakeGit implements GitSource {
  readonly commands: string[] = []
  readonly linked: string[] = []
  forge: ForgeClient | null = null
  repoList: { path: string; label: string }[] = []
  branchList: GitBranch[] = []

  constructor(public run: (folder: string, args: string[], timeout?: number) => Promise<string> = async () => '') {}

  async repos() {
    return this.repoList
  }
  async branches() {
    return this.branchList
  }
  async branchesOf(taskId: string) {
    return this.branchList.filter((b) => b.taskId === taskId)
  }
  async link(repo: string, name: string, taskId: string | null) {
    this.linked.push(`${repo} ${name} ${taskId}`)
    return true
  }
  async forgeOf() {
    return this.forge
  }
  async resolvePath(path: string) {
    return path === '~' ? homedir() : path
  }
  async sync() {}
  registerForge() {}
  events = unused
  status = unused
  createBranch = unused
  remoteBranches = unused
  switchBranch = unused
  defaultBranch = unused
  recordCheckout = unused
  worktrees = unused
  addWorktree = unused
  removeWorktree = unused
  remoteHosts = unused
  setReview = unused
  reviewsRead = unused
}

async function unused(): Promise<never> {
  throw new Error('not used by the module')
}

// Records `<folder> <args>`; the refs listed exist, `rev-parse` answers a sha (or the exclude file's path), every
// other command succeeds.
export function recording(git: FakeGit, refs: string[] = [], answers: { ahead?: string; list?: string; branch?: string } = {}) {
  return async (folder: string, args: string[]) => {
    git.commands.push(`${folder} ${args.join(' ')}`)
    const last = args.at(-1) ?? ''
    if (args[0] === 'show-ref' && !refs.includes(last)) throw new Error('no ref')
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return '.git/info/exclude\n'
    if (args[0] === 'rev-parse') return 'pushed1\n'
    if (args[0] === 'rev-list') return answers.ahead ?? '0\n'
    if (args[0] === 'worktree' && args[1] === 'list') return answers.list ?? ''
    if (args[0] === 'branch' && args[1] === '--show-current') return answers.branch ?? 'launchpad\n'
    return ''
  }
}

// git itself, in the folder given.
export function real(folder: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd: folder, timeout }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))
  )
}

// A forge answering from maps keyed by branch name and commit sha; a branch missing from the reviews fails like an
// unreachable project. Writes are recorded in `writes`, and a created review is returned by the next reads.
export class FakeForge implements ForgeClient {
  kind: 'gitlab' | 'github' = 'gitlab'
  readonly name = 'GitLab'
  readonly project = 'team/app'
  readonly writes: string[] = []
  issues: Record<number, ForgeIssue> = {}

  constructor(
    protected reviews: Record<string, ForgeReview | null> = {},
    protected pipelines: Record<string, ForgePipeline | null> = {},
    protected pipelineJobs: ForgeJob[] = []
  ) {}

  async review(branch: string) {
    if (!(branch in this.reviews)) throw new Error('404')
    return this.reviews[branch]
  }
  async pipeline(sha: string) {
    return this.pipelines[sha] ?? null
  }
  async jobs() {
    return this.pipelineJobs
  }
  async issue(n: number) {
    return this.issues[n] ?? null
  }
  async runPipeline(branch: string) {
    this.writes.push(`run ${this.project} ${branch}`)
  }
  async retryPipeline(id: number) {
    this.writes.push(`retry ${this.project} ${id}`)
  }
  async playJob(id: number) {
    this.writes.push(`play ${this.project} ${id}`)
  }
  async createReview(review: NewReview) {
    this.writes.push(`review ${this.project} ${review.source} → ${review.target} « ${review.title} »`)
    const created: ForgeReview = { number: 1, state: 'open', draft: review.draft, url: 'https://gl/mr/1', description: review.description }
    this.reviews[review.source] = created
    return created
  }
  async markReady(n: number) {
    this.writes.push(`ready ${this.project} ${n}`)
    for (const r of Object.values(this.reviews)) if (r?.number === n) r.draft = false
  }
  async mergeReview(n: number) {
    this.writes.push(`merge ${this.project} ${n}`)
    for (const r of Object.values(this.reviews)) if (r?.number === n) r.state = 'merged'
  }
  async createIssue(issue: { title: string; description: string }) {
    const n = 500 + this.writes.filter((w) => w.startsWith('issue')).length
    this.writes.push(`issue ${this.project} #${n} « ${issue.title} »`)
    const created: ForgeIssue = { number: n, state: 'open', url: `https://gl/issues/${n}`, description: issue.description }
    this.issues[n] = created
    return created
  }
  async createBranch(name: string, from: string) {
    this.writes.push(`branch ${this.project} ${name} from ${from}`)
  }
}

export const COLUMNS: TaskColumn[] = [
  { name: 'Pas commencé', group: 'todo', color: 'default' },
  { name: 'En cours', group: 'doing', color: 'blue' },
]

// The tasks role: one task to do, ID-7; moves and comments recorded.
export class FakeTasks implements TaskSource {
  readonly moved: string[] = []
  readonly comments: string[] = []
  page?: (id: string) => Promise<TaskPage> = async () => ({
    text: '# Contexte\n- ajouter le rôle',
    comments: [{ at: '2026-09-25T10:00:00Z', text: 'Vu avec le PO' }],
  })
  board_: Board = {
    source: 'Notion',
    configured: true,
    columns: COLUMNS,
    tasks: [{ id: 't1', title: 'Ajout rôle', status: 'Pas commencé', ref: 'ID-7', url: 'https://notion/t1', role: 'owner', lastEdited: null, due: null }],
  }

  async board() {
    return this.board_
  }
  async move(id: string, status: string) {
    this.moved.push(`${id} ${status}`)
    const task = this.board_.tasks.find((t) => t.id === id)
    if (task) task.status = status
  }
  async search() {
    return []
  }
  async join() {}
  async sync() {}
  async comment(id: string, text: string) {
    this.comments.push(`${id} ${text}`)
  }
}

// The sessions' rows, in memory.
export class MemoryStore extends SessionStore {
  rows = new Map<string, SessionRow>()
  archives = new Set<string>()

  constructor() {
    super(null as never)
  }
  override async find(id: string) {
    const row = this.rows.get(id)
    return row ? structuredClone(row) : null
  }
  override async all() {
    return [...this.rows.values()].map((r) => structuredClone(r))
  }
  override async save(row: SessionRow) {
    row.updatedAt = new Date().toISOString()
    this.rows.set(row.id, structuredClone(row))
  }
  override async recover() {
    for (const r of this.rows.values()) r.status = 'saved'
  }
  override async archived() {
    return new Set(this.archives)
  }
  override async archive(id: string, archived: boolean) {
    if (archived) this.archives.add(id)
    else this.archives.delete(id)
  }
}
