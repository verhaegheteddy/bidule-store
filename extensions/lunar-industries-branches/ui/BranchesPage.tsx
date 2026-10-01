import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { navigate, react, useHint, useMascot, useOn, type Board } from '@bidule/sdk'
import type { Job, Links, Listing } from '../contract.ts'
import { api, board as readBoard, errorMessage } from './api.ts'
import { confirm, type Ask } from './confirm.tsx'
import { hintOf, relTime, reposOf, type RepoView, type Row } from './steps.ts'
import { TaskPicker } from './TaskPicker.tsx'

// Kept across visits while the app runs (Simon's KeptSignal): the merged branches shown, the branch picked last.
let keptShowMerged = false
let keptPicked: string | null = null

type Jobs = 'loading' | { error: string } | Job[]
type Menu = { x: number; y: number } & ({ kind: 'copy'; name: string } | { kind: 'jobs'; row: Row })

const open = (url: string | null) => url && window.open(url, '_blank', 'noreferrer')

/**
 * Taken from quack-board (Simon's pages/branches): the branches by repo on the left, each with the step it is at;
 * the one chosen on the right, with its task, its steps, the one thing to do now and the forge's other actions. Every
 * write on the forge is confirmed first.
 */
export function BranchesPage() {
  const [listing, setListing] = useState<Listing | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showMerged, setShowMerged] = useState(keptShowMerged)
  const [picked, setPicked] = useState<string | null>(keptPicked)
  const [links, setLinks] = useState<Links | null>(null)
  const [jobs, setJobs] = useState<Jobs>('loading')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const { mascot } = useMascot()

  const reload = () => {
    api.list().then(
      (l) => {
        setListing(l)
        setError(null)
      },
      (err) => setError(errorMessage(err)),
    )
    void readBoard().then(setBoard)
  }
  useEffect(reload, [])
  useOn('git.changed', reload)
  useOn('git.reviewed', reload)
  useOn('tasks.changed', reload)
  useOn('lunar-industries-branches.changed', reload)

  const tasks = board?.tasks ?? []
  const done = useMemo(() => new Set((board?.columns ?? []).filter((c) => c.group === 'done').map((c) => c.name)), [board])
  const repos = useMemo(() => (listing ? reposOf(listing, tasks, showMerged) : []), [listing, tasks, showMerged])
  const rows = repos.flatMap((r) => r.rows)
  const merged = repos.reduce((n, r) => n + r.merged, 0)
  // The branch shown: the one picked, while it is still listed, else the first one.
  const selectedKey = picked && rows.some((r) => r.key === picked) ? picked : (rows[0]?.key ?? null)
  const selected = (() => {
    for (const repo of repos) {
      const row = repo.rows.find((r) => r.key === selectedKey)
      if (row) return { row, repo }
    }
    return null
  })()

  const hint = listing ? hintOf(listing, mascot?.lines.tease ?? null) : null
  useHint(hint?.line ?? null, hint?.mode ?? 'listen')

  const pick = (key: string) => {
    setPicked(key)
    keptPicked = key
  }
  const toggleMerged = () => {
    setShowMerged(!showMerged)
    keptShowMerged = !showMerged
  }

  // Where its review, pipeline and issue are, read on the forge for the branch shown (and again after a change).
  const row = selected?.row ?? null
  const linkKey = row ? `${row.key}\u0000${row.reviewState}\u0000${row.ci}\u0000${row.headSha}` : null
  useEffect(() => {
    setLinks(null)
    if (!row?.forge) return
    let live = true
    api.links(row).then(
      (l) => live && setLinks(l),
      () => undefined,
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey])

  const link = async (r: Row, taskId: string | null) => {
    try {
      await api.link(r, taskId)
      if (!taskId) return react('quack', `${r.name} n'est plus liée à une tâche`, `${r.name} n'est plus liée à une tâche`)
      const t = tasks.find((x) => x.id === taskId)
      react('quack', `Coin ! ${r.name} va avec « ${t?.title ?? taskId} ».`, `${r.name} liée à ${t?.title ?? taskId}`)
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
    }
  }

  // Every write on the forge is confirmed first, then the list read again.
  const write = async (ask: Ask, call: () => Promise<unknown>, doneText: string) => {
    if (!(await confirm(ask))) return
    setBusy(true)
    try {
      await call()
      react('quack', doneText, doneText)
      reload()
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const run = (r: Row) =>
    write({ title: 'Lancer un pipeline ?', text: `Sur ${r.name}.`, confirm: 'Lancer' }, () => api.pipeline(r), `Pipeline lancé sur ${r.name}`)
  const retry = (r: Row) =>
    write(
      { title: 'Relancer les jobs en échec ?', text: `Du pipeline de ${r.name}.`, confirm: 'Relancer' },
      () => api.retry(r),
      `Pipeline relancé sur ${r.name}`,
    )
  const play = (r: Row, job: Job) =>
    write(
      { title: `Lancer ${job.name} ?`, text: `Job manuel du pipeline de ${r.name}.`, confirm: 'Lancer' },
      () => api.play(r, job.id),
      `${job.name} lancé`,
    )
  const review = (r: Row, target: string) =>
    write(
      { title: `Ouvrir une ${r.review} brouillon ?`, text: `De ${r.name} vers ${target}.`, confirm: 'Ouvrir' },
      () => api.review(r, target),
      `${r.review} ouverte pour ${r.name}`,
    )
  // The repo's target: kept for its next reviews.
  const setTarget = async (repo: string, target: string) => {
    try {
      await api.target(repo, target || null)
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
    }
  }

  const copy = async (name: string) => {
    setMenu(null)
    await navigator.clipboard.writeText(name)
    react('quack', `${name} copié`, `${name} copié`)
  }

  const showJobs = (r: Row, anchor: HTMLElement) => {
    const box = anchor.getBoundingClientRect()
    setJobs('loading')
    api.jobs(r).then(
      ({ jobs: all }) => setJobs(all.filter((j) => j.manual)),
      (err) => setJobs({ error: errorMessage(err) }),
    )
    setMenu({ x: box.left, y: box.bottom + 4, kind: 'jobs', row: r })
  }

  // The list's arrows: the next or previous branch, shown on the right.
  const onListKey = (e: KeyboardEvent) => {
    const at = rows.findIndex((r) => r.key === selectedKey)
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null
    if (to === null || !rows.length) return
    e.preventDefault()
    const next = rows[Math.max(0, Math.min(rows.length - 1, to))]
    pick(next.key)
    document.getElementById(optionId(next.key))?.scrollIntoView({ block: 'nearest' })
  }

  if (error)
    return (
      <div className="page">
        <section className="panel empty">
          <p>{error}</p>
          <p className="legend">La page Branches ne peut pas charger tes dépôts.</p>
          <div>
            <button type="button" className="btn" onClick={reload}>
              Réessayer
            </button>
          </div>
        </section>
      </div>
    )
  if (!listing) return <div className="page" />
  if (!repos.length)
    return (
      <div className="page">
        <section className="panel empty">
          <p>Je ne vois aucune branche.</p>
          <p className="legend">Vérifie le dossier des dépôts dans les Réglages.</p>
          <div>
            <button type="button" className="btn" onClick={() => navigate('/reglages/git')}>
              Aller aux Réglages
            </button>
          </div>
        </section>
      </div>
    )

  return (
    <div className="page">
      <div className="lib-branches">
        <nav className="panel lib-nav" aria-label="Branches">
          <div
            className="lib-list"
            role="listbox"
            tabIndex={0}
            aria-label="Branches"
            aria-activedescendant={selectedKey ? optionId(selectedKey) : undefined}
            onKeyDown={onListKey}
          >
            {repos.map((repo) => (
              <div key={repo.path} className="lib-group" role="group" aria-label={repo.label}>
                <span className="legend lib-group-name" aria-hidden="true">
                  {repo.label}
                </span>
                {repo.rows.map((b) => (
                  <div
                    key={b.key}
                    id={optionId(b.key)}
                    role="option"
                    aria-selected={b.key === selectedKey}
                    className="lib-option"
                    onClick={() => pick(b.key)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, kind: 'copy', name: b.name })
                    }}
                  >
                    <span className="mono lib-name">{b.name}</span>
                    <span className="lib-status">
                      <span className="lib-progress" aria-hidden="true">
                        {b.progress.map((d, i) => (
                          <span key={i} className={d ? 'done' : undefined} />
                        ))}
                      </span>
                      <span className={b.step === 'task' ? 'lib-to-do' : undefined}>{b.status}</span>
                    </span>
                  </div>
                ))}
                {!repo.rows.length && (
                  <span className="muted lib-none">{repo.count ? 'Seulement des branches fusionnées.' : 'Aucune branche de travail.'}</span>
                )}
              </div>
            ))}
          </div>
          {merged > 0 && (
            <button type="button" className="chip-btn lib-merged" aria-expanded={showMerged} onClick={toggleMerged}>
              {showMerged ? 'Masquer' : 'Voir'} les fusionnées ({merged})
            </button>
          )}
        </nav>

        {selected && (
          <Detail
            row={selected.row}
            repo={selected.repo}
            links={links}
            busy={busy}
            tasks={tasks}
            done={done}
            branches={listing.branches}
            link={(id) => void link(selected.row, id)}
            run={() => void run(selected.row)}
            retry={() => void retry(selected.row)}
            review={(t) => void review(selected.row, t)}
            setTarget={(t) => void setTarget(selected.repo.path, t)}
            showJobs={(el) => showJobs(selected.row, el)}
          />
        )}
      </div>
      {menu && (
        <Floating x={menu.x} y={menu.y} close={() => setMenu(null)}>
          {menu.kind === 'copy' ? (
            <button type="button" role="menuitem" className="menu-item" onClick={() => void copy(menu.name)}>
              Copier le nom
            </button>
          ) : (
            <JobsList
              row={menu.row}
              jobs={jobs}
              play={(j) => {
                setMenu(null)
                void play(menu.row, j)
              }}
            />
          )}
        </Floating>
      )}
    </div>
  )
}

const optionId = (key: string) => `lib-${key.replace(/[^\w-]/g, '_')}`

function Detail({
  row: r,
  repo,
  links,
  busy,
  tasks,
  done,
  branches,
  link,
  run,
  retry,
  review,
  setTarget,
  showJobs,
}: {
  row: Row
  repo: RepoView
  links: Links | null
  busy: boolean
  tasks: Board['tasks']
  done: Set<string>
  branches: Listing['branches']
  link: (taskId: string | null) => void
  run: () => void
  retry: () => void
  review: (target: string) => void
  setTarget: (target: string) => void
  showJobs: (anchor: HTMLElement) => void
}) {
  const reviewUrl = links?.reviewUrl ?? null
  const pipelineUrl = links?.pipelineUrl ?? null
  return (
    <section className="panel lib-detail" aria-labelledby="lib-title">
      <header className="lib-head">
        <h2 id="lib-title" className="mono lib-title selectable">
          {r.name}
        </h2>
        <span className="legend">
          {repo.label} · {relTime(r.lastCommitAt)}
        </span>
      </header>

      {/* Always there and always the same: the task it goes with, changed by typing another one, or removed. */}
      <div className="lib-task">
        <TaskPicker label="Tâche" tasks={tasks} done={done} branches={branches} current={r.task?.title ?? ''} picked={link} />
        {r.taskId && (
          <button type="button" className="btn" onClick={() => link(null)}>
            Délier
          </button>
        )}
      </div>

      <ol className="lib-steps" aria-label="Étapes de la branche">
        {r.steps.map((st) => (
          <li key={st.id} className={`lib-step ${st.state}`} aria-current={st.state === 'current' ? 'step' : undefined}>
            <span className="lib-step-track" aria-hidden="true">
              <span className="lib-step-mark" />
            </span>
            <span className="lib-step-label">
              {st.label}
              <span className="sr-only">{st.state === 'done' ? ', faite' : st.state === 'current' ? ', en cours' : ', à venir'}</span>
            </span>
          </li>
        ))}
      </ol>

      {/* The one thing to do now, and its main action. */}
      <section className="lib-next" aria-labelledby="lib-next-title">
        <NextStep row={r} repo={repo} reviewUrl={reviewUrl} pipelineUrl={pipelineUrl} busy={busy} retry={retry} review={review} setTarget={setTarget} />
      </section>

      <div className="lib-actions">
        {reviewUrl && r.step === 'ci' && (
          <button type="button" className="btn" onClick={() => open(reviewUrl)}>
            Ouvrir la {r.review}
          </button>
        )}
        {links?.issueUrl && (
          <button type="button" className="btn" onClick={() => open(links.issueUrl)}>
            Ouvrir l'issue
          </button>
        )}
        {pipelineUrl && r.step !== 'ci' && (
          <button type="button" className="btn" onClick={() => open(pipelineUrl)}>
            Ouvrir le pipeline
          </button>
        )}
        {r.forge && (
          <button type="button" className="btn" disabled={busy} onClick={run}>
            Lancer un pipeline
          </button>
        )}
        {pipelineUrl && (
          <button type="button" className="btn" aria-haspopup="menu" onClick={(e) => showJobs(e.currentTarget)}>
            Jobs manuels
          </button>
        )}
      </div>
    </section>
  )
}

function NextStep({
  row: r,
  repo,
  reviewUrl,
  pipelineUrl,
  busy,
  retry,
  review,
  setTarget,
}: {
  row: Row
  repo: RepoView
  reviewUrl: string | null
  pipelineUrl: string | null
  busy: boolean
  retry: () => void
  review: (target: string) => void
  setTarget: (target: string) => void
}) {
  const text = (title: string, legend: string) => (
    <div className="lib-next-text">
      <h3 id="lib-next-title">{title}</h3>
      <span className="legend">{legend}</span>
    </div>
  )
  const openReview = (cta = false) => (
    <div className="lib-next-actions">
      <button type="button" className={cta ? 'btn-cta' : 'btn'} disabled={!reviewUrl} onClick={() => open(reviewUrl)}>
        Ouvrir la {r.review}
      </button>
    </div>
  )
  switch (r.step) {
    case 'task':
      return text('Lier à une tâche', 'Choisis-la dans le champ Tâche ci-dessus : son temps comptera pour elle dans Temps.')
    case 'review':
      if (!r.forge) return text("Revue hors de l'app", "Ce dépôt n'est ni sur GitHub ni sur GitLab (ou sa forge n'a pas de jeton) : pas de revue ni de CI ici.")
      if (r.reviewState === 'closed')
        return (
          <>
            {text(`${r.reviewLabel ?? r.review} fermée sans fusion`, 'Rouvre-la sur la forge pour reprendre la revue.')}
            {openReview()}
          </>
        )
      return (
        <>
          {text(`Ouvrir une ${r.review} brouillon`, 'Vers la branche choisie, retenue pour ce dépôt.')}
          <div className="lib-next-actions">
            {repo.targets.length ? (
              <>
                <span className="legend">vers</span>
                <select
                  className="lib-target"
                  aria-label={`Branche cible de la ${r.review}`}
                  value={repo.target ?? ''}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">à choisir</option>
                  {repo.targets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <span className="grow" />
                <button type="button" className="btn-cta" disabled={!repo.target || busy} onClick={() => repo.target && review(repo.target)}>
                  Ouvrir la {r.review}
                </button>
              </>
            ) : (
              <span className="legend">Aucune branche cible trouvée dans ce dépôt.</span>
            )}
          </div>
        </>
      )
    case 'ci':
      return (
        <>
          {text(
            r.ci === 'fail' ? 'Pipeline en échec' : 'Pipeline en cours',
            r.ci === 'fail' ? `La ${r.review} attend une CI qui passe.` : 'La page suit son avancement.',
          )}
          <div className="lib-next-actions">
            <button type="button" className="btn" disabled={!pipelineUrl} onClick={() => open(pipelineUrl)}>
              Ouvrir le pipeline
            </button>
            {r.ci === 'fail' && (
              <button type="button" className="btn-cta" disabled={busy} onClick={retry}>
                Relancer les jobs en échec
              </button>
            )}
          </div>
        </>
      )
    case 'merge':
      return (
        <>
          {text('Prête à fusionner', `${r.reviewLabel ?? r.review} : la fusion se fait sur la forge.`)}
          {openReview(true)}
        </>
      )
    default:
      return (
        <>
          {text('Fusionnée', `${r.reviewLabel ?? r.review} est fusionnée.`)}
          {openReview()}
        </>
      )
  }
}

function JobsList({ row: r, jobs, play }: { row: Row; jobs: Jobs; play: (job: Job) => void }) {
  if (jobs === 'loading') return <span className="menu-item muted">Lecture des jobs…</span>
  if (!Array.isArray(jobs)) return <span className="menu-item muted">{jobs.error}</span>
  if (!jobs.length) return <span className="menu-item muted">Aucun job manuel sur le pipeline de {r.name}</span>
  return (
    <>
      {jobs.map((j) => (
        <button key={j.id} type="button" role="menuitem" className="menu-item" onClick={() => play(j)}>
          {j.stage ? `${j.stage} · ` : ''}
          {j.name}
        </button>
      ))}
    </>
  )
}

// A menu where it was asked (right click, a button), kept inside the window; a click elsewhere or Escape closes it.
function Floating({ x, y, close, children }: { x: number; y: number; close: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button')?.focus()
    const away = (e: Event) => !box.current?.contains(e.target as Node) && close()
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && close()
    addEventListener('mousedown', away)
    addEventListener('keydown', esc)
    return () => {
      removeEventListener('mousedown', away)
      removeEventListener('keydown', esc)
    }
  }, [close])
  return (
    <div ref={box} className="menu floating" role="menu" style={{ left: Math.min(x, innerWidth - 280), top: Math.min(y, innerHeight - 200) }}>
      {children}
    </div>
  )
}
