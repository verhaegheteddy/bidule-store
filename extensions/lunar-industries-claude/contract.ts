// Lunar Industries - Claude: Simon's Claude module (quack-board), an unofficial one competing with Bidule's own
// (`claude`, which runs the official `claude` in the terminal). Claude Code sessions run in the app by the Agent SDK,
// with the workspace's tools (MCP server `workspace`) and the team's skills. Types only: the interface reads this file.
//
// Its routes, under /api/ext/lunar-industries-claude (each answers 403 `{ error }` while the module is off):
//   GET  status                          { enabled, places: ClaudePlace[] }
//   GET  sessions                        { sessions: SessionSummary[] }
//   POST sessions                        StartBody → { id }
//   GET  sessions/:id/events?after&cwd   SessionEvents
//   GET  sessions/:id/context?cwd        SessionContext
//   POST sessions/:id/messages           { text, images?, files? } → { ok }
//   POST sessions/:id/decisions/:request Decision → { ok }
//   PUT  sessions/:id/mode | model | effort | archive | task
//   POST sessions/:id/interrupt | stop
//   POST sessions/:id/watch, DELETE sessions/:id/watch   (a session of the terminal, read again while shown)
//   GET  templates                       { templates: Template[] }
//   GET  models                          { models: SessionModel[] }
//   GET  repos                           { repos: RepoSettings[] }

// running: Claude works; waiting: a decision is expected from the user; idle: Claude answered and waits for a
// message; saved: no Claude Code process, the session can be taken up again.
export type SessionStatus = 'running' | 'waiting' | 'idle' | 'saved'

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const
export type SessionMode = (typeof PERMISSION_MODES)[number]
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type SessionEffort = (typeof EFFORT_LEVELS)[number]
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

// What a message can carry besides its text: images (base64), and text files the interface has read.
export type Attachments = {
  images?: { name: string; mediaType: (typeof IMAGE_TYPES)[number]; data: string }[]
  files?: { name: string; text: string }[]
}

// What a tool call shows of a file change (the page draws its diff): an edit's text replaced and its replacement, a
// new file's content in `after`.
export type ToolChange = { file: string; before: string; after: string }

// What a decision card asks: a tool's permission, a plan to validate, or Claude's questions.
export type Ask = 'tool' | 'plan' | 'question'
export type Question = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

// One line of the conversation, numbered in order (`seq`, from 1). `other`: a message the app does not know yet.
export type SessionEvent =
  | { seq: number; kind: 'user'; text: string }
  | { seq: number; kind: 'text'; text: string }
  | { seq: number; kind: 'tool'; id: string; name: string; detail: string; change: ToolChange | null }
  | { seq: number; kind: 'tool_result'; id: string; ok: boolean; text: string }
  | {
      seq: number
      kind: 'permission'
      id: string
      name: string
      detail: string
      ask: Ask
      // Claude Code proposes a rule so as not to ask again for this command in the session.
      canAlways: boolean
      plan: string | null
      questions: Question[]
    }
  | { seq: number; kind: 'decision'; id: string; allow: boolean; always: boolean; answer: string | null }
  | { seq: number; kind: 'info'; text: string }
  | { seq: number; kind: 'result'; ok: boolean; text: string; costUsd: number; turns: number }
  | { seq: number; kind: 'error'; text: string }
  | { seq: number; kind: 'other'; type: string; text: string }

// What one session tells as it happens (event `lunar-industries-claude.session`, with its `id`): a line, kept (a
// reconnection reads the missed ones again from `seq`); text being written, to add to what came before and replaced
// by the `text` line once complete; the session's new state; its mode, model or effort changed.
export type SessionMessage =
  | { type: 'event'; event: SessionEvent }
  | { type: 'partial'; text: string }
  | { type: 'status'; status: SessionStatus }
  | { type: 'settings'; mode: string; model: string | null; effort: string | null }
  // Worth a notification of the system (the interface keeps those the `notify` setting names); its click opens the
  // session.
  | { type: 'notice'; kind: NoticeKind; title: string; body: string }

export type NoticeKind = 'decision' | 'turn' | 'error' | 'slot'

// A session in the list: started from the app, or saved by Claude Code from the terminal or VS Code.
export type SessionSummary = {
  id: string
  cwd: string
  title: string
  taskId: string | null
  task: { ref: string | null; title: string } | null
  repos: string[]
  startedAt: string
  updatedAt: string
  status: SessionStatus
  fromApp: boolean
  archived: boolean
}

export type SessionEvents = {
  id: string
  cwd: string
  mode: string
  model: string | null
  effort: string | null
  status: SessionStatus
  events: SessionEvent[]
}

// Tokens by model; `costUsd` only when the session's turns reported it (null: read back from the transcript).
export type UsageRow = {
  model: string
  input: number
  output: number
  thinking: number | null
  cacheRead: number
  cacheWrite: number
  costUsd: number | null
  basis: 'list' | 'managed' | 'unknown' | null
}

// What the page shows beside the conversation.
export type SessionContext = {
  id: string
  cwd: string
  task: { id: string; ref: string | null; title: string; status: string; url: string | null } | null
  repos: { label: string; path: string }[]
  worktrees: {
    path: string
    repo: string | null
    branch: string
    files: { path: string; added: number | null; removed: number | null }[]
  }[]
  where: string
  login: 'subscription' | 'apiKey' | null
  slot: { repo: string; session: string; alive: boolean; mine: boolean }[]
  costUsd: number | null
  turns: number | null
  usage: UsageRow[]
}

// A model Claude Code offers, with the effort levels it takes (none: the model has no effort).
export type SessionModel = { value: string; label: string; description: string; efforts: SessionEffort[] }

// A first message the new session window offers: a skill.
export type Template = { name: string; description: string }

// The Claude Code the sessions run: this machine's (the SDK's), or WSL's on Windows.
export type ClaudePlace = {
  where: string
  version: string | null
  loggedIn: boolean
  email: string | null
  subscription: string | null
  error: string | null
}

export type StartBody = {
  repos: string[]
  prompt: string
  mode: SessionMode
  model?: string | null
  effort?: SessionEffort | null
  // A saved session to take up again.
  resume?: string
  taskId?: string | null
  // The folder of a session of the terminal taken up again.
  cwd?: string
} & Attachments

// The user's answer to a card: allow or refuse; `always` keeps the proposed rule for the session; `answers` answers
// Claude's questions (question → label chosen); `message` is the instruction given with a refusal.
export type Decision = { allow: boolean; always?: boolean; answers?: Record<string, string>; message?: string }

// A repo's own settings for the sessions and their tools (Réglages; empty: the module's, see the settings).
export type RepoOverrides = {
  reviewTarget?: string
  // Untracked files to copy into a new worktree (globs relative to the repo) and the command that prepares it.
  worktreeSeed?: string
  worktreePrepare?: string
  stagingBranch?: string
  productionBranch?: string
  stagingJob?: string
  productionJob?: string
  stagingEnv?: string
}
export type RepoSettings = { path: string; label: string } & RepoOverrides

declare module '@bidule/sdk/contracts' {
  interface Commands {
    // A new session, on a task when one is given (interface: its window, then the page).
    'lunar-industries-claude.newSession': (args: { taskId?: string }) => { session: string } | null
    // The task taken to staging by the team's skill (workspace:task-to-staging), in a new session.
    'lunar-industries-claude.startTask': (args: { taskId: string }) => { session: string } | null
  }
  interface Events {
    // A session was created, changed state, was archived or got its task.
    'lunar-industries-claude.sessions': { id: string; status: SessionStatus }
    // What one session tells (see SessionMessage).
    'lunar-industries-claude.session': { id: string; message: SessionMessage }
  }
}
