import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { GitSource } from '@bidule/ext-git/contract'
import type { TaskSource } from '@bidule/sdk/tasks'
import {
  PERMISSION_MODES,
  type Ask,
  type Attachments,
  type Decision,
  type NoticeKind,
  type Question,
  type SessionEffort,
  type SessionEvent,
  type SessionEvents,
  type SessionMessage,
  type SessionMode,
  type SessionModel,
  type SessionStatus,
  type SessionSummary,
  type Template,
  type ToolChange,
} from '../contract.ts'
import { pathInWsl, placeOf, sessionEnv } from './runner.ts'
import { sdk } from './sdk.ts'
import type { Settings } from './settings.ts'
import type { ModelUsage, SessionRow, SessionStore, UsageByModel } from './store.ts'
import { localConfigDir, SERVER, TOOLS_PROMPT, workspaceServer, type ToolContext, type WorkspaceTool } from './tools.ts'
import { workspaceRoot } from './worktrees.ts'

/**
 * Taken from quack-board (services/claude_session_service.ts, Simon's): Claude Code sessions run by the Agent SDK with
 * the machine's own Claude login. Their conversation is in Claude Code's history; the module's table keeps the rest
 * (task, repos, state, decisions). A session's process ends with the API: its row is then `saved`, and it can be
 * taken up again. What happens goes out as the module's events (`lunar-industries-claude.sessions`, `.session`).
 */

// How long the text being written is gathered before it is sent: one message per word would be too many.
const PARTIAL_MS = 50
// How often the transcript of a watched session is looked at. Only while the interface shows it.
const WATCH_MS = 2_000
// A watch the interface stopped renewing (a page closed without saying so) ends by itself.
export const WATCH_TTL_MS = 30_000

// A session of the terminal being watched: what its transcript looked like last time, and how many of its lines
// were sent.
interface Watched {
  timer: NodeJS.Timeout | null
  // When the watch ends unless the interface renews it.
  until: number
  // The transcript's date and size when it was last read; null before the first look.
  mark: string | null
  sent: number
  reading: boolean
  // Lines were appearing at the last round: the interface has been told the session is at work.
  live: boolean
}

type NewEvent = SessionEvent extends infer E ? (E extends SessionEvent ? Omit<E, 'seq'> : never) : never

// A line given its number in the conversation.
const numbered = (event: NewEvent, seq: number): SessionEvent => ({ ...event, seq }) as SessionEvent

// The SDK's messages that tell nothing the conversation shows: progress, hooks, counters, state already told another
// way. `type`, or `type:subtype` for the system ones.
const QUIET = new Set([
  'stream_event',
  'tool_progress',
  'tool_use_summary',
  'rate_limit_event',
  'prompt_suggestion',
  'auth_status',
  'system:status',
  'system:hook_started',
  'system:hook_progress',
  'system:hook_response',
  'system:thinking_tokens',
  'system:session_state_changed',
  'system:commands_changed',
  'system:task_progress',
  'system:background_tasks_changed',
  'system:files_persisted',
  'system:control_request_progress',
  'system:plugin_install',
  'system:memory_recall',
  'system:worker_shutting_down',
])

interface Live {
  id: string
  cwd: string
  mode: SessionMode
  // null: Claude Code's default (the user's settings).
  model: string | null
  effort: SessionEffort | null
  status: SessionStatus
  events: SessionEvent[]
  // Null only while start() builds the session, which the query's callbacks need.
  query: Query | null
  // Messages typed on the page, handed to the SDK one at a time.
  inbox: SDKUserMessage[]
  wake: (() => void) | null
  closed: boolean
  pending: Map<string, Pending>
  // The row's writes, one after the other.
  saving: Promise<unknown>
  // Text being written, not sent yet (see PARTIAL_MS).
  partial: string
  partialTimer: NodeJS.Timeout | null
  // Resolves once Claude Code has ended and the row's last writes are done.
  done: Promise<void>
  // Where the credentials used come from, as Claude Code says when it starts ('none': the login).
  apiKeySource: string | null
  // What the notifications name the session by.
  title: string
}

// A decision card waiting for the user.
interface Pending {
  tool: string
  detail: string
  input: Record<string, unknown>
  // The rules Claude Code proposes so as not to ask again (« Toujours pour cette commande »).
  suggestions: PermissionUpdate[]
  resolve: (r: PermissionResult) => void
}

export interface StartInput {
  // The repos the session works on.
  repos: string[]
  prompt: string
  mode: SessionMode
  // Left out: the session's own when it is taken up again, else Claude Code's default; null: the default.
  model?: string | null
  effort?: SessionEffort | null
  // A saved session to take up again, whose conversation goes on with `prompt`.
  resume?: string
  taskId?: string | null
  // The folder to run in, when it is not the workspace's root (a terminal session taken up again).
  cwd?: string
  // The worktrees to create before Claude's first message: the task's branches in the repos chosen.
  worktrees?: { repo: string; branch: string }[]
  // The images and files the first message carries.
  attached?: Attachments
}

export interface SessionDeps {
  store: SessionStore
  settings: () => Promise<Settings>
  git: () => Promise<GitSource>
  // null without a source of tasks.
  tasks: () => Promise<TaskSource | null>
  // What the module tells (its events).
  tell: {
    sessions(id: string, status: SessionStatus): void
    session(id: string, message: SessionMessage): void
  }
  // The workspace's tools given to each session (see tools.ts).
  tools?: WorkspaceTool[]
  // Creates (or finds) a branch's worktree in a repo, with the repo's settings.
  worktree?: (repo: string, branch: string) => Promise<{ path: string }>
  // The folders of the plugins every session loads (the module's skills, claude/plugin).
  plugins?: string[]
  // Another Claude Code than the one found for the folder (a fake one, in the tests).
  executable?: string
}

const clip = (s: string, max = 2000) => (s.length > max ? `${s.slice(0, max)}…` : s)

// The most telling field of a tool's input: the command, the file, the pattern.
function detailOf(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key]
    if (typeof value === 'string') return clip(value, 500)
  }
  return clip(JSON.stringify(input), 500)
}

// A tool's input as Claude wrote it: an object of named arguments.
const inputSchema = z.record(z.string(), z.unknown())
const inputOf = (value: unknown): Record<string, unknown> => {
  const read = inputSchema.safeParse(value)
  return read.success ? read.data : {}
}

const editsSchema = z.array(z.object({ old_string: z.string().optional(), new_string: z.string().optional() }))

// A tool call that changes a file, for its diff: an edit's text replaced and its replacement, a new file's content.
export function changeOf(name: string, input: Record<string, unknown>): ToolChange | null {
  const file = typeof input['file_path'] === 'string' ? input['file_path'] : null
  if (!file) return null
  const text = (v: unknown) => clip(typeof v === 'string' ? v : '', 4000)
  if (name === 'Edit') return { file, before: text(input['old_string']), after: text(input['new_string']) }
  if (name === 'Write') return { file, before: '', after: text(input['content']) }
  const multi = name === 'MultiEdit' ? editsSchema.safeParse(input['edits']) : null
  if (multi?.success) {
    const edits = multi.data
    return {
      file,
      before: text(edits.map((e) => e.old_string ?? '').join('\n…\n')),
      after: text(edits.map((e) => e.new_string ?? '').join('\n…\n')),
    }
  }
  return null
}

function userMessage(text: string, attached: Attachments = {}): SDKUserMessage {
  const { images = [], files = [] } = attached
  if (!images.length && !files.length) {
    return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
  }
  const content = [
    ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
    ...files.map((f) => ({ type: 'text' as const, text: `Fichier « ${f.name} » :\n\n${f.text}` })),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ]
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
}

// How the conversation shows a message: its text, then the names of what it carries.
function shownText(text: string, attached: Attachments): string {
  const names = [...(attached.images ?? []), ...(attached.files ?? [])].map((a) => a.name)
  return [text, names.length ? `Pièces jointes : ${names.join(', ')}` : ''].filter(Boolean).join('\n\n')
}

// A message the app does not show as such: its first line of text, else its fields.
function summaryOf(m: object): string {
  for (const key of ['text', 'message', 'content', 'summary', 'status']) {
    const value: unknown = Reflect.get(m, key)
    if (typeof value === 'string' && value) return clip(value, 300)
  }
  const skipped = new Set(['type', 'subtype', 'uuid', 'session_id'])
  const rest = Object.fromEntries(Object.entries(m).filter(([key]) => !skipped.has(key)))
  return clip(JSON.stringify(rest), 300)
}

type History = Pick<ReturnType<typeof sdk>, 'listSessions' | 'getSessionMessages' | 'getSessionInfo'>

// The history functions read CLAUDE_CONFIG_DIR at each call: one read at a time, each with its folder.
let reading: Promise<unknown> = Promise.resolve()
function readHistory<T>(configDir: string | undefined, read: (h: History) => Promise<T>): Promise<T> {
  const run = reading.then(async () => {
    const h = sdk()
    const before = process.env['CLAUDE_CONFIG_DIR']
    if (configDir) process.env['CLAUDE_CONFIG_DIR'] = configDir
    try {
      return await read(h)
    } finally {
      if (configDir && before === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else if (configDir) process.env['CLAUDE_CONFIG_DIR'] = before
    }
  })
  reading = run.catch(() => {})
  return run
}

// A block of a saved message's content, as Claude Code writes it in its transcript.
const blocksSchema = z.array(
  z.object({
    type: z.string(),
    id: z.string().optional(),
    tool_use_id: z.string().optional(),
    text: z.string().optional(),
    name: z.string().optional(),
    // Optional: in zod, an unknown field is still a required key, and a text block has neither.
    input: z.unknown().optional(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  })
)
const blocksOf = (content: unknown) => {
  const read = blocksSchema.safeParse(content)
  return read.success ? read.data : []
}

const savedMessageSchema = z.object({ content: z.unknown().optional() })

// An assistant message as Claude Code writes it in its transcript: what it cost in tokens, and on which model. No
// dollars there — only the live result message has them.
const pricedMessageSchema = z.object({
  model: z.string(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    output_tokens_details: z.object({ thinking_tokens: z.number().optional() }).optional(),
  }),
})

// What a turn's result says one model cost.
const modelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  thinkingTokens: z.number().optional(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  webSearchRequests: z.number(),
  costUSD: z.number(),
  costBasis: z.enum(['list', 'managed', 'unknown']).optional(),
}) satisfies z.ZodType<ModelUsage>
const usageByModel = z.record(z.string(), modelUsageSchema)

// A plugin's manifest: only its name, which prefixes its skills.
const manifestSchema = z.object({ name: z.string().optional() })

// Claude's questions (AskUserQuestion), as the page shows them.
const questionsSchema = z.array(
  z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiSelect: z.boolean(),
  })
) satisfies z.ZodType<Question[]>
const questionsOf = (value: unknown): Question[] => {
  const read = questionsSchema.safeParse(value)
  return read.success ? read.data : []
}

const isSessionMode = (mode: string): mode is SessionMode => PERMISSION_MODES.some((m) => m === mode)

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return blocksOf(content)
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
    .join('\n')
}

// The escape sequences that colour a terminal's text (ESC [ … m).
const TERMINAL_COLOURS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const tagOf = (name: string, text: string): string | null => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1] ?? null

/**
 * What a user message of a transcript says. Claude Code writes a slash command it ran itself (/plugin,
 * /reload-plugins…) as tagged text, not as what the user typed: the command is shown as typed, its output as a note,
 * and the caveat it adds for Claude (and an output with nothing in it) is left out.
 */
function userLines(text: string): NewEvent[] {
  if (text.includes('<local-command-caveat>')) return []
  // A task that ran in the background ended: its summary, not the ids and file names around it.
  if (text.trimStart().startsWith('<task-notification>')) {
    const summary = tagOf('summary', text)?.trim()
    return summary ? [{ kind: 'info', text: summary }] : []
  }
  const command = tagOf('command-name', text)
  if (command !== null) {
    const args = tagOf('command-args', text)?.trim()
    return [{ kind: 'user', text: args ? `${command.trim()} ${args}` : command.trim() }]
  }
  const output = tagOf('local-command-stdout', text) ?? tagOf('local-command-stderr', text)
  if (output !== null) return noteOf(output)
  return [{ kind: 'user', text }]
}

// What a command printed, as a note: without the terminal's colours, which mean nothing here, and not at all when
// there is nothing to say.
function noteOf(output: string): NewEvent[] {
  const clean = output.replace(TERMINAL_COLOURS, '').trim()
  return !clean || clean === '(no content)' ? [] : [{ kind: 'info', text: clean }]
}

// The model a /model command switched to, as Claude Code names it in its answer: an id (« Set model to
// `claude-opus-5-5` ») or, in newer versions, the name shown (« Set model to `Opus 5.5` for this session only »).
export function modelOfOutput(output: string): string | null {
  const found = /Set model to (?:`([^`]+)`|(.+?))(?: for this session only)?\s*$/m.exec(output)
  return found ? (found[1] ?? found[2]?.trim() ?? null) : null
}

// The value of the model field a name or an id stands for; null for one the session does not list (an id Claude Code
// names is taken as it is).
export function modelValueOf(models: SessionModel[], name: string): string | null {
  const wanted = name.trim().toLowerCase()
  const known = models.find((m) => m.value.toLowerCase() === wanted || m.label.toLowerCase() === wanted)
  return known?.value ?? (wanted.startsWith('claude-') ? name.trim() : null)
}

// A saved message as the lines of the page (the same as a live session shows).
export function eventsOfMessage(m: { type: string; message: unknown }): NewEvent[] {
  const message = savedMessageSchema.safeParse(m.message)
  const content = message.success ? message.data.content : undefined
  if (m.type === 'user' && typeof content === 'string') return userLines(content)
  return blocksOf(content).flatMap((b): NewEvent[] => {
    if (b.type === 'text' && b.text?.trim()) {
      return m.type === 'user' ? userLines(b.text) : [{ kind: 'text', text: b.text }]
    }
    if (b.type === 'tool_use') {
      const input = inputOf(b.input)
      return [{ kind: 'tool', id: b.id ?? '', name: b.name ?? '', detail: detailOf(input), change: changeOf(b.name ?? '', input) }]
    }
    if (b.type === 'tool_result') {
      return [{ kind: 'tool_result', id: b.tool_use_id ?? '', ok: !b.is_error, text: clip(resultText(b.content)) }]
    }
    return []
  })
}

export class SessionService {
  #sessions = new Map<string, Live>()
  // The sessions of the terminal the interface is looking at (see watch()).
  #watched = new Map<string, Watched>()
  // The folder a session's transcript was last read from, by session.
  #folders = new Map<string, string>()
  // The skills the last session started announced (the user's, the repo's, the module's): the new session window
  // offers them as first messages.
  #skills: string[] = []
  // The models the last session read (see models()).
  #models: SessionModel[] = []
  #probing: Promise<SessionModel[]> | null = null

  constructor(protected deps: SessionDeps) {}

  get skills(): string[] {
    return this.#skills
  }

  #publish(id: string, message: SessionMessage) {
    this.deps.tell.session(id, message)
  }

  // At the module's start: no process survived the previous API, the sessions it ran are saved.
  recover(): Promise<void> {
    return this.deps.store.recover()
  }

  async #root(repos: string[]): Promise<string> {
    const settings = await this.deps.settings()
    return workspaceRoot(settings.root, repos, await this.deps.git())
  }

  // A new session, or a saved one taken up again (`resume`: its id) with its conversation so far. The session's id is
  // Claude Code's own: a session started here can be resumed after the API restarts.
  async start(input: StartInput): Promise<string> {
    const { prompt, mode, resume, repos } = input
    const attached = input.attached ?? {}
    const id = resume ?? randomUUID()
    const running = this.#sessions.get(id)
    if (running && !running.closed) {
      this.send(id, prompt, attached)
      return id
    }
    const { store } = this.deps
    const known = await store.find(id)
    // A session starts at the root of the workspace holding its repos (see workspaceRoot); one taken up again goes on
    // in its own folder, the repo's for a session of the terminal the app did not start.
    const settings = await this.deps.settings()
    const cwd = input.cwd ?? known?.cwd ?? (resume ? repos[0] : await this.#root(repos))
    const place = await placeOf(cwd)
    const past = resume ? await this.#saved(id, cwd) : null
    const row =
      known ??
      store.fresh({ id, cwd, taskId: input.taskId ?? null, repos, title: past?.title ?? clip(prompt, 80), mode, status: 'running' })
    const model = input.model !== undefined ? input.model : (known?.model ?? null)
    const effort = input.effort !== undefined ? input.effort : ((known?.effort as SessionEffort | null) ?? null)
    Object.assign(row, { mode, model, effort, status: 'running' })
    await store.save(row)
    // Taken up again, an archived session is back in the list.
    if (resume) await store.archive(id, false)

    const session: Live = {
      id,
      cwd,
      mode,
      model,
      effort,
      status: 'running',
      events: [],
      query: null,
      // The first message waits for the worktrees, whose paths it gives (see #prepare).
      inbox: [],
      wake: null,
      closed: false,
      pending: new Map(),
      saving: Promise.resolve(),
      partial: '',
      partialTimer: null,
      done: Promise.resolve(),
      apiKeySource: null,
      title: row.title,
    }
    this.#sessions.set(id, session)
    this.deps.tell.sessions(id, 'running')
    this.#publish(id, { type: 'status', status: 'running' })
    for (const e of past?.events ?? []) this.#push(session, e)
    if (past) this.#push(session, { kind: 'info', text: 'Session reprise' })
    if (place.wsl) this.#push(session, { kind: 'info', text: `Dans WSL (${place.wsl.distro}) : ${place.wsl.claude}` })
    this.#push(session, { kind: 'user', text: shownText(prompt, attached) })
    void this.#prepare(session, prompt, input.worktrees ?? [], attached)

    const tools = this.deps.tools ?? []
    const context: ToolContext = {
      sessionId: id,
      root: cwd,
      configDir: place.configDir ?? localConfigDir(),
      wslHome: place.wsl?.home,
      confirm: (tool, detail) => this.#confirm(session, tool, detail),
      slotBusy: (by) => this.#notify(session, 'slot', 'Créneau exécutable pris', `${session.title} attend ${by}`),
    }
    const query = sdk().query({
      prompt: this.#inbox(session),
      options: {
        cwd: place.cwd,
        env: sessionEnv(),
        ...(resume ? { resume: id } : { sessionId: id }),
        ...place.options,
        ...(this.deps.executable ? { pathToClaudeCodeExecutable: this.deps.executable } : {}),
        permissionMode: mode satisfies PermissionMode,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        allowDangerouslySkipPermissions: true,
        // Claude Code's own prompt, plus, with the workspace's tools, the instruction to use them and the module's
        // skills first (not shown in the conversation).
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(tools.length ? { append: TOOLS_PROMPT } : {}) },
        // By default the user's settings, hooks and skills, and the repo's: a session behaves as in the terminal.
        settingSources: settings.settingSources.filter((s): s is 'user' | 'project' | 'local' => ['user', 'project', 'local'].includes(s)),
        // The text as it is written, shown before its message is complete.
        includePartialMessages: true,
        // The module's skills, where that Claude Code reaches them (a Linux path inside WSL).
        plugins: (this.deps.plugins ?? []).map((path) => ({ type: 'local' as const, path: place.wsl ? pathInWsl(path) : path })),
        // The workspace's tools: they ask the user themselves before writing, whatever the mode, so #ask lets them
        // through (not allowedTools, which would skip canUseTool and make the SDK warn).
        ...(tools.length ? { mcpServers: { [SERVER]: workspaceServer(tools, context) } } : {}),
        canUseTool: (name, toolInput, { signal, suggestions }) => this.#ask(session, name, toolInput, { signal, suggestions }),
      },
    })
    session.query = query
    session.done = this.#read(session, query).then(() => session.saving.then(() => undefined))
    return id
  }

  // The sessions' tasks, by id: those of the user's board (the list names them even when the board hides them).
  async #taskNames(): Promise<Map<string, { ref: string | null; title: string }>> {
    const tasks = await this.deps.tasks().catch(() => null)
    const board = tasks ? await tasks.board().catch(() => null) : null
    return new Map((board?.tasks ?? []).map((t) => [t.id, { ref: t.ref, title: t.title }]))
  }

  // The app's sessions (running or saved), then those Claude Code saved for these repos (from the terminal or VS
  // Code), the newest first.
  async list(repos: string[]): Promise<SessionSummary[]> {
    const { store } = this.deps
    const rows = await store.all()
    const archived = await store.archived()
    const tasks = await this.#taskNames()
    const taskOf = (id: string | null) => {
      if (!id) return null
      return tasks.get(id) ?? null
    }
    // A session of the terminal has a row only to carry the task it was attached to: the history below stays the
    // source for its title and its dates, which go on changing without the app.
    const byId = new Map(rows.map((r) => [r.id, r]))
    const ours: SessionSummary[] = rows
      .filter((r) => r.origin !== 'terminal')
      .map((r) => ({
        id: r.id,
        cwd: r.cwd,
        title: r.title,
        taskId: r.taskId,
        task: taskOf(r.taskId),
        repos: r.repos,
        startedAt: r.createdAt,
        updatedAt: r.updatedAt,
        status: this.#sessions.get(r.id)?.status ?? r.status,
        // Started from the app, not from the terminal or VS Code.
        fromApp: true,
        archived: archived.has(r.id),
      }))
    // Claude Code files a session under the folder it was started in. A session of the terminal often sits at the
    // root of the workspace rather than in a repo (the folder the app starts its own sessions in): it is looked in
    // too, otherwise none of those sessions would ever be listed.
    const root = await this.#root(repos).catch(() => null)
    const folders = [...new Set([...repos, ...(root ? [root] : [])])]
    const byRepo = await Promise.all(
      folders.map(async (repo) => {
        // A folder whose Claude Code cannot be found (WSL without it) lists nothing.
        const place = await placeOf(repo).catch(() => null)
        if (!place) return []
        // Worktrees only where the SDK resolves them by itself: from Windows it would have to run git, which lives
        // in WSL.
        const infos = await readHistory(place.configDir, (h) =>
          h.listSessions({ dir: place.cwd, limit: 30, includeWorktrees: !place.wsl })
        ).catch(() => [])
        return infos.map((info): SessionSummary => {
          // The row it has only if a task was attached to it afterwards.
          const row = byId.get(info.sessionId)
          return {
            id: info.sessionId,
            cwd: repo,
            title: clip(info.customTitle ?? info.summary ?? info.firstPrompt ?? info.sessionId, 80),
            taskId: row?.taskId ?? null,
            task: taskOf(row?.taskId ?? null),
            repos: [repo],
            startedAt: new Date(info.createdAt ?? info.lastModified).toISOString(),
            updatedAt: new Date(info.lastModified).toISOString(),
            status: 'saved',
            fromApp: false,
            archived: archived.has(info.sessionId),
          }
        })
      })
    )
    const known = new Set(ours.map((s) => s.id))
    const others = byRepo.flat().filter((s) => !known.has(s.id))
    // The same session saved under two folders (a repo and the root) once.
    const seen = new Set<string>()
    return [...ours, ...others]
      .filter((s) => !seen.has(s.id) && Boolean(seen.add(s.id)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Attaches a task to a session, or takes it off with `null`. A session of the terminal has no row of its own: one
   * is made, marked as coming from there so the list goes on telling the two apart, and it holds nothing but the link
   * — its title and its dates keep coming from Claude Code's history.
   */
  async setTask(id: string, taskId: string | null, cwd?: string): Promise<boolean> {
    const row = await this.deps.store.find(id)
    if (row) {
      row.taskId = taskId
      await this.deps.store.save(row)
      this.deps.tell.sessions(id, row.status)
      return true
    }
    if (!cwd || !(await this.#terminalRow(id, cwd, taskId))) return false
    this.deps.tell.sessions(id, 'saved')
    return true
  }

  // The row of a session of the terminal, made when something has to be kept about it (its task, its model…).
  async #terminalRow(id: string, cwd: string, taskId: string | null): Promise<SessionRow | null> {
    const place = await placeOf(cwd).catch(() => null)
    const info = await readHistory(place?.configDir, (h) => h.getSessionInfo(id, place ? { dir: place.cwd } : {})).catch(() => undefined)
    if (!info) return null
    const row = this.deps.store.fresh({
      id,
      cwd,
      taskId,
      origin: 'terminal',
      repos: [],
      mode: 'default',
      status: 'saved',
      title: clip(info.customTitle ?? info.summary ?? info.firstPrompt ?? id, 80),
    })
    await this.deps.store.save(row)
    return row
  }

  // Archives a session, or brings it back: the list sets it apart. A session still running is not archived (false):
  // it must be stopped first.
  async setArchived(id: string, archived: boolean): Promise<boolean> {
    const s = this.#sessions.get(id)
    if (s && !s.closed) return false
    await this.deps.store.archive(id, archived)
    this.deps.tell.sessions(id, 'saved')
    return true
  }

  // How a running session is billed: the user's Claude subscription, or an API key.
  loginOf(id: string): 'subscription' | 'apiKey' | null {
    const source = this.#sessions.get(id)?.apiKeySource
    if (!source) return null
    return source === 'none' ? 'subscription' : 'apiKey'
  }

  // What the session's last turn cost, as Claude Code estimates it; null before its first answer.
  costOf(id: string): number | null {
    const last = (this.#sessions.get(id)?.events ?? []).findLast((e) => e.kind === 'result')
    return last && last.kind === 'result' ? last.costUsd : null
  }

  // The first messages the new session window offers: the module's skills (read in its plugins), then the other
  // skills the last session announced (the user's, the repo's).
  async templates(): Promise<Template[]> {
    const found: Template[] = []
    // Rules Claude reads by itself (Claude Code hides them from the / menu), not first messages.
    const hidden = new Set<string>()
    for (const plugin of this.deps.plugins ?? []) {
      const manifest = await readFile(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')
        .then((t) => manifestSchema.parse(JSON.parse(t)))
        .catch(() => ({ name: undefined }))
      const dirs = await readdir(join(plugin, 'skills')).catch((): string[] => [])
      for (const dir of dirs.sort()) {
        const text = await readFile(join(plugin, 'skills', dir, 'SKILL.md'), 'utf8').catch(() => '')
        const field = (key: string) => text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim()
        const base = field('name') ?? dir
        const name = manifest.name ? `${manifest.name}:${base}` : base
        if (field('user-invocable') === 'false') hidden.add(name)
        else found.push({ name, description: field('description') ?? '' })
      }
    }
    const known = new Set([...found.map((t) => t.name), ...hidden])
    for (const name of this.#skills) {
      if (!known.has(name)) found.push({ name, description: '' })
    }
    return found
  }

  // A running session from line `after`; a saved one read from its transcript (always whole). `cwd`: the folder of a
  // terminal session, which has no row; one of the app ran where its row says.
  async eventsOf(id: string, after: number, cwd?: string): Promise<SessionEvents | null> {
    const s = this.#sessions.get(id)
    if (s) {
      return { id: s.id, cwd: s.cwd, mode: s.mode, model: s.model, effort: s.effort, status: s.status, events: s.events.filter((e) => e.seq > after) }
    }
    const row = await this.deps.store.find(id)
    const folder = row?.cwd ?? cwd
    // Kept for watch(): under Windows the transcript cannot be found without the folder, which says which distro
    // holds it.
    if (folder) this.#folders.set(id, folder)
    const past = await this.#saved(id, folder)
    if (!past) return null
    return {
      id,
      cwd: folder ?? '',
      mode: row?.mode ?? 'default',
      model: row?.model ?? null,
      effort: row?.effort ?? null,
      status: 'saved',
      // A transcript only grows, so a line keeps its number from one read to the next.
      events: past.events.map((e, i) => numbered(e, i + 1)).filter((e) => e.seq > after),
    }
  }

  /**
   * The tokens a session used, read back from Claude Code's transcript. Every assistant message carries its own
   * `usage` and its model, so this works for a session the app never ran; the dollars, which the transcript does not
   * hold, stay out.
   */
  async tokensOf(id: string, cwd?: string): Promise<UsageByModel> {
    const place = cwd ? await placeOf(cwd).catch(() => null) : null
    const messages = await readHistory(place?.configDir, (h) => h.getSessionMessages(id, place ? { dir: place.cwd } : {})).catch(() => [])
    const totals: UsageByModel = {}
    for (const m of messages) {
      const parsed = pricedMessageSchema.safeParse(m.message)
      if (m.type !== 'assistant' || !parsed.success) continue
      const { model, usage } = parsed.data
      const into = (totals[model] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
      })
      into.inputTokens += usage.input_tokens ?? 0
      into.outputTokens += usage.output_tokens ?? 0
      into.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
      into.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
      const thinking = usage.output_tokens_details?.thinking_tokens
      if (thinking) into.thinkingTokens = (into.thinkingTokens ?? 0) + thinking
    }
    return totals
  }

  async #saved(id: string, cwd?: string) {
    const place = cwd ? await placeOf(cwd).catch(() => null) : null
    const messages = await readHistory(place?.configDir, (h) => h.getSessionMessages(id, place ? { dir: place.cwd } : {})).catch(() => [])
    if (!messages.length) return null
    const events = messages.flatMap(eventsOfMessage)
    const first = events.find((e) => e.kind === 'user')
    return { events, title: clip(first && 'text' in first ? first.text : id, 80) }
  }

  /**
   * A session this app does not run, looked at in the interface: its transcript is read again while someone watches
   * it, and the lines that appeared go out as its events. Nothing runs when nobody is looking: the interface renews
   * its watch while it shows the session, and one not renewed ends after WATCH_TTL_MS.
   */
  watch(id: string, cwd?: string): void {
    if (cwd) this.#folders.set(id, cwd)
    // A session of the app already tells its own news as it goes.
    if (this.#sessions.has(id)) return
    const known = this.#watched.get(id)
    if (known) {
      known.until = Date.now() + WATCH_TTL_MS
      return
    }
    const entry: Watched = { timer: null, until: Date.now() + WATCH_TTL_MS, mark: null, sent: 0, reading: false, live: false }
    entry.timer = setInterval(() => {
      if (Date.now() > entry.until) this.unwatch(id)
      else void this.#reread(id, entry)
    }, WATCH_MS)
    entry.timer.unref()
    this.#watched.set(id, entry)
  }

  unwatch(id: string): void {
    const w = this.#watched.get(id)
    if (!w) return
    if (w.timer) clearInterval(w.timer)
    this.#watched.delete(id)
  }

  get watching(): string[] {
    return [...this.#watched.keys()]
  }

  // One round: the transcript's size and date first, which are cheap; its lines only when they changed.
  async #reread(id: string, entry: Watched): Promise<void> {
    if (entry.reading) return
    entry.reading = true
    try {
      const cwd = this.#folders.get(id)
      const place = cwd ? await placeOf(cwd).catch(() => null) : null
      const info = await readHistory(place?.configDir, (h) => h.getSessionInfo(id, place ? { dir: place.cwd } : {})).catch(() => undefined)
      const mark = info ? `${info.lastModified}:${info.fileSize ?? ''}` : null
      if (!mark || mark === entry.mark) {
        // Quiet since the round before: it is not being written to any more.
        if (entry.live) {
          entry.live = false
          this.#publish(id, { type: 'status', status: 'saved' })
        }
        return
      }
      const past = await this.#saved(id, cwd)
      const events = (past?.events ?? []).map((e, i) => numbered(e, i + 1))
      // The first round only takes the measure: the interface has just read the same lines itself.
      if (entry.mark !== null) {
        if (!entry.live) {
          entry.live = true
          this.#publish(id, { type: 'status', status: 'running' })
        }
        for (const event of events.filter((e) => e.seq > entry.sent)) this.#publish(id, { type: 'event', event })
      }
      entry.mark = mark
      entry.sent = events.length
    } finally {
      entry.reading = false
    }
  }

  send(id: string, text: string, attached: Attachments = {}): boolean {
    const s = this.#sessions.get(id)
    if (!s || s.closed) return false
    this.#push(s, { kind: 'user', text: shownText(text, attached) })
    this.#setStatus(s, 'running')
    s.inbox.push(userMessage(text, attached))
    s.wake?.()
    return true
  }

  decide(id: string, requestId: string, decision: Decision): boolean {
    const s = this.#sessions.get(id)
    const asked = s?.pending.get(requestId)
    if (!s || !asked) return false
    s.pending.delete(requestId)
    const { allow, message } = decision
    const always = Boolean(allow && decision.always && asked.suggestions.length)
    const answers = allow && decision.answers ? decision.answers : null
    const answer = answers
      ? Object.entries(answers)
          .map(([q, a]) => `${q} ${a}`)
          .join('\n')
      : (message ?? null)
    this.#push(s, { kind: 'decision', id: requestId, allow, always, answer })
    const kept = { id: requestId, tool: asked.tool, detail: asked.detail, allow, at: new Date().toISOString() }
    this.#save(s, (row) => row.decisions.push(kept))
    if (!s.pending.size) this.#setStatus(s, 'running')
    if (!allow) {
      asked.resolve({ behavior: 'deny', message: message || "Refusé par l'utilisateur" })
    } else {
      asked.resolve({
        behavior: 'allow',
        ...(answers ? { updatedInput: { ...asked.input, answers } } : {}),
        ...(always ? { updatedPermissions: asked.suggestions } : {}),
      })
    }
    return true
  }

  // A saved session's choice is kept on its row, for when it is taken up again. A session of the terminal gets a row
  // for it (its folder is known from the page having read it).
  async #keepSaved(id: string, patch: Partial<Pick<Live, 'mode' | 'model' | 'effort'>>): Promise<boolean> {
    const s = this.#sessions.get(id)
    if (s) Object.assign(s, patch)
    const folder = this.#folders.get(id)
    const row = (await this.deps.store.find(id)) ?? (folder ? await this.#terminalRow(id, folder, null) : null)
    if (!row) return true
    Object.assign(row, patch)
    await this.deps.store.save(row)
    return true
  }

  async setMode(id: string, mode: SessionMode): Promise<boolean> {
    const s = this.#sessions.get(id)
    if (!s || s.closed) return this.#keepSaved(id, { mode })
    await s.query?.setPermissionMode(mode)
    this.#modeChanged(s, mode)
    return true
  }

  // The mode changed, from the page or by Claude Code itself (a plan accepted leaves the Plan mode).
  #modeChanged(s: Live, mode: SessionMode) {
    if (s.mode === mode) return
    s.mode = mode
    this.#save(s, (row) => (row.mode = mode))
    this.#push(s, { kind: 'info', text: `Mode : ${mode}` })
    this.#publishSettings(s)
  }

  // The model changed by a /model command of the conversation: the page's field follows.
  #modelChanged(s: Live, model: string) {
    if (s.model === model) return
    s.model = model
    this.#save(s, (row) => (row.model = model))
    this.#publishSettings(s)
  }

  // null: back to Claude Code's default model.
  async setModel(id: string, model: string | null): Promise<boolean> {
    const s = this.#sessions.get(id)
    if (!s || s.closed) return this.#keepSaved(id, { model })
    await s.query?.setModel(model ?? undefined)
    s.model = model
    this.#save(s, (row) => (row.model = model))
    this.#push(s, { kind: 'info', text: `Modèle : ${model ?? 'par défaut'}` })
    this.#publishSettings(s)
    return true
  }

  // null: back to the model's default effort.
  async setEffort(id: string, effort: SessionEffort | null): Promise<boolean> {
    const s = this.#sessions.get(id)
    if (!s || s.closed) return this.#keepSaved(id, { effort })
    await s.query?.applyFlagSettings({ effortLevel: effort ?? undefined })
    s.effort = effort
    this.#save(s, (row) => (row.effort = effort))
    this.#push(s, { kind: 'info', text: `Effort : ${effort ?? 'par défaut'}` })
    this.#publishSettings(s)
    return true
  }

  #publishSettings(s: Live) {
    this.#publish(s.id, { type: 'settings', mode: s.mode, model: s.model, effort: s.effort })
  }

  // The models Claude Code offers here, with their effort levels: those the last session started read, else those of
  // a Claude Code started in the workspace's root without any message (nothing reaches Claude). Empty when Claude
  // Code cannot be started.
  async models(repos: string[]): Promise<SessionModel[]> {
    if (this.#models.length) return this.#models
    this.#probing ??= this.#probeModels(repos).finally(() => (this.#probing = null))
    return this.#probing
  }

  async #probeModels(repos: string[]): Promise<SessionModel[]> {
    const root = await this.#root(repos).catch(() => null)
    const place = root ? await placeOf(root).catch(() => null) : null
    if (!place) return []
    let wake = () => {}
    const quiet = new Promise<void>((resolve) => (wake = resolve))
    const q = sdk().query({
      // No message: the process only answers the SDK's questions.
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await quiet
        yield* []
      })(),
      options: {
        cwd: place.cwd,
        env: sessionEnv(),
        ...place.options,
        ...(this.deps.executable ? { pathToClaudeCodeExecutable: this.deps.executable } : {}),
        settingSources: [],
      },
    })
    try {
      this.#keepModels(await q.supportedModels())
    } catch {
      // No Claude Code here, or not logged in: the page offers only the default.
    } finally {
      wake()
      q.close()
    }
    return this.#models
  }

  #keepModels(models: ModelInfo[]) {
    this.#models = models.map((m) => ({
      value: m.value,
      label: m.displayName,
      description: m.description,
      efforts: m.supportsEffort ? ((m.supportedEffortLevels ?? []) as SessionEffort[]) : [],
    }))
  }

  async interrupt(id: string): Promise<boolean> {
    const s = this.#sessions.get(id)
    if (!s || s.closed) return false
    for (const [requestId] of s.pending) this.decide(id, requestId, { allow: false })
    await s.query?.interrupt()
    return true
  }

  // Stops a session and waits until it has ended and its state is saved.
  async close(id: string): Promise<void> {
    const s = this.#sessions.get(id)
    if (!s) return
    this.stop(id)
    await s.done
  }

  stop(id: string): boolean {
    const s = this.#sessions.get(id)
    if (!s) return false
    s.closed = true
    s.wake?.()
    s.query?.close()
    return true
  }

  // Creates the worktrees the session starts with (a task's branches), then gives Claude the first message with their
  // paths. One that fails is said, and Claude is told to create it with its tools.
  async #prepare(s: Live, prompt: string, worktrees: { repo: string; branch: string }[], attached: Attachments) {
    const ready: string[] = []
    if (worktrees.length && this.deps.worktree) {
      this.#push(s, { kind: 'info', text: 'Préparation des worktrees…' })
      for (const { repo, branch } of worktrees) {
        try {
          const { path } = await this.deps.worktree(repo, branch)
          ready.push(`- ${branch} : ${path}`)
          this.#push(s, { kind: 'info', text: `Worktree de ${branch} prêt : ${path}` })
          this.#save(s, (row) => {
            if (!row.worktrees.includes(path)) row.worktrees.push(path)
          })
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          this.#push(s, { kind: 'error', text: `Worktree de ${branch} non créé : ${why}` })
        }
      }
    }
    const text = ready.length ? `${prompt}\n\nWorktrees prêts, où travailler (jamais dans le checkout principal) :\n${ready.join('\n')}` : prompt
    s.inbox.push(userMessage(text, attached))
    s.wake?.()
  }

  // Resolves once the row's writes asked so far are done (the tests wait on it).
  async settled(id: string): Promise<void> {
    await this.#sessions.get(id)?.saving
  }

  #push(s: Live, event: NewEvent) {
    const line = numbered(event, s.events.length + 1)
    s.events.push(line)
    this.#publish(s.id, { type: 'event', event: line })
  }

  // Text being written: gathered, then sent at most every PARTIAL_MS.
  #partial(s: Live, text: string) {
    s.partial += text
    s.partialTimer ??= setTimeout(() => {
      s.partialTimer = null
      if (!s.partial) return
      this.#publish(s.id, { type: 'partial', text: s.partial })
      s.partial = ''
    }, PARTIAL_MS).unref()
  }

  // The message is complete: its text line replaces what was being written.
  #endPartial(s: Live) {
    if (s.partialTimer) clearTimeout(s.partialTimer)
    s.partialTimer = null
    s.partial = ''
  }

  #save(s: Live, change: (row: SessionRow) => void) {
    s.saving = s.saving
      .then(async () => {
        const row = await this.deps.store.find(s.id)
        if (!row) return
        change(row)
        await this.deps.store.save(row)
      })
      .catch(() => {})
  }

  // What the turn cost, on the session's row: Claude Code counts from the session's start, so the latest result
  // replaces what was there. The transcript keeps none of it, so a figure not kept here is lost when the app stops.
  #keepUsage(s: Live, usage: unknown, costUsd: number, turns: number): void {
    const parsed = usageByModel.safeParse(usage)
    this.#save(s, (row) => {
      row.usage = parsed.success ? parsed.data : {}
      row.costUsd = costUsd
      row.turns = turns
      // Read from the session's first message (system:init); not in the transcript either.
      if (s.apiKeySource) row.login = s.apiKeySource === 'none' ? 'subscription' : 'apiKey'
    })
  }

  #setStatus(s: Live, status: SessionStatus) {
    if (s.status === status) return
    s.status = status
    this.#save(s, (row) => (row.status = status))
    this.deps.tell.sessions(s.id, status)
    this.#publish(s.id, { type: 'status', status })
    if (status === 'waiting') this.#notify(s, 'decision', 'Claude attend une décision')
  }

  // Worth a notification of the system: the interface shows it if the user asked for this kind.
  #notify(s: Live, kind: NoticeKind, title: string, body = s.title) {
    this.#publish(s.id, { type: 'notice', kind, title, body })
  }

  // The prompt stream: waits for the next message typed on the page, ends when the session stops.
  async *#inbox(s: Live): AsyncGenerator<SDKUserMessage> {
    while (!s.closed) {
      const next = s.inbox.shift()
      if (next) {
        yield next
        continue
      }
      await new Promise<void>((resolve) => (s.wake = resolve))
      s.wake = null
    }
  }

  // One of the workspace's tools asks before it writes: the same card as Claude Code's own permissions.
  #confirm(s: Live, tool: string, detail: string): Promise<boolean> {
    const id = randomUUID()
    this.#push(s, { kind: 'permission', id, name: tool, detail, ask: 'tool', canAlways: false, plan: null, questions: [] })
    this.#setStatus(s, 'waiting')
    return new Promise<boolean>((resolve) => {
      s.pending.set(id, { tool, detail, input: {}, suggestions: [], resolve: (r) => resolve(r.behavior === 'allow') })
    })
  }

  // Claude Code asks: a tool's permission, a plan to validate (ExitPlanMode), or questions to answer
  // (AskUserQuestion).
  #ask(
    s: Live,
    name: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
  ): Promise<PermissionResult> {
    // The workspace's tools confirm their writes themselves (see tools.ts): no second card.
    if (name.startsWith(`mcp__${SERVER}__`)) return Promise.resolve({ behavior: 'allow' })
    const id = randomUUID()
    const detail = detailOf(input)
    const ask: Ask = name === 'ExitPlanMode' ? 'plan' : name === 'AskUserQuestion' ? 'question' : 'tool'
    const suggestions = ask === 'tool' ? (options.suggestions ?? []) : []
    this.#push(s, {
      kind: 'permission',
      id,
      name,
      detail,
      ask,
      canAlways: suggestions.length > 0,
      plan: typeof input['plan'] === 'string' ? input['plan'] : null,
      questions: ask === 'question' ? questionsOf(input['questions']) : [],
    })
    this.#setStatus(s, 'waiting')
    return new Promise<PermissionResult>((resolve) => {
      s.pending.set(id, { tool: name, detail, input, suggestions, resolve })
      options.signal.addEventListener('abort', () => this.decide(s.id, id, { allow: false }))
    })
  }

  async #read(s: Live, query: Query) {
    try {
      for await (const m of query) this.#record(s, m)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      this.#push(s, { kind: 'error', text })
      this.#notify(s, 'error', 'Session Claude en erreur', `${s.title} : ${text}`)
    }
    s.closed = true
    this.#push(s, { kind: 'info', text: 'Session terminée' })
    this.#setStatus(s, 'saved')
  }

  // What a command typed in the message box printed (/model…): a note, and a new model is the session's.
  #commandOutput(s: Live, output: string) {
    for (const note of noteOf(output)) this.#push(s, note)
    const named = modelOfOutput(output)
    const model = named ? modelValueOf(this.#models, named) : null
    if (model) this.#modelChanged(s, model)
  }

  #record(s: Live, m: SDKMessage) {
    const subtype = 'subtype' in m ? m.subtype : undefined
    const key = m.type === 'system' ? `system:${subtype}` : m.type
    if (m.type === 'stream_event') {
      const e = m.event
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') this.#partial(s, e.delta.text)
      return
    }
    if (m.type === 'assistant') this.#endPartial(s)
    if (key === 'system:init' && m.type === 'system' && 'claude_code_version' in m) {
      this.#skills = m.skills ?? []
      s.apiKeySource = m.apiKeySource
      for (const e of m.plugin_errors ?? []) this.#push(s, { kind: 'error', text: `Plugin ${e.plugin} non chargé : ${e.message}` })
      s.query
        ?.supportedModels()
        .then((models) => this.#keepModels(models))
        .catch(() => {})
    } else if (key === 'system:status' && m.type === 'system' && 'permissionMode' in m) {
      const mode = m.permissionMode
      if (mode && isSessionMode(mode)) this.#modeChanged(s, mode)
    } else if (m.type === 'system' && m.subtype === 'local_command_output') {
      this.#commandOutput(s, m.content)
    } else if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text.trim()) this.#push(s, { kind: 'text', text: block.text })
        if (block.type === 'tool_use') {
          const input = inputOf(block.input)
          this.#push(s, { kind: 'tool', id: block.id, name: block.name, detail: detailOf(input), change: changeOf(block.name, input) })
        }
      }
    } else if (m.type === 'user') {
      // Text: the answer of a command of the message box, as the transcript has it (tagged).
      if (typeof m.message.content === 'string') {
        const output = tagOf('local-command-stdout', m.message.content)
        if (output !== null) this.#commandOutput(s, output)
        return
      }
      if (!Array.isArray(m.message.content)) return
      for (const block of m.message.content) {
        if (block.type !== 'tool_result') continue
        const content = block.content
        const text =
          typeof content === 'string' ? content : (content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
        this.#push(s, { kind: 'tool_result', id: block.tool_use_id, ok: !block.is_error, text: clip(text) })
      }
    } else if (m.type === 'result') {
      // The line first: whoever reacts to the new state has it already.
      this.#push(s, {
        kind: 'result',
        ok: !m.is_error,
        text: m.subtype === 'success' ? '' : m.subtype,
        costUsd: m.total_cost_usd,
        turns: m.num_turns,
      })
      // Kept at once, not at the end: a session killed with the app would lose it.
      this.#keepUsage(s, m.modelUsage, m.total_cost_usd, m.num_turns)
      this.#setStatus(s, 'idle')
      this.#notify(s, 'turn', m.is_error ? 'Claude s’est arrêté' : 'Claude a terminé')
    } else if (!QUIET.has(key)) {
      this.#push(s, { kind: 'other', type: key, text: summaryOf(m) })
    }
  }
}
