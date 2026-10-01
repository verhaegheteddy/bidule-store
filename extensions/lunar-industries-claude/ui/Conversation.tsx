import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { react, useOn } from '@bidule/sdk'
import {
  IMAGE_TYPES,
  type Attachments,
  type Decision,
  type SessionEffort,
  type SessionEvent,
  type SessionMessage,
  type SessionMode,
  type SessionStatus,
  type SessionSummary,
} from '../contract.ts'
import { api, errorMessage } from './api.ts'
import { Decided, DecisionCard } from './DecisionCard.tsx'
import { decidedOf, itemsOf, merge, pendingOf, STATUS, type Permission } from './events.ts'
import { Icon } from './Icon.tsx'
import { md } from './markdown.ts'
import { MenuButton } from './Menu.tsx'
import { DEFAULT, effortOf, effortOptions, effortsOf, modelOptions, modeOf, MODES, summaryOf } from './models.ts'
import { refreshSessions, select, useModels, useTemplates } from './state.ts'
import { ToolCalls } from './ToolCall.tsx'

// Kept across visits while the app runs: a message being written, by session.
const drafts = new Map<string, string>()

type ImageType = (typeof IMAGE_TYPES)[number]
const imageType = (type: string): ImageType | undefined => IMAGE_TYPES.find((t) => t === type)
const MAX_IMAGE = 5_000_000
const MAX_FILE = 1_000_000
const WATCH_MS = 15_000

type Attached =
  | { kind: 'image'; name: string; mediaType: ImageType; data: string }
  | { kind: 'file'; name: string; text: string }

// An image as base64, without the `data:` prefix.
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const attachments = (list: Attached[]): Attachments => ({
  images: list.flatMap((a) => (a.kind === 'image' ? [{ name: a.name, mediaType: a.mediaType, data: a.data }] : [])),
  files: list.flatMap((a) => (a.kind === 'file' ? [{ name: a.name, text: a.text }] : [])),
})

/**
 * A Claude session's conversation (Simon's conversation): its lines as they come (the module's
 * `lunar-industries-claude.session` event), the cards that wait for a decision, and the message box. The lines are
 * added in the order of their number; a gap reads the missed ones again from the API. A session of the terminal is
 * watched while shown, and a message takes it up again here.
 */
export function Conversation({
  session,
  heading,
  taskRef,
  repoLabels,
  focus,
  toggleFocus,
}: {
  session: SessionSummary
  heading: string
  taskRef: string | null
  repoLabels: string[]
  focus: boolean
  toggleFocus: () => void
}) {
  const sid = session.id
  const current = useRef(session)
  useEffect(() => {
    current.current = session
  })

  const [events, setEvents] = useState<SessionEvent[]>([])
  const eventsRef = useRef<SessionEvent[]>([])
  const [partial, setPartial] = useState('')
  const [status, setStatus] = useState<SessionStatus>(session.status)
  const [mode, setMode] = useState<SessionMode>('default')
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<SessionEffort | null>(null)
  const [draft, setDraftState] = useState(drafts.get(sid) ?? '')
  const [attached, setAttached] = useState<Attached[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [away, setAway] = useState(false)
  const history = useRef(-1)
  const stash = useRef('')
  const log = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const models = useModels()
  const templates = useTemplates()

  const setAll = (list: SessionEvent[]) => {
    eventsRef.current = list
    setEvents(list)
  }
  const setDraft = (text: string) => {
    drafts.set(current.current.id, text)
    setDraftState(text)
  }
  const applySettings = (s: { mode: string; model: string | null; effort: string | null }) => {
    const m = modeOf(s.mode)
    if (m) setMode(m.value)
    setModel(s.model)
    setEffort(effortOf(s.effort))
  }

  const refresh = async () => {
    const s = current.current
    try {
      const data = await api.events(s.id, eventsRef.current.at(-1)?.seq ?? 0, s.cwd || undefined)
      if (current.current.id !== s.id) return
      setStatus(data.status)
      applySettings(data)
      add(data.events)
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  const add = (incoming: SessionEvent[]) => {
    const r = merge(eventsRef.current, incoming)
    if (r.added.length) {
      if (r.added.some((e) => e.kind === 'text')) setPartial('')
      setAll(r.list)
    }
    if (r.gap) void refresh()
  }
  const onMessage = (m: SessionMessage) => {
    if (m.type === 'partial') setPartial((text) => text + m.text)
    else if (m.type === 'status') setStatus(m.status)
    else if (m.type === 'settings') applySettings(m)
    else if (m.type === 'event') add([m.event])
  }

  // Subscribed first, then read: nothing said in between is lost.
  useOn('lunar-industries-claude.session', ({ id, message }) => {
    if (id === current.current.id) onMessage(message)
  })
  useEffect(() => {
    setAll([])
    setPartial('')
    setStatus(current.current.status)
    setAway(false)
    setAttached([])
    setError(null)
    setDraftState(drafts.get(sid) ?? '')
    history.current = -1
    void refresh()
  }, [sid])

  // A session of the terminal: its transcript is read again while it is shown. The API forgets a watch after 30 s,
  // so it is asked again every 15 s.
  const fromApp = session.fromApp
  const cwd = session.cwd
  useEffect(() => {
    if (fromApp) return
    const watch = () => void api.watch(sid, cwd).catch(() => undefined)
    watch()
    const every = setInterval(watch, WATCH_MS)
    return () => {
      clearInterval(every)
      void api.unwatch(sid).catch(() => undefined)
    }
  }, [sid, fromApp, cwd])

  const decided = useMemo(() => decidedOf(events), [events])
  const pending = useMemo(() => pendingOf(events), [events])
  const items = useMemo(() => itemsOf(events), [events])
  const userTexts = useMemo(() => events.flatMap((e) => (e.kind === 'user' ? [e.text] : [])).reverse(), [events])

  const saved = status === 'saved'
  const canSend = (Boolean(draft.trim()) || attached.length > 0) && !pending.length
  // This app is the one running the session right now: it alone can be spoken to, interrupted or stopped.
  const runHere = fromApp && !saved
  // Claude is at work and there is nothing to send: the button stops it instead of sending.
  const stopping = runHere && status === 'running' && !canSend
  const placeholder = pending.length
    ? 'Répondez d’abord à la demande de Claude'
    : !runHere
      ? 'Reprendre la session avec un message'
      : status === 'running'
        ? 'Ajouter un message à la file…'
        : 'Répondre à Claude'
  const info = STATUS[status]

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await run()
    } catch (err) {
      setError(errorMessage(err))
      react('panic', errorMessage(err), errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const toEnd = () => {
    if (log.current) log.current.scrollTop = 0
    setAway(false)
  }

  // A saved session, or one of the terminal, is taken up again by Claude Code from its transcript, with this message.
  const send = async () => {
    const s = current.current
    const text = draft.trim()
    if (!canSend) return
    await act(async () => {
      if (!runHere) {
        const { id } = await api.start({
          repos: s.repos,
          prompt: text,
          mode,
          model,
          effort,
          resume: s.id,
          taskId: s.taskId,
          ...(s.fromApp ? {} : { cwd: s.cwd }),
          ...attachments(attached),
        })
        if (id !== s.id) select(id)
        refreshSessions()
      } else {
        await api.message(s.id, { text, ...attachments(attached) })
      }
      setDraft('')
      setAttached([])
      history.current = -1
      toEnd()
    })
  }
  const interrupt = () => act(() => api.interrupt(sid))
  const stop = () => act(() => api.stop(sid)).then(refreshSessions)
  const submit = () => void (stopping ? interrupt() : send())

  // A saved session keeps them on its row, for when it is taken up again. An effort the new model does not take goes
  // back to the default.
  const changeModel = async (value: string) => {
    const next = value || null
    setModel(next)
    if (effort && !effortsOf(models, next).includes(effort)) {
      setEffort(null)
      await act(() => api.effort(sid, null))
    }
    await act(() => api.model(sid, next))
  }
  const changeEffort = (value: string) => {
    const next = effortOf(value)
    setEffort(next)
    void act(() => api.effort(sid, next))
  }
  const changeMode = (value: string) => {
    const next = modeOf(value)?.value
    if (!next) return
    setMode(next)
    void act(() => api.mode(sid, next))
  }
  const decide = (card: Permission, decision: Decision) => void act(() => api.decide(sid, card.id, decision))

  const goBack = (step: 1 | -1) => {
    const next = history.current + step
    if (next >= userTexts.length || next < -1) return false
    if (history.current === -1) stash.current = draft
    history.current = next
    setDraft(next === -1 ? stash.current : (userTexts[next] ?? ''))
    return true
  }

  // Enter sends, Shift+Enter breaks the line, Escape stops Claude at work, Shift+Tab goes to the next mode, and the
  // arrows go back through the messages already sent (from the very start or end of the text).
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const el = e.currentTarget
    if (e.key === 'Escape' && runHere && status === 'running') {
      e.preventDefault()
      void interrupt()
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      const at = MODES.findIndex((m) => m.value === mode)
      changeMode(MODES[(at + 1) % MODES.length]?.value ?? 'default')
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0) {
      if (goBack(1)) e.preventDefault()
    } else if (e.key === 'ArrowDown' && history.current >= 0 && el.selectionStart === el.value.length) {
      if (goBack(-1)) e.preventDefault()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // Files chosen or pasted: images and text files, the rest is told to be unsupported.
  const attach = async (files: File[]) => {
    const added: Attached[] = []
    for (const f of files) {
      const type = imageType(f.type)
      if (type && f.size <= MAX_IMAGE) added.push({ kind: 'image', name: f.name, mediaType: type, data: await base64Of(f) })
      else if (!type && f.size <= MAX_FILE) {
        const text = await f.text()
        if (text.includes('\0')) setError(`« ${f.name} » n’est pas un fichier texte.`)
        else added.push({ kind: 'file', name: f.name, text })
      } else setError(`« ${f.name} » est trop gros ou d’un type non pris en charge.`)
    }
    setAttached((list) => [...list, ...added])
  }
  const paste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    void attach(files)
  }

  // Starts the message with the skill: Claude Code reads the / command at its start.
  const insertCommand = (name: string) => {
    setDraft(`/${name} ${draft.replace(/^\/\S*\s*/, '')}`)
    box.current?.focus()
  }

  const effortChoices = effortOptions(models, model)

  return (
    <section className={`lc-conv${focus ? ' focus' : ''}`} aria-label="Conversation">
      <header className="lc-conv-head">
        <div className="lc-conv-title grow">
          <div className="row lc-conv-title-line">
            {taskRef && <span className="mono lc-conv-ref">{taskRef}</span>}
            <h1 className="ellipsis">{heading}</h1>
          </div>
          {repoLabels.length > 0 && (
            <div className="row lc-conv-repos">
              <span className="legend">dans</span>
              {repoLabels.map((label) => (
                <span key={label} className="tag lc-tone-neutral">
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className={`tag lc-tone-${info.tone} lc-conv-status`}>
          {status === 'running' && <span className="lc-working" aria-hidden="true" />}
          {info.label}
        </span>
        <button
          type="button"
          className="btn lc-btn-sm"
          disabled={busy || !runHere || (status !== 'running' && status !== 'waiting')}
          onClick={() => void interrupt()}
        >
          Interrompre
        </button>
        <button type="button" className="btn lc-btn-sm" disabled={busy || !runHere} onClick={() => void stop()}>
          Arrêter
        </button>
        <button
          type="button"
          className="icon-btn lc-icon-sm"
          aria-pressed={focus}
          aria-label={focus ? 'Quitter le focus' : 'Focus'}
          title={`${focus ? 'Quitter le focus' : 'Focus'} · Ctrl + .`}
          aria-keyshortcuts="Control+."
          onClick={toggleFocus}
        >
          <Icon name={focus ? 'focusExit' : 'focusEnter'} size={18} />
        </button>
      </header>

      <div className="lc-log" ref={log} onScroll={(e) => setAway(e.currentTarget.scrollTop < -40)}>
        <div className="lc-lines selectable">
          {items.map((item) => {
            switch (item.kind) {
              case 'user':
                return (
                  <div key={item.seq} className="lc-user">
                    {item.text}
                  </div>
                )
              case 'text':
                return <div key={item.seq} className="lc-text" dangerouslySetInnerHTML={{ __html: md(item.text) }} />
              case 'tools':
                return (
                  <div key={item.seq} className="lc-tools-line">
                    <ToolCalls tools={item.tools} />
                  </div>
                )
              case 'permission': {
                const d = decided.get(item.id)
                return d ? (
                  <Decided key={item.seq} card={item} decision={d} />
                ) : (
                  <DecisionCard key={item.seq} card={item} busy={busy} decide={decide} />
                )
              }
              case 'decision':
                return null
              case 'info':
                return (
                  <span key={item.seq} className="legend lc-info">
                    {item.text}
                  </span>
                )
              case 'result':
                return (
                  <span key={item.seq} className="legend lc-info">
                    {item.ok ? 'Tour terminé' : `Tour interrompu : ${item.text}`}
                  </span>
                )
              case 'error':
                return (
                  <p key={item.seq} className="lc-error">
                    {item.text}
                  </p>
                )
              case 'other':
                return (
                  <span key={item.seq} className="legend lc-info">
                    {item.type} : {item.text}
                  </span>
                )
            }
          })}
          {partial && <div className="lc-text" dangerouslySetInnerHTML={{ __html: md(partial) }} />}
        </div>
      </div>

      <div className="lc-compose">
        {away && (
          <button type="button" className="btn lc-btn-sm lc-to-end" onClick={toEnd}>
            Revenir en bas
          </button>
        )}
        {error && <p className="lc-error">{error}</p>}
        <div className="lc-box">
          {attached.length > 0 && (
            <ul className="lc-attached">
              {attached.map((a, i) => (
                <li key={i} className="lc-attachment">
                  <span className="ellipsis">{a.name}</span>
                  <button
                    type="button"
                    className="icon-btn lc-icon-xs"
                    aria-label={`Retirer ${a.name}`}
                    onClick={() => setAttached((list) => list.filter((x) => x !== a))}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="lc-field">
            <span className="sr-only">Message pour Claude</span>
            <textarea
              ref={box}
              rows={1}
              placeholder={placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              onPaste={paste}
            />
          </label>
          <div className="lc-bar">
            <input
              ref={file}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void attach(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
            <MenuButton
              label="Ajouter"
              disabled={pending.length > 0}
              content={(close) => (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item lc-menu-icon"
                  onClick={() => {
                    close()
                    file.current?.click()
                  }}
                >
                  <Icon name="paperclip" size={16} />
                  Joindre un fichier ou une image
                </button>
              )}
            >
              <Icon name="plus" size={18} />
            </MenuButton>
            <MenuButton
              label="Commandes et skills"
              menuClass="lc-commands"
              disabled={!templates.length}
              content={(close) =>
                templates.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    role="menuitem"
                    className="menu-item lc-command-item"
                    onClick={() => {
                      close()
                      insertCommand(t.name)
                    }}
                  >
                    <span className="ellipsis">/{t.name}</span>
                    {t.description && <span className="legend">{summaryOf(t.description)}</span>}
                  </button>
                ))
              }
            >
              <Icon name="slash" size={18} />
            </MenuButton>
            <select className="lc-select" aria-label="Modèle" value={model ?? DEFAULT} onChange={(e) => void changeModel(e.target.value)}>
              {modelOptions(models).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className="lc-select"
              aria-label="Effort"
              value={effort ?? DEFAULT}
              disabled={effortChoices.length < 2}
              onChange={(e) => changeEffort(e.target.value)}
            >
              {effortChoices.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="grow" />
            <select
              className="lc-select"
              aria-label="Mode de permission"
              title={modeOf(mode)?.hint}
              value={mode}
              onChange={(e) => changeMode(e.target.value)}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`icon-btn lc-send${stopping || canSend ? ' ready' : ''}`}
              aria-label={stopping ? 'Interrompre Claude' : 'Envoyer le message'}
              disabled={pending.length > 0 || (!stopping && (busy || !canSend))}
              onClick={submit}
            >
              <Icon name={stopping ? 'stop' : 'send'} size={18} />
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
