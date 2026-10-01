import { useEffect, useState, type CSSProperties } from 'react'
import { navigate, react, useHint, useMascotClearance } from '@bidule/sdk'
import type { ClaudePlace, SessionStatus } from '../contract.ts'
import { api, errorMessage } from './api.ts'
import { Conversation } from './Conversation.tsx'
import { relTime } from './events.ts'
import { Icon } from './Icon.tsx'
import { FloatingMenu } from './Menu.tsx'
import { openNewSession } from './newSession.tsx'
import { SessionContext } from './SessionContext.tsx'
import {
  followSessions,
  refreshSessions,
  repoLabel,
  select,
  useBoard,
  useEnabled,
  useRepos,
  useSelected,
  useSessions,
} from './state.ts'
import './claude.css'

// The list's groups: the one thing it has to surface is a session held up by a decision, the same one the tab counts.
// The rest sits together: a session of the terminal comes and goes without this app having anything to do about it.
const GROUPS: { label: string; statuses: SessionStatus[] }[] = [
  { label: 'En attente de vous', statuses: ['waiting'] },
  { label: 'Sessions', statuses: ['running', 'idle', 'saved'] },
]

// Kept across visits while the app runs: the columns folded or not, focus, the archived shown.
const kept = { left: true, right: true, focus: false, archived: false }

/**
 * Lunar Industries - Claude (Simon's pages/claude): Claude Code sessions run in the app. The list on the left
 * (grouped by state), the conversation, the session's context on the right. Each side column folds into a strip;
 * « Focus » (Ctrl + .) folds both. Off until the experimental switch of its settings is on.
 */
export function ClaudePage() {
  const enabled = useEnabled()
  useMascotClearance(96)
  if (enabled === null) return <div className="page fill" />
  if (!enabled) return <Disabled />
  return <Sessions />
}

function Disabled() {
  useHint('Les sessions Claude dans l’app sont éteintes. Coin.')
  return (
    <div className="page">
      <section className="panel lc-off">
        <h2>Sessions Claude dans l’app</h2>
        <p className="muted">
          Ce module pilote Claude Code depuis l’application avec l’Agent SDK et ton compte Claude. Anthropic n’a pas
          explicitement approuvé cet usage d’un abonnement par une application tierce : il est éteint tant que tu ne
          l’allumes pas dans ses réglages.
        </p>
        <div className="row">
          <button type="button" className="btn-cta" onClick={() => navigate('/reglages/lunar-industries-claude')}>
            Ouvrir les réglages
          </button>
        </div>
      </section>
    </div>
  )
}

function Sessions() {
  const list = useSessions()
  const repos = useRepos()
  const board = useBoard()
  const selectedId = useSelected()
  const [search, setSearch] = useState('')
  const [left, setLeft] = useState(kept.left)
  const [right, setRight] = useState(kept.right)
  const [focus, setFocus] = useState(kept.focus)
  const [archived, setArchived] = useState(kept.archived)
  const [menu, setMenu] = useState<{ at: CSSProperties; id: string } | null>(null)
  useEffect(() => {
    Object.assign(kept, { left, right, focus, archived })
  }, [left, right, focus, archived])

  useEffect(followSessions, [])

  // ?session=<id> (a notification), ?task=<id> (the Kanban): that session, or a new one from that task.
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const session = q.get('session')
    const task = q.get('task')
    if (session === null && task === null) return
    history.replaceState(null, '', location.pathname)
    if (session) select(session)
    if (task !== null) void newSession(task || null)
  }, [])

  // Ctrl + . : focus, in or out.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      if (e.key !== '.' && e.code !== 'Period') return
      e.preventDefault()
      setFocus((f) => !f)
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])

  const tasks = board?.tasks ?? []
  const all = (list ?? []).map((s) => {
    const known = tasks.find((t) => t.id === s.taskId)
    const task = s.task ?? (known ? { ref: known.ref, title: known.title } : null)
    const labels = s.repos.map((p) => repoLabel(repos, p))
    return {
      ...s,
      task,
      labels,
      // No status here: only a decision awaited is worth naming, and the group already says it.
      meta: [task?.ref ?? (s.fromApp ? 'Sans tâche' : 'Terminal ou VS Code'), labels.join(', ')].filter(Boolean).join(' · '),
    }
  })
  const words = search.trim().toLowerCase()
  const visible = all.filter(
    (s) => !words || [s.title, s.task?.title, s.task?.ref, ...s.labels].some((v) => v?.toLowerCase().includes(words)),
  )
  const archivedCount = visible.filter((s) => s.archived).length
  const shown = visible.filter((s) => !s.archived || archived)
  const groups = [
    ...GROUPS.map((g) => ({ label: g.label, items: visible.filter((s) => !s.archived && g.statuses.includes(s.status)) })),
    { label: 'Archivées', items: archived ? visible.filter((s) => s.archived) : [] },
  ].filter((g) => g.items.length)
  const current = all.find((s) => s.id === selectedId) ?? all.find((s) => !s.archived) ?? null
  const waiting = all.filter((s) => !s.archived && s.status === 'waiting').length

  useHint(
    list === null
      ? null
      : waiting
        ? `${waiting} session${waiting > 1 ? 's attendent' : ' attend'} ta décision. Coin !`
        : all.length
          ? 'Claude bosse, je surveille. Coin.'
          : null,
  )

  const leftOpen = left && !focus
  const rightOpen = right && !focus
  // Folding or unfolding a column by hand leaves focus: the two would otherwise fight over the same space.
  const fold = (side: 'left' | 'right', open: boolean) => {
    setFocus(false)
    if (side === 'left') setLeft(open)
    else setRight(open)
  }

  async function newSession(taskId: string | null = null) {
    const id = await openNewSession({ taskId })
    if (!id) return
    select(id)
    refreshSessions()
  }

  // Only a stopped session is archived; archiving it again takes it back out.
  const archive = async (id: string, value: boolean) => {
    try {
      await api.archive(id, value)
      refreshSessions()
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
    }
  }

  // Nothing at all to show, sessions of the terminal included: the first visit.
  if (list !== null && !all.length) return <FirstVisit start={(id) => void newSession(id)} />

  const menuSession = menu && all.find((s) => s.id === menu.id)

  return (
    <div className={`page fill lc-page${focus ? ' focus' : ''}`}>
      {leftOpen ? (
        <section className="panel lc-list" aria-label="Sessions">
          <div className="row">
            <h2 className="grow">Sessions</h2>
            <button type="button" className="btn lc-btn-sm" onClick={() => void newSession()}>
              Nouvelle
            </button>
            <button type="button" className="icon-btn lc-icon-sm" aria-label="Réduire la liste des sessions" onClick={() => fold('left', false)}>
              <Icon name="left" size={16} />
            </button>
          </div>
          <label className="lc-search">
            <span className="sr-only">Chercher une session</span>
            <input type="search" placeholder="Chercher une session ou une tâche" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <div className="lc-groups" role="listbox" aria-label="Sessions">
            {groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label} className="lc-group">
                <div className="legend lc-group-title" aria-hidden="true">
                  {g.label}
                </div>
                {g.items.map((s) => (
                  <div
                    key={s.id}
                    role="option"
                    tabIndex={0}
                    aria-selected={current?.id === s.id}
                    className="lc-item"
                    data-status={s.status}
                    onClick={() => select(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        select(s.id)
                      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        const items = [...(e.currentTarget.closest('.lc-groups')?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
                        const at = items.indexOf(e.currentTarget)
                        const next = items[at + (e.key === 'ArrowDown' ? 1 : -1)]
                        next?.focus()
                        next?.click()
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ at: { left: e.clientX, top: e.clientY }, id: s.id })
                    }}
                  >
                    <span className="lc-item-text grow">
                      <strong className="ellipsis">{s.task?.title ?? s.title}</strong>
                      <span className="legend ellipsis">{s.meta}</span>
                    </span>
                    <span className="legend lc-when">{relTime(s.updatedAt)}</span>
                  </div>
                ))}
              </div>
            ))}
            {!groups.length && <span className="legend">{list === null ? 'Lecture des sessions…' : 'Aucune session ne correspond.'}</span>}
          </div>
          {archivedCount > 0 && (
            <button type="button" className="chip-btn lc-archived" aria-pressed={archived} onClick={() => setArchived(!archived)}>
              {archived ? 'Masquer' : 'Afficher'} les archivées ({archivedCount})
            </button>
          )}
        </section>
      ) : (
        !focus && (
          <nav className="panel lc-rail" aria-label="Sessions, réduites">
            <button type="button" className="icon-btn lc-icon-sm" aria-label="Afficher la liste des sessions" onClick={() => fold('left', true)}>
              <Icon name="right" size={16} />
            </button>
            <button type="button" className="icon-btn lc-icon-sm" aria-label="Nouvelle session" onClick={() => void newSession()}>
              <Icon name="plus" size={16} />
            </button>
            {shown.map((s) => (
              <button
                key={s.id}
                type="button"
                className="lc-rail-item"
                aria-pressed={current?.id === s.id}
                aria-label={s.task?.title ?? s.title}
                title={s.task?.title ?? s.title}
                onClick={() => select(s.id)}
              >
                <span className="lc-dot" data-status={s.status} />
              </button>
            ))}
          </nav>
        )
      )}

      {current ? (
        <>
          <Conversation
            session={current}
            heading={current.task?.title ?? current.title}
            taskRef={current.task?.ref ?? null}
            repoLabels={current.labels}
            focus={focus}
            toggleFocus={() => setFocus(!focus)}
          />
          {rightOpen ? (
            <SessionContext sessionId={current.id} cwd={current.cwd} collapse={() => fold('right', false)} />
          ) : (
            !focus && (
              <nav className="panel lc-rail" aria-label="Contexte, réduit">
                <button type="button" className="icon-btn lc-icon-sm" aria-label="Afficher le contexte" onClick={() => fold('right', true)}>
                  <Icon name="left" size={16} />
                </button>
              </nav>
            )
          )}
        </>
      ) : (
        <section className="panel lc-none">
          <p className="legend">{list === null ? 'Lecture des sessions…' : 'Aucune session à afficher.'}</p>
          <button type="button" className="btn" onClick={() => void newSession()}>
            Nouvelle session
          </button>
        </section>
      )}

      {menu && menuSession && (
        <FloatingMenu at={menu.at} label={`Session ${menuSession.title}`} onClose={() => setMenu(null)}>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            aria-disabled={menuSession.fromApp && menuSession.status !== 'saved'}
            title={menuSession.fromApp && menuSession.status !== 'saved' ? 'Arrêtez la session pour l’archiver' : undefined}
            onClick={() => {
              setMenu(null)
              void archive(menuSession.id, !menuSession.archived)
            }}
          >
            {menuSession.archived ? 'Désarchiver' : 'Archiver'}
          </button>
        </FloatingMenu>
      )}
    </div>
  )
}

// First visit: what is needed (the Claude Code found), and the tasks in progress to start from.
function FirstVisit({ start }: { start: (taskId: string | null) => void }) {
  const board = useBoard()
  const [places, setPlaces] = useState<ClaudePlace[] | null>(null)
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try {
      setPlaces((await api.status()).places)
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
      setPlaces([])
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => void check(), [])
  useHint('Aucune session Claude pour l’instant. On en lance une ? Coin.')

  const doing = new Set((board?.columns ?? []).filter((c) => c.group === 'doing').map((c) => c.name))
  const inProgress = (board?.tasks ?? []).filter((t) => doing.has(t.status)).slice(0, 5)

  return (
    <div className="page lc-empty">
      <section className="empty lc-empty-head">
        <p>Aucune session Claude pour l’instant</p>
        <p className="legend">
          Lancez une session depuis une tâche en cours : Claude reçoit la tâche en contexte et travaille dans des worktrees
          à part.
        </p>
        <button type="button" className="btn-cta" onClick={() => start(null)}>
          Nouvelle session
        </button>
      </section>
      <div className="lc-empty-grid">
        <section className="panel" aria-labelledby="lc-checks">
          <h2 id="lc-checks">Vérifications</h2>
          <Places places={places} checking={checking} />
          <div className="row">
            <button type="button" className="btn lc-btn-sm" disabled={checking} onClick={() => void check()}>
              Vérifier à nouveau
            </button>
            <button type="button" className="btn lc-btn-sm" onClick={() => navigate('/reglages/lunar-industries-claude')}>
              Réglages de Claude
            </button>
          </div>
        </section>
        <section className="panel" aria-labelledby="lc-tasks">
          <h2 id="lc-tasks">Tâches en cours</h2>
          {inProgress.length ? (
            inProgress.map((t) => (
              <div key={t.id} className="trow row lc-task">
                <span className="lc-check-text grow">
                  <strong className="ellipsis">{t.title}</strong>
                  <span className="legend">{t.ref ?? ''}</span>
                </span>
                <button type="button" className="btn lc-btn-sm" onClick={() => start(t.id)}>
                  Lancer
                </button>
              </div>
            ))
          ) : (
            <span className="legend">Aucune tâche en cours sur le Kanban.</span>
          )}
        </section>
      </div>
    </div>
  )
}

// The Claude Code the sessions run (this machine's, WSL's), and whether it is logged in.
export function Places({ places, checking }: { places: ClaudePlace[] | null; checking: boolean }) {
  if (!places?.length) return <span className="legend">{checking || !places ? 'Recherche de Claude Code…' : 'Aucun Claude Code trouvé.'}</span>
  return (
    <>
      {places.map((p) => (
        <div key={p.where} className="lc-check">
          <span className={`tag lc-tone-${p.error ? 'bad' : p.loggedIn ? 'ok' : 'warn'}`}>
            {p.error ? 'introuvable' : p.loggedIn ? 'prêt' : 'à connecter'}
          </span>
          <span className="lc-check-text">
            <strong>Claude Code {p.where === 'Ce poste' ? 'sur ce poste' : `dans ${p.where}`}</strong>
            <span className="legend">
              {p.error ??
                (p.loggedIn
                  ? [`Version ${p.version ?? '?'}`, p.email, p.subscription].filter(Boolean).join(' · ')
                  : 'Dans un terminal, lancez « claude » puis « /login », une seule fois.')}
            </span>
          </span>
        </div>
      ))}
    </>
  )
}
