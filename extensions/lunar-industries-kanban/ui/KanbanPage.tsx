import { useEffect, useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import {
  busy,
  columnColor,
  execute,
  MascotHead,
  openDialog,
  react,
  useHint,
  useCardActions,
  useKanbanParts,
  useKanbanRevision,
  useOn,
  useSettingValues,
  useVoice,
  type Advice,
  type KanbanContext,
  type Task,
} from '@bidule/sdk'
import type { BranchRef, Branches, KanbanBranch } from '../contract.ts'
import { board as readBoard, branches as readBranches, errorMessage, moveTask, reviewUrl, setBranches, type Loaded } from './api.ts'
import { CardMenu } from './CardMenu.tsx'
import {
  badgeOf,
  branchKey,
  branchLabel,
  dayKey,
  groupsOf,
  marksOf,
  orphansOf,
  parseList,
  shortBranch,
  type Column,
  type Mark,
  type Tone,
} from './layout.ts'
import { LinkBranches } from './LinkBranches.tsx'

// Per-viewer conveniences, kept in this browser only (a private window simply starts afresh).
const TOGGLED = 'lunar-industries-kanban.toggled'
const TRAY = 'lunar-industries-kanban.trayOpen'
function saved(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage refused: the choice lasts as long as the page.
  }
}
const savedToggles = (): ReadonlySet<string> => new Set(parseList(saved(TOGGLED)))

// What a drag carries: a card (to another column) or a branch of the tray (onto a card).
const TASK_TYPE = 'application/x-lik-task'
const BRANCH_TYPE = 'application/x-lik-branch'
const carries = (e: DragEvent, type: string) => e.dataTransfer.types.includes(type)

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`
const columnLabel = (name: string) => name || 'Sans statut'

// The board, reloaded whenever the source says it changed (a sync, a move from elsewhere).
function useBoard(): [Loaded | null, (b: Loaded) => void, string | null, () => void] {
  const [board, setBoard] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = () =>
    void readBoard().then(
      (b) => {
        setBoard(b)
        setError(null)
      },
      (err) => setError(errorMessage(err)),
    )
  useEffect(reload, [])
  useOn('tasks.changed', reload)
  return [board, setBoard, error, reload]
}

// The branches, from the git role (none without it), read again whenever git reads the repos.
function useBranches(): [Branches, (b: Branches) => void] {
  const [branches, setBranches] = useState<Branches>({ available: false, branches: [] })
  const reload = () => void readBranches().then(setBranches, () => undefined)
  useEffect(reload, [])
  useOn('git.changed', reload)
  useOn('git.reviewed', reload)
  return [branches, setBranches]
}

/**
 * Taken from quack-board (Simon's Kanban): one column per status of the source, consecutive ones of a group under its
 * heading (À faire, En cours, Terminé ; the finished ones folded), the recent branches without a task to drop on a
 * card, each card's branch, due date and review or CI marks. The other extensions' parts (right-click actions,
 * badges, advice) come through the SDK like on any Kanban.
 */
export function Kanban() {
  const [board, setBoard, error, reload] = useBoard()
  const [git, setGit] = useBranches()
  const values = useSettingValues()
  const contributions = useKanbanParts()
  // The actions of the card whose menu is open, by its task's group (an extension may offer some only on tasks to do).
  const actionsFor = useCardActions(contributions.actions)
  useKanbanRevision()
  const [toggled, setToggled] = useState(savedToggles)
  const [trayOpen, setTrayOpen] = useState(() => saved(TRAY) !== 'false')
  const [over, setOver] = useState<string | null>(null)
  const [branchOver, setBranchOver] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ task: Task; x: number; y: number } | null>(null)

  const hidden = parseList(values?.['lunar-industries-kanban.hidden'])
  const ready = board && board.source !== null ? board : null
  const groups = useMemo(
    () => (ready ? groupsOf(ready, hidden, toggled) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, hidden.join('\n'), toggled],
  )
  const columns = groups.flatMap((g) => g.columns)
  const byTask = useMemo(() => {
    const map = new Map<string, KanbanBranch[]>()
    for (const b of git.branches) if (b.taskId) map.set(b.taskId, [...(map.get(b.taskId) ?? []), b])
    return map
  }, [git])
  const orphans = orphansOf(git.branches)
  const today = dayKey(new Date())
  const doneStatus = new Set(ready?.columns.filter((c) => c.group === 'done').map((c) => c.name) ?? [])

  const toggleFold = (name: string) => {
    const next = new Set(toggled)
    if (!next.delete(name)) next.add(name)
    setToggled(next)
    keep(TOGGLED, JSON.stringify([...next]))
  }
  const toggleTray = () => {
    setTrayOpen(!trayOpen)
    keep(TRAY, String(!trayOpen))
  }

  // Optimistic: the card jumps to its new column at once; a failure snaps it back.
  const move = async (task: Task, status: string) => {
    if (!ready || task.status === status) return
    const previous = ready
    setBoard({ ...ready, tasks: ready.tasks.map((t) => (t.id === task.id ? { ...t, status } : t)) })
    try {
      const next = await busy(moveTask(task.id, status))
      setBoard(next)
      const done = next.columns.find((c) => c.name === status)?.group === 'done'
      const name = task.ref ?? task.title
      react(
        'quack',
        done ? `Coin coin ! ${name} est terminée !` : `${name} passe en ${columnLabel(status)}, coin !`,
        `${task.title} → ${columnLabel(status)} dans ${next.source}`,
      )
    } catch (err) {
      setBoard(previous)
      react('panic', errorMessage(err), errorMessage(err))
    }
  }

  const saveBranches = async (task: Task, refs: BranchRef[]) => {
    try {
      setGit(await busy(setBranches(task.id, refs)))
      react('quack', `Branches de « ${task.title} » enregistrées. Coin !`, `Branches de « ${task.title} » enregistrées`)
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
      throw err
    }
  }
  const titleOf = (id: string) => ready?.tasks.find((t) => t.id === id)?.title ?? 'une autre tâche'
  const chooseBranches = (task: Task) =>
    openDialog((close) => (
      <LinkBranches
        title={task.title}
        taskId={task.id}
        branches={git.branches}
        titleOf={titleOf}
        save={(refs) => saveBranches(task, refs)}
        close={close}
      />
    ))

  const openMark = async (e: MouseEvent, mark: Mark) => {
    e.stopPropagation()
    try {
      const { url } = await reviewUrl({ repo: mark.repo, name: mark.name })
      if (url) window.open(url, '_blank', 'noopener')
      else react('quack', 'Je ne trouve ni la revue ni le pipeline de cette branche. Coin.')
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
    }
  }

  const adviceOf = (task: Task): Advice | null => {
    if (!ready) return null
    const ctx: KanbanContext = {
      columns: ready.columns,
      staleDays: Number(values?.['kanban.staleDays'] ?? 5),
      move: (status) => move(task, status),
      settings: values ?? {},
    }
    const all = contributions.parts.flatMap(({ kanban }) => {
      const advice = kanban.advice?.(task, ctx)
      return advice ? [advice] : []
    })
    return all.sort((a, b) => a.priority - b.priority)[0] ?? null
  }

  const doing = ready?.tasks.filter((t) => ready.columns.find((c) => c.name === t.status)?.group === 'doing') ?? []
  const due = ready?.tasks.find((t) => !doneStatus.has(t.status) && t.due?.slice(0, 10) === today)
  useHint(
    !board
      ? null
      : board.source === null
        ? 'Il me faut une source de tâches : une extension comme Notion. Coin.'
        : !board.configured
          ? `Branche-moi à ${board.source} dans les Réglages, que je voie tes tâches.`
          : due
            ? `${due.ref ?? due.title} est à rendre aujourd'hui. On s'y met ?`
            : `${plural(doing.length, 'tâche')} en cours. Laquelle on avance ?`,
  )

  const openMenu = (task: Task, x: number, y: number) => setMenu({ task, x, y })
  const dropOnColumn = (column: Column) => ({
    onDragOver: (e: DragEvent) => {
      if (!carries(e, TASK_TYPE)) return
      e.preventDefault()
      setOver(column.name)
    },
    onDragLeave: () => setOver((o) => (o === column.name ? null : o)),
    onDrop: (e: DragEvent) => {
      setOver(null)
      if (!carries(e, TASK_TYPE)) return
      e.preventDefault()
      const task = ready?.tasks.find((t) => t.id === e.dataTransfer.getData(TASK_TYPE))
      if (task) void move(task, column.name)
    },
  })
  const dropOnCard = (task: Task) => ({
    onDragOver: (e: DragEvent) => {
      if (!carries(e, BRANCH_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'link'
      setBranchOver(task.id)
    },
    onDragLeave: () => setBranchOver((o) => (o === task.id ? null : o)),
    onDrop: (e: DragEvent) => {
      setBranchOver(null)
      if (!carries(e, BRANCH_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      const branch = git.branches.find((b) => branchKey(b) === e.dataTransfer.getData(BRANCH_TYPE))
      if (!branch) return
      const refs = [...(byTask.get(task.id) ?? []), branch].map(({ repo, name }) => ({ repo, name }))
      void saveBranches(task, refs).catch(() => undefined)
    },
  })

  if (error && !board) {
    return (
      <div className="page">
        <div className="empty">
          Le Kanban ne peut pas charger tes tâches : {error}
          <p>
            <button type="button" className="btn" onClick={reload}>
              Réessayer
            </button>
          </p>
        </div>
      </div>
    )
  }
  if (!board) return <div className="page" />
  if (board.source === null || !board.configured || !board.tasks.length) {
    return (
      <div className="page">
        <div className="empty">
          {board.source === null
            ? 'Aucune source de tâches : installe une extension comme Notion.'
            : !board.configured
              ? `Branche ${board.source} dans les Réglages pour voir tes tâches.`
              : `Aucune tâche ${board.source} où tu es responsable ou participant.`}
          {board.source !== null && board.configured && (
            <p>
              <button type="button" className="btn" onClick={() => void busy(execute('notion.sync' as never, undefined as never))}>
                Synchroniser
              </button>
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="page lik-page">
      {orphans.length > 0 && (
        <section className="lik-tray" aria-labelledby="lik-tray-title">
          <button type="button" className="lik-tray-toggle" aria-expanded={trayOpen} onClick={toggleTray}>
            <h2 id="lik-tray-title" className="legend">
              Branches récentes sans tâche
            </h2>
            <span className="pill-count">{orphans.length}</span>
          </button>
          {trayOpen && (
            <>
              <span className="legend">Glisse-en une sur une tâche pour l’y lier.</span>
              <div className="lik-orphans">
                {orphans.map((b) => (
                  <span
                    key={branchKey(b)}
                    className="lik-orphan"
                    draggable
                    title={`${b.repoLabel} · ${b.name}`}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(BRANCH_TYPE, branchKey(b))
                      e.dataTransfer.setData('text/plain', b.name)
                      e.dataTransfer.effectAllowed = 'link'
                    }}
                    onDragEnd={() => setBranchOver(null)}
                  >
                    {shortBranch(b.name)}
                  </span>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <div className="lik-board">
        {groups.map((g) => (
          <div key={g.key} className="lik-group" role="group" aria-label={g.label || columnLabel(g.columns[0].name)} style={{ flexGrow: g.grow }}>
            {g.label && <div className="lik-group-head">{g.label}</div>}
            <div className="lik-group-columns">
              {g.columns.map((col) => (
                <section
                  key={col.name}
                  className={`lik-column${col.folded ? ' folded' : ''}${over === col.name ? ' drop-over' : ''}`}
                  aria-label={columnLabel(col.name)}
                  {...dropOnColumn(col)}
                >
                  {col.foldable ? (
                    <button type="button" className="lik-column-head lik-column-toggle" aria-expanded={!col.folded} onClick={() => toggleFold(col.name)}>
                      <span className="dot" style={{ background: columnColor(col) }} />
                      <h2 className="ellipsis">{columnLabel(col.name)}</h2>
                      <span className="pill-count">{col.tasks.length}</span>
                    </button>
                  ) : (
                    <div className="lik-column-head">
                      <span className="dot" style={{ background: columnColor(col) }} />
                      <h2 className="ellipsis">{columnLabel(col.name)}</h2>
                      {col.unknown && <span className="tag lik-tone-warn">absent de {board.source}</span>}
                    </div>
                  )}
                  {!col.folded &&
                    (col.tasks.length ? (
                      col.tasks.map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          done={doneStatus.has(t.status)}
                          today={today}
                          branches={byTask.get(t.id) ?? []}
                          showBranches={git.available}
                          badges={contributions.parts.map(({ id, kanban }) => (
                            <span key={id}>{kanban.badges?.(t)}</span>
                          ))}
                          advice={col.group === 'doing' ? adviceOf(t) : null}
                          branchOver={branchOver === t.id}
                          openMark={openMark}
                          openMenu={openMenu}
                          drop={dropOnCard(t)}
                        />
                      ))
                    ) : (
                      <div className="lik-drop-hint">Glisse une tâche ici</div>
                    ))}
                </section>
              ))}
            </div>
          </div>
        ))}
      </div>

      {menu && (
        <CardMenu
          {...menu}
          source={board.source}
          actions={actionsFor(board.columns.find((c) => c.name === menu.task.status)?.group ?? null)}
          link={git.available ? () => chooseBranches(menu.task) : null}
          columns={columns.map((c) => ({ name: c.name, label: columnLabel(c.name) }))}
          move={(status) => void move(menu.task, status)}
          close={() => setMenu(null)}
        />
      )}
    </div>
  )
}

const TONE_CLASS: Record<Tone, string> = {
  ok: 'lik-tone-ok',
  bad: 'lik-tone-bad',
  warn: 'lik-tone-warn',
  info: 'lik-tone-info',
  neutral: 'lik-tone-neutral',
  accent: 'lik-tone-accent',
}

function Card({
  task,
  done,
  today,
  branches,
  showBranches,
  badges,
  advice,
  branchOver,
  openMark,
  openMenu,
  drop,
}: {
  task: Task
  done: boolean
  today: string
  branches: KanbanBranch[]
  showBranches: boolean
  badges: React.ReactNode[]
  advice: Advice | null
  branchOver: boolean
  openMark: (e: MouseEvent, mark: Mark) => void
  openMenu: (task: Task, x: number, y: number) => void
  drop: Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>
}) {
  const voice = useVoice()
  const badge = badgeOf(task, done, today)
  const marks = marksOf(branches)
  const label = showBranches ? branchLabel(branches) : task.ref
  const open = () => task.url && window.open(task.url, '_blank', 'noopener')
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter') return void open()
    // The menu key, or Shift+F10: the card's menu, at the card.
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      openMenu(task, r.left + 16, r.top + 24)
    }
  }
  return (
    <article
      className={`lik-card${done ? ' done' : ''}${badge?.tone === 'accent' ? ' urgent' : ''}${branchOver ? ' branch-over' : ''}`}
      tabIndex={0}
      role="link"
      aria-label={label ? `${task.title}, ${label}` : task.title}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TASK_TYPE, task.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={(e) => !(e.target as HTMLElement).closest('button') && open()}
      onKeyDown={onKey}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu(task, e.clientX, e.clientY)
      }}
      {...drop}
    >
      <div className="row lik-card-head">
        {done && <span className="lik-done-dot" aria-hidden="true" />}
        {label && <span className="mono lik-branch ellipsis">{label}</span>}
        <span className="grow" />
        {task.role === 'participant' && <span className="cream-pill">participant</span>}
        {badge && <span className={`tag ${TONE_CLASS[badge.tone]}`}>{badge.text}</span>}
      </div>
      <div className="card-title">{task.title}</div>
      {marks.length > 0 && (
        <div className="row lik-marks">
          {marks.map((m) => (
            <button key={m.key} type="button" className={`tag lik-mark ${TONE_CLASS[m.tone]}`} title={m.tip} onClick={(e) => void openMark(e, m)}>
              {m.text}
            </button>
          ))}
        </div>
      )}
      {badges.length > 0 && <div className="row lik-badges">{badges}</div>}
      {advice && (
        <div className="advice">
          <MascotHead />
          <p>{voice(advice.text)}</p>
          {advice.action && (
            <button type="button" className="advice-btn" onClick={() => void advice.action!.run()}>
              {advice.action.label}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

