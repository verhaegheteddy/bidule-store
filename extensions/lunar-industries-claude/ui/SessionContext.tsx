import { useEffect, useRef, useState } from 'react'
import { react, useOn } from '@bidule/sdk'
import type { SessionContext as Context } from '../contract.ts'
import { api, errorMessage } from './api.ts'
import { cost, tokens } from './events.ts'
import { Icon } from './Icon.tsx'
import { refreshSessions, useBoard } from './state.ts'
import { TaskSelect } from './TaskSelect.tsx'

// Kept across visits while the app runs: coming back, the panel shows what it had while it reads again.
const kept = new Map<string, Context>()

/**
 * Beside the conversation (Simon's session-context): the session's task, its worktrees and the files they change,
 * the executable slot, where Claude Code runs, what it cost. Read again when the session changes state or a tool
 * has answered.
 */
export function SessionContext({ sessionId, cwd, collapse }: { sessionId: string; cwd: string; collapse: () => void }) {
  const [context, setContext] = useState<Context | null>(kept.get(sessionId) ?? null)
  const [busy, setBusy] = useState(false)
  // The task list, open only while the user is changing the task of a session that has one.
  const [picking, setPicking] = useState(false)
  const tasks = useBoard()?.tasks ?? []
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const load = () =>
    api.context(sessionId, cwd || undefined).then(
      (c) => {
        kept.set(sessionId, c)
        setContext(c)
      },
      () => undefined,
    )
  useEffect(() => {
    setContext(kept.get(sessionId) ?? null)
    setPicking(false)
    void load()
    return () => clearTimeout(timer.current)
    // Read again for another session only.
  }, [sessionId, cwd])

  // Several changes in a row make one read.
  useOn('lunar-industries-claude.session', ({ id, message }) => {
    if (id !== sessionId) return
    if (message.type === 'status' || (message.type === 'event' && message.event.kind === 'tool_result')) {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void load(), 500)
    }
  })

  const copy = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      react('quack', 'Chemin copié, coin !', 'Chemin copié')
    } catch {
      react('panic', 'Impossible de copier', 'Impossible de copier')
    }
  }

  // A session of the terminal has no row of its own: the API is told its folder, without which it cannot find its
  // transcript.
  const attach = async (taskId: string | null) => {
    if (busy) return
    setBusy(true)
    try {
      await api.task(sessionId, taskId, cwd || context?.cwd)
      setPicking(false)
      await load()
      refreshSessions()
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const c = context
  const files = (c?.worktrees ?? []).flatMap((w) => w.files.map((f) => ({ ...f, repo: w.repo })))
  const usage = c?.usage ?? []
  const totals = usage.reduce(
    (t, u) => ({
      input: t.input + u.input,
      output: t.output + u.output,
      cacheRead: t.cacheRead + u.cacheRead,
      cacheWrite: t.cacheWrite + u.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
  // Claude Code found no price for one of the models: its dollars are its own guess, said as such.
  const guessed = usage.some((u) => u.basis === 'unknown')
  // Figures from the session's turns carry dollars; read back from the transcript they do not.
  const priced = usage.some((u) => u.costUsd !== null)

  return (
    <aside className="lc-context" aria-label="Contexte de la session">
      <section className="panel lc-ctx-panel" aria-labelledby="lc-ctx-task">
        <div className="row">
          <h2 id="lc-ctx-task" className="grow lc-ctx-title">
            Tâche
          </h2>
          <button type="button" className="icon-btn lc-icon-sm" aria-label="Réduire le contexte" onClick={collapse}>
            <Icon name="right" size={16} />
          </button>
        </div>
        {c?.task ? (
          <>
            <strong className="lc-ctx-task">{c.task.title}</strong>
            <div className="row">
              <span className="tag lc-tone-info">{c.task.status}</span>
              {c.task.url && (
                <a className="lc-ctx-link" href={c.task.url} target="_blank" rel="noreferrer">
                  Ouvrir la tâche
                </a>
              )}
            </div>
          </>
        ) : (
          <span className="legend">Session sans tâche</span>
        )}
        {c?.task && !picking ? (
          <div className="row">
            <button type="button" className="btn lc-btn-sm" disabled={busy} onClick={() => setPicking(true)}>
              Modifier
            </button>
            <button type="button" className="btn lc-btn-sm" disabled={busy} onClick={() => void attach(null)}>
              Détacher
            </button>
          </div>
        ) : (
          <>
            <TaskSelect
              label="Rattacher à une tâche"
              tasks={tasks}
              value={c?.task?.id ?? null}
              none="Choisir une tâche…"
              disabled={busy}
              onChange={(id) => id && void attach(id)}
            />
            {c?.task && (
              <button type="button" className="btn lc-btn-sm" disabled={busy} onClick={() => setPicking(false)}>
                Annuler
              </button>
            )}
          </>
        )}
      </section>

      <section className="panel lc-ctx-panel" aria-labelledby="lc-ctx-worktrees">
        <h2 id="lc-ctx-worktrees" className="lc-ctx-title">
          Worktrees
        </h2>
        {c?.worktrees.length ? (
          c.worktrees.map((w) => (
            <div key={w.path} className="lc-ctx-worktree">
              <div className="row">
                <strong className="grow ellipsis">{w.repo ?? '?'}</strong>
                <button type="button" className="chip-btn" onClick={() => void copy(w.path)}>
                  Copier le chemin
                </button>
              </div>
              <span className="mono ellipsis lc-ctx-path" title={w.path}>
                {w.branch}
              </span>
            </div>
          ))
        ) : (
          <span className="legend">Aucun : Claude en crée un par branche quand il en a besoin.</span>
        )}
      </section>

      {files.length > 0 && (
        <section className="panel lc-ctx-panel" aria-labelledby="lc-ctx-files">
          <h2 id="lc-ctx-files" className="lc-ctx-title">
            Fichiers modifiés
          </h2>
          {files.map((f) => (
            <div key={`${f.repo}:${f.path}`} className="row lc-ctx-line">
              <span className="mono ellipsis grow" title={f.path}>
                {f.path}
              </span>
              {f.added === null ? (
                <span className="legend">nouveau</span>
              ) : (
                <>
                  <span className="mono lc-added">+{f.added}</span>
                  {f.removed ? <span className="mono lc-removed">−{f.removed}</span> : null}
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {c?.slot.length ? (
        <section className="panel lc-ctx-panel" aria-labelledby="lc-ctx-slot">
          <h2 id="lc-ctx-slot" className="lc-ctx-title">
            Créneau exécutable
          </h2>
          {c.slot.map((l) => (
            <div key={l.repo} className="row lc-ctx-line">
              <span className="grow">{l.repo}</span>
              <span className={`tag lc-tone-${l.mine ? 'ok' : l.alive ? 'warn' : 'neutral'}`}>
                {l.mine ? 'tenu par cette session' : l.alive ? l.session || 'autre session' : 'libre à reprendre'}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="panel lc-ctx-panel" aria-labelledby="lc-ctx-session">
        <h2 id="lc-ctx-session" className="lc-ctx-title">
          Session
        </h2>
        <div className="row lc-ctx-line">
          <span className="grow muted">Exécution</span>
          <strong>{c?.where ?? '—'}</strong>
        </div>
        <div className="row lc-ctx-line">
          <span className="grow muted">Connexion</span>
          <strong>{c?.login === 'subscription' ? 'Abonnement Claude' : c?.login === 'apiKey' ? 'Clé API' : '—'}</strong>
        </div>
        {c?.turns ? (
          <div className="row lc-ctx-line">
            <span className="grow muted">Tours</span>
            <strong>{c.turns}</strong>
          </div>
        ) : null}
        {c?.costUsd !== null && c?.costUsd !== undefined && (
          <div className="row lc-ctx-line">
            <span className="grow muted">Coût estimé</span>
            <strong title={guessed ? 'Claude Code n’a pas de tarif pour ce modèle : ce montant est sa propre estimation.' : undefined}>
              {cost(c.costUsd)}
              {guessed ? ' ?' : ''}
            </strong>
          </div>
        )}
      </section>

      {usage.length > 0 && (
        <section className="panel lc-ctx-panel" aria-labelledby="lc-ctx-usage">
          <h2 id="lc-ctx-usage" className="lc-ctx-title">
            Tokens
            {!priced && (
              <span
                className="legend"
                title="Relevé dans la transcription de Claude Code, qui ne garde pas les montants : cette session est antérieure à leur enregistrement, ou elle n’a pas été lancée depuis l’application."
              >
                {' '}
                · sans montant
              </span>
            )}
          </h2>
          {(
            [
              ['Entrée', totals.input],
              ['Sortie', totals.output],
              ['Cache lu', totals.cacheRead],
              ['Cache écrit', totals.cacheWrite],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="row lc-ctx-line">
              <span className="grow muted">{label}</span>
              <strong className="mono">{tokens(n)}</strong>
            </div>
          ))}
          {usage.length > 1 &&
            usage.map((u) => (
              <div key={u.model} className="row lc-ctx-line">
                <span className="grow ellipsis">{u.model}</span>
                <strong>{u.costUsd === null ? tokens(u.input + u.output) : cost(u.costUsd)}</strong>
              </div>
            ))}
        </section>
      )}
    </aside>
  )
}
