import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GitBranch } from '@bidule/ext-git/contract'
import { LOCKS_DIR } from '../server/slot_lock.ts'
import type { Settings } from '../server/settings.ts'
import { pipelineVerdict, workspaceServer, workspaceTools, type ToolContext } from '../server/tools.ts'
import { FakeForge, FakeGit, FakeTasks, MemoryStore, real, recording, settingsWith } from './fakes.ts'
import { IDENTITY, realRepo, sh } from './repos.ts'

// Taken from quack-board (tests/unit/claude_tools.spec.ts, Simon's). The tools reach the tasks, git and the forges
// through the roles: fakes of them here (the task cache and the board's announcement of Simon's app have no
// equivalent: the source of tasks is the role itself).

const branch = (repo: string, name: string, patch: Partial<GitBranch> = {}): GitBranch => ({
  repo,
  repoLabel: 'app',
  name,
  taskId: null,
  manual: false,
  isDefault: false,
  ahead: 0,
  behind: 0,
  pushed: true,
  lastCommitAt: null,
  headSha: null,
  base: null,
  remoteHost: 'gl.example',
  remotePath: 'team/app',
  remote: 'origin',
  reviewNumber: null,
  reviewRef: null,
  reviewState: null,
  ci: null,
  ...patch,
})

function setup(options: { git?: FakeGit; forge?: FakeForge; settings?: Partial<Settings>; repos?: { path: string; label: string }[] } = {}) {
  const git = options.git ?? new FakeGit()
  if (!options.git) git.run = recording(git)
  const forge = options.forge ?? new FakeForge()
  git.forge = forge
  git.repoList = options.repos ?? [{ path: '/r/app', label: 'app' }]
  const tasks = new FakeTasks()
  const store = new MemoryStore()
  const settings = settingsWith(options.settings)
  const tools = workspaceTools({ git: async () => git, tasks: async () => tasks, settings: async () => settings, store }, async () => {})
  const asked: string[] = []
  const ctx = (allow = true, extra: Partial<ToolContext> = {}): ToolContext => ({
    sessionId: 's1',
    root: tmpdir(),
    configDir: join(tmpdir(), 'no-claude-config'),
    confirm: async (tool, detail) => {
      asked.push(`${tool}: ${detail}`)
      return allow
    },
    ...extra,
  })
  const call = (name: string, args: Record<string, unknown>, context = ctx()) => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`no tool ${name}`)
    return tool.call(args, context)
  }
  return { git, forge, tasks, store, asked, ctx, call, tools }
}

describe('Claude tools', () => {
  it('a tool that writes asks first, and does nothing when refused', async () => {
    const { tasks, asked, ctx, call } = setup()
    const res = await call('set_task_status', { task: 'ID-7', status: 'En cours' }, ctx(false))
    expect(res).toEqual({ text: "Refusé par l'utilisateur", isError: true })
    expect(asked).toEqual(['mcp__workspace__set_task_status: Passer ID-7 au statut « En cours »'])
    expect(tasks.moved).toEqual([])
  })

  it('a tool that reads does not ask', async () => {
    const { asked, call } = setup()
    const res = await call('read_task', { task: 'id-7' })
    expect(res.isError).toBe(false)
    const task = JSON.parse(res.text)
    expect(task).toMatchObject({ id: 't1', ref: 'ID-7', title: 'Ajout rôle' })
    expect(task.content).toBe('# Contexte\n- ajouter le rôle')
    expect(task.comments).toEqual([{ at: '2026-09-25T10:00:00Z', text: 'Vu avec le PO' }])
    expect(asked).toEqual([])
  })

  it('changes a task’s status in the source of tasks', async () => {
    const { tasks, call } = setup()
    const res = await call('set_task_status', { task: 't1', status: 'En cours' })
    expect(res.isError).toBe(false)
    expect(tasks.moved).toEqual(['t1 En cours'])
  })

  it('refuses a status the source does not have, listing those it has', async () => {
    const { tasks, call } = setup()
    const res = await call('set_task_status', { task: 't1', status: 'Inventé' })
    expect(res).toEqual({ text: "« Inventé » n'est pas un statut de la source. Statuts : Pas commencé, En cours", isError: true })
    expect(tasks.moved).toEqual([])
  })

  it('comments a task', async () => {
    const { tasks, call } = setup()
    await call('comment_task', { task: 'ID-7', text: 'Déployé en staging' })
    expect(tasks.comments).toEqual(['t1 Déployé en staging'])
  })

  it('an unknown task is said', async () => {
    const { call } = setup()
    expect(await call('read_task', { task: 'ID-99' })).toEqual({ text: 'Tâche inconnue : ID-99', isError: true })
  })

  it('starts a task as « Démarrer… » does, from the repo’s review target', async () => {
    const { git, forge, tasks, call } = setup({ settings: { repos: { '/r/app': { reviewTarget: 'launchpad' } } } })
    const res = await call('start_task', { task: 'ID-7', repos: [{ repo: 'app' }] })
    expect(res.isError, res.text).toBe(false)
    expect(forge.writes).toEqual([
      'issue team/app #500 « Ajout rôle »',
      'branch team/app 500-ajout-role from launchpad',
      'review team/app 500-ajout-role → launchpad « Ajout rôle »',
    ])
    // The main checkout keeps its branch: the local branch is only created, then linked to the task.
    expect(git.commands).toContain('/r/app branch --track 500-ajout-role origin/500-ajout-role')
    expect(git.linked).toEqual(['/r/app 500-ajout-role t1'])
    expect(tasks.moved).toEqual(['t1 En cours'])
  })

  it('plays a manual job of a branch’s pipeline', async () => {
    const { forge, call } = setup()
    const res = await call('play_job', { repo: 'app', branch: '500-ajout', job: 42 })
    expect(res.isError, res.text).toBe(false)
    expect(forge.writes).toContain('play team/app 42')
  })

  it('a repo without a forge is said', async () => {
    const { git, call } = setup()
    git.forge = null
    const res = await call('play_job', { repo: 'app', branch: '500-ajout', job: 42 })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('pas de remote GitHub ou GitLab')
  })

  it('creates a worktree and keeps it on the session', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'tool-wt-'))
    const git = new FakeGit()
    git.run = recording(git, ['refs/remotes/origin/launchpad'])
    const { store, call } = setup({ git, repos: [{ path: repo, label: 'app' }], settings: { reviewTarget: 'launchpad' } })
    await store.save(store.fresh({ id: 's1', cwd: tmpdir(), taskId: null, repos: [repo], title: 'Ajout rôle', mode: 'default', status: 'running' }))
    const res = await call('worktree_add', { repo: 'app', branch: '500-ajout' })
    expect(res.isError, res.text).toBe(false)
    expect(git.commands).toContain(`${repo} worktree add -b 500-ajout .claude/worktrees/500-ajout origin/launchpad`)
    expect((await store.find('s1'))?.worktrees).toEqual([join(repo, '.claude', 'worktrees', '500-ajout')])
  })

  it('takes the executable slot for the session’s Claude Code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tool-slot-'))
    const config = await mkdtemp(join(tmpdir(), 'tool-config-'))
    await mkdir(join(config, 'sessions'))
    await writeFile(join(config, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's1' }))
    const { ctx, call } = setup({ repos: [{ path: '/w/insight', label: 'insight' }] })
    const res = await call('slot_acquire', { repos: ['insight'] }, ctx(true, { root, configDir: config }))
    expect(res.isError, res.text).toBe(false)
    expect(JSON.parse(res.text)).toEqual({ ok: true, repos: ['insight'] })
    const info = await readFile(join(root, LOCKS_DIR, 'insight.lock', 'info'), 'utf8')
    expect(info).toMatch(new RegExp(`^pid=${process.pid}\\n`))
  })

  it('a manual job is ready once the jobs before it have passed', () => {
    const job = (name: string, status: string, id = 1) => ({ id, name, status })
    const deploy = 'deploy:staging-02'
    expect(pipelineVerdict('pending', [job('build', 'running'), job(deploy, 'manual', 9)], deploy)).toEqual({ state: 'waiting' })
    expect(pipelineVerdict('pending', [job('build', 'success'), job(deploy, 'manual', 9)], deploy)).toEqual({
      state: 'ready',
      job: { id: 9, name: deploy },
    })
    expect(pipelineVerdict('fail', [job('lint', 'failed'), job(deploy, 'manual', 9)], deploy)).toEqual({ state: 'failed', jobs: ['lint'] })
    expect(pipelineVerdict('ok', [job(deploy, 'success', 9)], deploy)).toEqual({ state: 'done' })
    expect(pipelineVerdict('ok', [])).toEqual({ state: 'done' })
  })

  it('waits on the pipeline of the commit just pushed', async () => {
    const forge = new FakeForge({ factory: null }, { pushed1: { id: 77, status: 'pending', url: 'https://gl/p/77' } }, [
      { id: 1, name: 'build', stage: 'build', status: 'success', manual: false },
      { id: 9, name: 'deploy:staging-02', stage: 'deploy', status: 'manual', manual: true },
    ])
    const { call } = setup({ forge })
    const res = await call('wait_pipeline', { repo: 'app', branch: 'factory', job: 'deploy:staging-02' })
    expect(JSON.parse(res.text)).toMatchObject({
      state: 'ready',
      job: { id: 9, name: 'deploy:staging-02' },
      pipeline: 'https://gl/p/77',
      commit: 'pushed1',
    })
  })

  it('opens the draft MR of a branch pushed from a worktree, with its task’s title', async () => {
    const forge = new FakeForge({ '7-ajout-role': null })
    const { git, call } = setup({ forge, settings: { repos: { '/r/app': { reviewTarget: 'launchpad' } } } })
    git.branchList = [branch('/r/app', '7-ajout-role', { taskId: 't1' })]
    const res = await call('create_review', { repo: 'app', branch: '7-ajout-role' })
    expect(res.isError, res.text).toBe(false)
    expect(git.commands).toContain('/r/app fetch origin 7-ajout-role launchpad')
    expect(forge.writes).toEqual(['review team/app 7-ajout-role → launchpad « Ajout rôle »'])
    // It closes the branch's issue and links the task.
    expect(JSON.parse(res.text).review.description).toBe('Closes #7\n\nTâche : https://notion/t1')

    // Asked again, the MR already open is given back.
    const again = await call('create_review', { repo: 'app', branch: '7-ajout-role' })
    expect(JSON.parse(again.text).created).toBe(false)
    expect(forge.writes).toHaveLength(1)
  })

  it('on GitHub, refuses a PR whose branch has no commit of its own', async () => {
    const forge = new FakeForge({ '7-ajout-role': null })
    forge.kind = 'github'
    const git = new FakeGit()
    git.run = recording(git)
    const { call } = setup({ git, forge, settings: { reviewTarget: 'main' } })
    const refused = await call('create_review', { repo: 'app', branch: '7-ajout-role' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('GitHub refuse une PR sans commit')
    expect(forge.writes).toEqual([])

    git.run = recording(git, [], { ahead: '2\n' })
    const res = await call('create_review', { repo: 'app', branch: '7-ajout-role', draft: false })
    expect(res.isError, res.text).toBe(false)
    expect(git.commands).toContain('/r/app rev-list --count origin/main..origin/7-ajout-role')
    expect(forge.writes).toEqual(['review team/app 7-ajout-role → main « 7-ajout-role »'])
  })

  it('accepts an MR, once out of draft when asked', async () => {
    const forge = new FakeForge({ '7-ajout': { number: 3, state: 'open', draft: true, url: 'https://gl/mr/3', description: '' } })
    const { call } = setup({ forge })
    const draft = await call('merge_review', { repo: 'app', branch: '7-ajout' })
    expect(draft.isError).toBe(true)
    expect(draft.text).toContain('brouillon')
    const res = await call('merge_review', { repo: 'app', branch: '7-ajout', ready: true })
    expect(res.isError, res.text).toBe(false)
    expect(forge.writes).toEqual(['ready team/app 3', 'merge team/app 3'])
  })

  it('an MCP client sees the tools and calls them as Claude would', async () => {
    const { tools, tasks, ctx } = setup()
    const server = workspaceServer(tools, ctx())
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)

    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort())
    const repos = await client.callTool({ name: 'list_repos', arguments: {} })
    expect(JSON.parse((repos.content as { text: string }[])[0].text)).toEqual([{ label: 'app', path: '/r/app', reviewTarget: null }])
    const changed = await client.callTool({ name: 'set_task_status', arguments: { task: 'ID-7', status: 'En cours' } })
    expect(Boolean(changed.isError)).toBe(false)
    expect(tasks.moved).toEqual(['t1 En cours'])
    await client.close()
  })
})

describe('Claude tools · git and forge', () => {
  const before = { ...process.env }
  beforeAll(() => void Object.assign(process.env, IDENTITY))
  afterAll(() => {
    for (const key of Object.keys(IDENTITY)) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  })

  const withRepo = (repo: string) =>
    setup({ git: new FakeGit(real), repos: [{ path: repo, label: 'app' }], settings: { repos: { [repo]: { reviewTarget: 'launchpad' } } } })

  it('merges a branch into staging in its worktree, then commits the merge and pushes it', async () => {
    const { repo, origin } = await realRepo()
    const { call } = withRepo(repo)
    const merged = await call('merge_branch', { repo: 'app', source: '7-ajout', target: 'staging' })
    expect(merged.isError, merged.text).toBe(false)
    expect(JSON.parse(merged.text)).toMatchObject({ merged: true, from: '7-ajout', conflicts: [] })
    // Not committed yet: the checks run first.
    expect(sh(origin, 'log', '-1', '--format=%s', 'staging')).toBe('init')

    const pushed = await call('push_branch', { repo: 'app', branch: 'staging' })
    expect(pushed.isError, pushed.text).toBe(false)
    expect(JSON.parse(pushed.text).committedMerge).toBe(true)
    expect(sh(origin, 'log', '-1', '--format=%s', 'staging')).toBe("Merge branch '7-ajout' into staging")
    // The main checkout kept its branch.
    expect(sh(repo, 'branch', '--show-current')).toBe('launchpad')
  })

  it('stops on a conflict, and pushes nothing while it remains', async () => {
    const { repo, origin } = await realRepo(true)
    const { call } = withRepo(repo)
    const merged = await call('merge_branch', { repo: 'app', source: '7-ajout', target: 'staging' })
    expect(JSON.parse(merged.text)).toMatchObject({ merged: true, conflicts: ['README.md'] })
    const pushed = await call('push_branch', { repo: 'app', branch: 'staging' })
    expect(pushed).toEqual({ text: 'Conflits à résoudre d’abord : README.md', isError: true })
    expect(sh(origin, 'log', '-1', '--format=%s', 'staging')).toBe('staging fix')
  })

  it('leaves the main checkout alone without the executable slot', async () => {
    const { repo } = await realRepo()
    const { call } = withRepo(repo)
    const res = await call('slot_checkout', { repo: 'app', branch: '7-ajout' })
    expect(res).toEqual({ text: 'La session ne tient pas le créneau de app : slot_acquire', isError: true })
    expect(sh(repo, 'branch', '--show-current')).toBe('launchpad')
  })
})
