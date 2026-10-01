import { useEffect, useRef, useState } from 'react'
import { BannerTools, ToolFilter, ToolSearch, useHint, useOn } from '@bidule/sdk'
import type { ContainerList, ContainerRow } from '../contract.ts'
import { act, ContainerMenu, openTerminal, removeAll } from './actions.tsx'
import { api, message } from './api.ts'
import { ContainerView } from './ContainerView.tsx'
import { fmtBytes, fmtPercent, fold, isUp, keyOf, portLabel, portUrl, statusOf, usageRowOf } from './format.ts'
import { Icon } from './Icon.tsx'
import { useUsage } from './usage.ts'
import './containers.css'

type Filter = 'running' | 'all'
// Containers of one Compose project; those outside any come last, listed together, though they are no project.
type Group = { key: string; project: boolean; name: string; running: number; containers: ContainerRow[] }
const OUTSIDE = ''

// Kept across visits while the app runs: coming back, the page shows what it had while it reads again.
let keptList: ContainerList | null = null

/**
 * Taken from quack-board (Simon's pages/containers): the user's containers (Docker, Podman), each Compose project
 * framed, their state, published ports and what they use, and what can be done with them — start, stop, restart,
 * remove, and, in the terminal, a shell inside or their logs; a container's own view has the rest. Several can be
 * ticked to start, stop or remove them together. The list follows the engines' events. Nothing here starts a
 * project's whole environment: that belongs to each project's own tooling.
 */
export function ContainersPage() {
  const [list, setList] = useState<ContainerList | null>(keptList)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('running')
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [working, setWorking] = useState<Set<string>>(new Set())
  const [picked, setPicked] = useState<string[] | null>(null)
  const [open, setOpen] = useState<{ engine: string; id: string } | null>(null)
  const terminal = Boolean(window.bidule?.terminal)
  const usage = useUsage(!open && Boolean(list?.engines.length))

  const reload = () =>
    api
      .index({})
      .then((l) => {
        keptList = l as ContainerList
        setList(keptList)
        setError(null)
      })
      .catch((err) => setError(message(err)))
  useEffect(() => {
    void reload()
    void api.selection({}).then(({ keys }) => setPicked(keys), () => setPicked([]))
  }, [])
  // The engines' events (a container started, stopped, removed) reload the list.
  useOn('lunar-industries-containers.changed', () => void reload())

  // The ticks are saved as they change (once read: never the empty list of before).
  const saved = useRef(false)
  useEffect(() => {
    if (picked === null) return
    if (!saved.current) {
      saved.current = true
      return
    }
    void api.select({ body: { keys: picked } }).catch(() => undefined)
  }, [picked])
  // A container removed leaves nothing behind in the ticks; only when every engine answered: one that does not would
  // otherwise make its containers look removed.
  useEffect(() => {
    if (!list || list.errors.length || picked === null) return
    const live = new Set(list.containers.map(keyOf))
    if (picked.some((k) => !live.has(k))) setPicked(picked.filter((k) => live.has(k)))
  }, [list, picked])

  const all = list?.containers ?? []
  const running = all.filter((c) => c.state === 'running').length
  useHint(
    open
      ? null
      : !list
        ? null
        : !list.engines.length
          ? 'Ni Docker ni Podman en vue. Coin ?'
          : running
            ? `${running} conteneur${running > 1 ? 's' : ''} en marche sur ${all.length}. Coin.`
            : 'Tout dort. Coin.',
  )

  if (open) return <ContainerView target={open} back={() => setOpen(null)} />

  const q = fold(query.trim())
  const shown = all.filter(
    (c) =>
      (filter === 'all' || c.state === 'running') &&
      (!q ||
        [c.name, c.image, c.project ?? '', c.service ?? '', ...c.ports.map((p) => String(p.hostPort ?? p.port))].some((s) =>
          fold(s).includes(q),
        )),
  )
  const byKey = new Map<string, ContainerRow[]>()
  for (const c of shown) byKey.set(c.project ?? OUTSIDE, [...(byKey.get(c.project ?? OUTSIDE) ?? []), c])
  const groups: Group[] = [...byKey.entries()]
    .map(([key, containers]) => ({
      key,
      project: key !== OUTSIDE,
      name: key || 'Hors projet',
      running: containers.filter((c) => c.state === 'running').length,
      containers,
    }))
    .sort((a, b) => (a.key === OUTSIDE ? 1 : b.key === OUTSIDE ? -1 : a.name.localeCompare(b.name)))

  // What is ticked among the containers shown: one hidden by the search or the filter keeps its tick but is left
  // alone by the actions, so nothing is done to what the user cannot see.
  const ticks = new Set(picked ?? [])
  const chosen = groups.flatMap((g) => g.containers).filter((c) => ticks.has(keyOf(c)))
  const tick = (keys: string[], on: boolean) =>
    setPicked((p) => {
      const rest = (p ?? []).filter((k) => !keys.includes(k))
      return on ? [...rest, ...keys] : rest
    })
  const allTicked = (g: Group) => g.containers.length > 0 && g.containers.every((c) => ticks.has(keyOf(c)))
  const someTicked = (g: Group) => !allTicked(g) && g.containers.some((c) => ticks.has(keyOf(c)))

  const run = async (c: ContainerRow, action: 'start' | 'stop' | 'restart') => {
    if (working.has(c.id)) return
    setWorking((s) => new Set(s).add(c.id))
    try {
      if (await act(c, action)) await reload()
    } finally {
      setWorking((s) => {
        const next = new Set(s)
        next.delete(c.id)
        return next
      })
    }
  }
  // The same action on every container ticked it applies to: starting skips those already up, stopping those not.
  const runChosen = async (action: 'start' | 'stop') => {
    await Promise.all(chosen.filter((c) => (action === 'start' ? !isUp(c) : isUp(c))).map((c) => run(c, action)))
  }

  // What the running containers use of the machine, every engine together.
  const totals = (() => {
    if (!usage) return null
    const cpu = usage.containers.reduce((sum, c) => sum + c.cpu, 0)
    const memory = usage.containers.reduce((sum, c) => sum + c.memory, 0)
    const cpuMax = usage.cpus * 100
    return {
      cpu: fmtPercent(cpu),
      cpuMax: `${fmtPercent(cpuMax)} (${usage.cpus} cœur${usage.cpus > 1 ? 's' : ''})`,
      cpuWidth: cpuMax ? Math.min(100, Math.max(1, (cpu / cpuMax) * 100)) : 0,
      memory: fmtBytes(memory),
      memoryMax: fmtBytes(usage.memory),
      memoryWidth: usage.memory ? Math.min(100, Math.max(1, (memory / usage.memory) * 100)) : 0,
    }
  })()

  // In a project, a container is known by its service (« db »), which says what it is for; the long name Compose gave
  // it goes under it. Outside any project, its own name leads.
  const title = (c: ContainerRow, project: boolean) => (project && c.service ? c.service : c.name)
  const subtitle = (c: ContainerRow, project: boolean) => (project && c.service ? `${c.name} · ${c.image}` : c.image)

  const line = (c: ContainerRow, project: boolean) => {
    const up = isUp(c)
    const doing = working.has(c.id)
    const use = usage ? usageRowOf(usage.containers, c) : undefined
    return (
      <div key={keyOf(c)} className={`lic-row${c.state !== 'running' ? ' off' : ''}${ticks.has(keyOf(c)) ? ' chosen' : ''}`} aria-busy={doing}>
        <input type="checkbox" checked={ticks.has(keyOf(c))} aria-label={`Sélectionner ${c.name}`} onChange={(e) => tick([keyOf(c)], e.target.checked)} />
        <span className="row lic-name-cell">
          <span className={`dot lic-dot-${c.state}`} aria-hidden="true" />
          <span className="lic-names">
            <button type="button" className="mono ellipsis lic-name" title={`Voir la fiche de ${c.name}`} onClick={() => setOpen({ engine: c.engine, id: c.id })}>
              {title(c, project)}
            </button>
            <span className="legend ellipsis" title={subtitle(c, project)}>
              {subtitle(c, project)}
              {list && list.engines.length > 1 ? ` · ${c.engine}` : ''}
            </span>
          </span>
        </span>
        <span className="row lic-ports">
          {c.ports.map((p) => {
            const href = portUrl(c, p)
            const key = `${p.hostPort}/${p.port}${p.protocol}`
            return href ? (
              <a key={key} className="mono lic-port live" href={href} target="_blank" rel="noreferrer" title={`Ouvrir ${href}`}>
                {portLabel(p)}
              </a>
            ) : (
              <span key={key} className="mono lic-port">
                {portLabel(p)}
              </span>
            )
          })}
        </span>
        <span className="lic-resources">
          {use ? (
            <>
              <span className="mono">{fmtPercent(use.cpu)}</span>
              <span className="mono legend">{fmtBytes(use.memory)}</span>
            </>
          ) : (
            <span className="legend">—</span>
          )}
        </span>
        <span className="legend lic-status">{statusOf(c)}</span>
        <span className="row lic-actions">
          {terminal && (
            <>
              <button type="button" className="icon-btn" aria-label={`Ouvrir un shell dans ${c.name}`} title={`Ouvrir un shell dans ${c.name}`} disabled={c.state !== 'running'} onClick={() => void openTerminal(c, 'shell')}>
                <Icon name="terminal" />
              </button>
              <button type="button" className="icon-btn" aria-label={`Voir les journaux de ${c.name}`} title={`Voir les journaux de ${c.name}`} onClick={() => void openTerminal(c, 'logs')}>
                <Icon name="logs" />
              </button>
            </>
          )}
          {up ? (
            <>
              <button type="button" className="icon-btn" aria-label={`Redémarrer ${c.name}`} title={`Redémarrer ${c.name}`} disabled={doing} onClick={() => void run(c, 'restart')}>
                <Icon name="restart" />
              </button>
              <button type="button" className="icon-btn" aria-label={`Arrêter ${c.name}`} title={`Arrêter ${c.name}`} disabled={doing} onClick={() => void run(c, 'stop')}>
                <Icon name="stop" />
              </button>
            </>
          ) : (
            <button type="button" className="icon-btn lic-start" aria-label={`Démarrer ${c.name}`} title={`Démarrer ${c.name}`} disabled={doing} onClick={() => void run(c, 'start')}>
              <Icon name="play" />
            </button>
          )}
          <ContainerMenu c={c} disabled={doing} details={() => setOpen({ engine: c.engine, id: c.id })} removed={() => void reload()} />
        </span>
      </div>
    )
  }

  const filters = [
    { key: 'running' as const, label: 'En marche', count: running },
    { key: 'all' as const, label: 'Tous', count: all.length },
  ]
  return (
    <div className="page with-tools">
      <BannerTools>
        <ToolSearch label="Rechercher un conteneur" placeholder="Nom, image, projet, port…" value={query} onChange={setQuery} />
        <ToolFilter label="Conteneurs affichés" options={filters} value={filter} onChange={setFilter} />
      </BannerTools>

      {error && <div className="lic-error">Impossible de lire les conteneurs : {error}</div>}
      {!list && !error && <div className="muted lic-none">Chargement…</div>}
      {list && !list.engines.length && (
        <div className="empty">Ni Docker ni Podman trouvés sur cette machine : installez l’un des deux, la page les trouve d’elle-même.</div>
      )}

      {list && list.engines.length > 0 && (
        <>
          {/* What the running containers use of the machine, as at the top of Docker Desktop's page. */}
          <section className="lic-usage" aria-label="Ressources utilisées">
            {[
              { name: 'Processeur', value: totals?.cpu, max: totals?.cpuMax, width: totals?.cpuWidth ?? 0 },
              { name: 'Mémoire', value: totals?.memory, max: totals?.memoryMax, width: totals?.memoryWidth ?? 0 },
            ].map((m) => (
              <div key={m.name} className="panel">
                <div className="row lic-meter-head">
                  <h2>{m.name}</h2>
                  <span className="legend">
                    <span className="mono lic-meter-value">{m.value ?? '—'}</span>
                    {m.max && ` sur ${m.max}`}
                  </span>
                </div>
                <div className="lic-meter" role="img" aria-label={`${m.name} utilisé : ${m.value ?? 'en cours de mesure'}`}>
                  <div className="lic-meter-fill" style={{ width: `${m.width}%` }} />
                </div>
              </div>
            ))}
          </section>

          {list.errors.map((e) => (
            <div key={e.engine} className="lic-error">
              {e.engine} ne répond pas : {e.message}
            </div>
          ))}

          {/* The ticked containers, and what can be done with them all at once. */}
          {chosen.length > 0 && (
            <div className="row lic-selection" role="region" aria-label="Actions sur la sélection">
              <span className="lic-selection-count">
                {chosen.length} {chosen.length > 1 ? 'conteneurs sélectionnés' : 'conteneur sélectionné'}
              </span>
              <span className="grow" />
              <button type="button" className="btn" disabled={!chosen.some((c) => !isUp(c))} onClick={() => void runChosen('start')}>
                Démarrer
              </button>
              <button type="button" className="btn" disabled={!chosen.some(isUp)} onClick={() => void runChosen('stop')}>
                Arrêter
              </button>
              <button type="button" className="btn lic-danger" onClick={() => void removeAll(chosen).then(() => reload())}>
                Supprimer
              </button>
              <button type="button" className="btn" onClick={() => setPicked([])}>
                Tout désélectionner
              </button>
            </div>
          )}

          <section className="panel lic-panel" aria-label="Conteneurs">
            {!groups.length && (
              <p className="legend lic-none">
                {query ? 'Aucun conteneur ne correspond.' : filter === 'running' ? 'Aucun conteneur en marche.' : 'Aucun conteneur.'}
              </p>
            )}
            {groups.map((g) =>
              g.project ? (
                <section key={g.key} className="lic-project" aria-label={`Projet ${g.name}`}>
                  <div className="row lic-project-head">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-expanded={!folded.has(g.key)}
                      aria-label={`${folded.has(g.key) ? 'Déplier' : 'Replier'} ${g.name}`}
                      onClick={() =>
                        setFolded((s) => {
                          const next = new Set(s)
                          if (!next.delete(g.key)) next.add(g.key)
                          return next
                        })
                      }
                    >
                      <Icon name={folded.has(g.key) ? 'right' : 'down'} />
                    </button>
                    <input
                      type="checkbox"
                      checked={allTicked(g)}
                      ref={(box) => {
                        if (box) box.indeterminate = someTicked(g)
                      }}
                      aria-label={`Sélectionner tout le projet ${g.name}`}
                      onChange={() => tick(g.containers.map(keyOf), !allTicked(g))}
                    />
                    <span className="lic-group-name">{g.name}</span>
                    <span className="cream-pill">Projet Compose</span>
                    <span className="grow" />
                    <span className="legend">
                      {g.running} en marche sur {g.containers.length}
                    </span>
                  </div>
                  {!folded.has(g.key) && <div className="lic-project-body">{g.containers.map((c) => line(c, true))}</div>}
                </section>
              ) : (
                // Containers started on their own belong together to nothing: lines, not a framed block.
                <section key={g.key} className="lic-loose" aria-label="Hors projet">
                  <h2 className="legend lic-loose-title">
                    Hors projet · {g.running} en marche sur {g.containers.length}
                  </h2>
                  {g.containers.map((c) => line(c, false))}
                </section>
              ),
            )}
          </section>
        </>
      )}
    </div>
  )
}
