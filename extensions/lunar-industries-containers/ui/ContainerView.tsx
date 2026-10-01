import { useEffect, useRef, useState } from 'react'
import { BannerTools, ToolSearch, useHint, useOn } from '@bidule/sdk'
import type { ContainerDetail, ContainerFile } from '../contract.ts'
import { act, ContainerMenu, copyId, openTerminal } from './actions.tsx'
import { api, message } from './api.ts'
import { fmtBytes, fmtPercent, fold, isUp, parseLine, portLabel, portUrl, relTime, statusOf, usageRowOf, type LogLine } from './format.ts'
import { Icon } from './Icon.tsx'
import { useUsage } from './usage.ts'

type Tab = 'logs' | 'stats' | 'files'

// The logs kept on the view: the oldest go as new ones come.
const KEPT_LINES = 2000
// The measures drawn on the statistics: one every few seconds, since the view was opened.
const KEPT_SAMPLES = 60
// How often the logs are asked for what was written since, while their tab shows.
const LOGS_EVERY_MS = 2000

const STATE_TEXT: Record<string, string> = {
  running: 'En marche',
  paused: 'En pause',
  restarting: 'Redémarre',
  created: 'Créé',
  exited: 'Arrêté',
  dead: 'Mort',
}

// A line through the samples, from the left; `max` is the top of the chart (the highest sample if none).
function chart(samples: number[], max?: number): { line: string; area: string; top: number } {
  const top = Math.max(max ?? 0, ...samples, 1e-9) * (max ? 1 : 1.2)
  if (samples.length < 2) return { line: '', area: '', top }
  const points = samples.map((v, i) => `${((i / (samples.length - 1)) * 100).toFixed(2)},${(100 - (v / top) * 100).toFixed(2)}`)
  return { line: points.join(' '), area: `0,100 ${points.join(' ')} 100,100`, top }
}

/**
 * Taken from quack-board (Simon's container page), as in Docker Desktop: what one container is and what can be done
 * with it, its logs (the last ones, then each new line), what it uses over the time the view has been open, and the
 * files inside it. The engines are asked for its numbers and its logs only while the view shows them.
 */
export function ContainerView({ target, back }: { target: { engine: string; id: string }; back: () => void }) {
  const { engine, id } = target
  const [c, setC] = useState<ContainerDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('logs')
  const [busy, setBusy] = useState(false)
  const terminal = Boolean(window.bidule?.terminal)

  const reload = () =>
    api
      .show({ params: { engine, id } })
      .then((d) => {
        setC(d as ContainerDetail)
        setError(null)
      })
      .catch((err) => setError(message(err)))
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, id])
  // The container started, stopped or went: read again.
  useOn('lunar-industries-containers.changed', () => void reload())
  useHint(c ? `${c.name} : ${isUp(c) ? 'il tourne' : 'il dort'}. Coin.` : null)

  // ---- logs: the last lines, then those written since the last one, while their tab shows
  const [lines, setLines] = useState<LogLine[]>([])
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const last = useRef('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    last.current = ''
    setLines([])
  }, [engine, id])
  useEffect(() => {
    if (tab !== 'logs') return
    let live = true
    let asking = false
    const ask = async () => {
      if (asking) return
      asking = true
      try {
        const { lines: raw } = await api.logs({ params: { engine, id }, query: last.current ? { since: last.current } : {} })
        // A line at the very time of the last one already shown came with it.
        const fresh = raw.map(parseLine).filter((l) => !last.current || !l.stamp || l.stamp > last.current)
        const stamped = fresh.filter((l) => l.stamp).at(-1)
        if (stamped) last.current = stamped.stamp
        if (live && fresh.length) setLines((now) => [...now, ...fresh].slice(-KEPT_LINES))
      } catch {
        // A stopped engine or a removed container: the view's own reading says so.
      } finally {
        asking = false
      }
    }
    void ask()
    const timer = setInterval(() => void ask(), LOGS_EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [tab, engine, id])
  const q = fold(query.trim())
  const shownLines = q ? lines.filter((l) => fold(l.text).includes(q)) : lines
  // The end of the logs stays in view while « Suivre la fin » is ticked.
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shownLines.length, follow, tab])

  // ---- what it uses, a measure every few seconds since the view opened
  const usage = useUsage(true)
  const [cpuSamples, setCpuSamples] = useState<number[]>([])
  const [memorySamples, setMemorySamples] = useState<number[]>([])
  const row = usage ? usageRowOf(usage.containers, { engine, id }) : undefined
  const seen = useRef<object | null>(null)
  useEffect(() => {
    if (!row || !usage || seen.current === usage) return
    seen.current = usage
    setCpuSamples((s) => [...s, row.cpu].slice(-KEPT_SAMPLES))
    setMemorySamples((s) => [...s, row.memory].slice(-KEPT_SAMPLES))
  }, [usage, row])
  const meters = {
    cpu: row ? fmtPercent(row.cpu) : '—',
    memory: row ? fmtBytes(row.memory) : '—',
    memoryOf: row ? `${fmtBytes(row.memory)} sur ${fmtBytes(row.limit)}` : '—',
    // A container may take several cores: the bar stops at one.
    cpuWidth: row ? Math.min(100, Math.max(1, row.cpu)) : 0,
    memoryWidth: row && row.limit ? Math.min(100, Math.max(1, (row.memory / row.limit) * 100)) : 0,
  }
  const cpuChart = chart(cpuSamples)
  const memoryChart = chart(memorySamples, row?.limit)

  // ---- files, read when their tab shows
  const [path, setPath] = useState('/')
  const [files, setFiles] = useState<ContainerFile[] | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  useEffect(() => {
    if (tab !== 'files') return
    let live = true
    setFiles(null)
    api
      .files({ params: { engine, id }, query: { path } })
      .then((r) => {
        if (!live) return
        setFiles(r.files)
        setFilesError(null)
      })
      .catch((err) => live && setFilesError(message(err)))
    return () => {
      live = false
    }
  }, [tab, path, engine, id])
  const parts = path.split('/').filter(Boolean)
  const crumbs = parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))
  const child = (name: string) => (path === '/' ? '' : path) + '/' + name

  const run = async (action: 'start' | 'stop' | 'restart') => {
    if (!c || busy) return
    setBusy(true)
    try {
      if (await act(c, action)) await reload()
    } finally {
      setBusy(false)
    }
  }

  if (error && !c)
    return (
      <div className="page">
        <div className="empty">
          {error} : ce conteneur n’existe plus, ou son moteur ne répond pas.
          <p>
            <button type="button" className="btn" onClick={back}>
              Retour aux conteneurs
            </button>
          </p>
        </div>
      </div>
    )
  if (!c) return <div className="page" />

  return (
    <div className="page with-tools">
      {tab === 'logs' && (
        <BannerTools>
          <ToolSearch label="Chercher dans les journaux" placeholder="Chercher dans les journaux…" value={query} onChange={setQuery} />
        </BannerTools>
      )}
      {/* Where we are, what this container is, and what can be done with it. */}
      <header className="lic-view-head">
        <button type="button" className="btn lic-back" onClick={back}>
          <Icon name="left" size={16} />
          Conteneurs
        </button>
        <div className="row lic-view-title">
          <span className={`dot lic-dot-${c.state}`} aria-hidden="true" />
          <div className="lic-names">
            <div className="row lic-view-name-line">
              <h1 className="mono lic-view-name">{c.name}</h1>
              <span className={`cream-pill lic-state-${c.state}`}>{STATE_TEXT[c.state] ?? c.state}</span>
            </div>
            <p className="legend">
              {c.image}
              {c.project && (
                <>
                  {' · '}
                  <span className="mono">projet {c.project}</span>
                </>
              )}
              {' · '}
              {statusOf(c)}
            </p>
          </div>
          <span className="grow" />
          <span className="row lic-view-actions">
            {terminal && (
              <button type="button" className="btn" disabled={!isUp(c)} onClick={() => void openTerminal(c, 'shell')}>
                <Icon name="terminal" size={16} />
                Ouvrir un shell
              </button>
            )}
            {isUp(c) ? (
              <>
                <button type="button" className="btn" disabled={busy} onClick={() => void run('restart')}>
                  <Icon name="restart" size={16} />
                  Redémarrer
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void run('stop')}>
                  <Icon name="stop" size={16} />
                  Arrêter
                </button>
              </>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => void run('start')}>
                <Icon name="play" size={16} />
                Démarrer
              </button>
            )}
            <ContainerMenu c={c} disabled={busy} removed={back} />
          </span>
        </div>
      </header>

      <div className="lic-view-body">
        <section className="panel lic-view-main" aria-label="Contenu du conteneur">
          <div className="row lic-toolbar">
            <div className="segmented" role="group" aria-label="Contenu">
              {(
                [
                  ['logs', 'Journaux'],
                  ['stats', 'Statistiques'],
                  ['files', 'Fichiers'],
                ] as const
              ).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="grow" />
            {tab === 'logs' && (
              <>
                <label className="row lic-check">
                  <input type="checkbox" checked={follow} onChange={() => setFollow(!follow)} />
                  Suivre la fin
                </label>
                {terminal && (
                  <button type="button" className="btn" onClick={() => void openTerminal(c, 'logs')}>
                    Ouvrir dans le Terminal
                  </button>
                )}
              </>
            )}
          </div>

          {tab === 'logs' && (
            <div ref={box} className="mono lic-logs" role="log" aria-label="Dernières lignes du journal">
              {shownLines.map((l, i) => (
                <div key={i} className={`lic-log${l.level ? ` ${l.level}` : ''}`}>
                  {l.time && <span className="lic-log-time">{l.time}</span>}
                  {l.text}
                </div>
              ))}
              {!shownLines.length && <p className="legend lic-empty">{query ? 'Aucune ligne ne correspond.' : 'Aucune ligne pour le moment.'}</p>}
            </div>
          )}

          {tab === 'stats' && (
            <>
              <p className="legend lic-empty">Depuis l’ouverture de cette fiche : une mesure toutes les quelques secondes.</p>
              <div className="lic-charts">
                {[
                  { name: 'Processeur', value: meters.cpu, chart: cpuChart, top: fmtPercent(cpuChart.top) },
                  { name: 'Mémoire', value: meters.memory, chart: memoryChart, top: fmtBytes(memoryChart.top) },
                ].map((m) => (
                  <div key={m.name} className="lic-chart">
                    <div className="row lic-chart-head">
                      <h2>{m.name}</h2>
                      <span className="legend mono">{m.value}</span>
                    </div>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Historique : ${m.name}`}>
                      {m.chart.line && (
                        <>
                          <polygon className="lic-area" points={m.chart.area} />
                          <polyline className="lic-line" points={m.chart.line} />
                        </>
                      )}
                    </svg>
                    <span className="legend">Échelle : jusqu’à {m.top}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'files' && (
            <>
              <nav className="row lic-crumbs" aria-label="Dossier affiché">
                <button type="button" className="chip-btn" onClick={() => setPath('/')}>
                  /
                </button>
                {crumbs.map((b) => (
                  <button key={b.path} type="button" className="chip-btn" onClick={() => setPath(b.path)}>
                    {b.name}
                  </button>
                ))}
              </nav>
              {filesError ? (
                <p className="legend lic-empty">{isUp(c) ? filesError : 'Les fichiers se lisent dans un conteneur en marche.'}</p>
              ) : (
                <div className="mono lic-files">
                  {path !== '/' && (
                    <button type="button" className="lic-file dir" onClick={() => setPath('/' + parts.slice(0, -1).join('/'))}>
                      ../
                    </button>
                  )}
                  {files?.map((f) =>
                    f.directory ? (
                      <button key={f.name} type="button" className="lic-file dir" onClick={() => setPath(child(f.name))}>
                        {f.name}/
                      </button>
                    ) : (
                      <span key={f.name} className="lic-file">
                        {f.name}
                      </span>
                    ),
                  )}
                  {files && !files.length && <p className="legend lic-empty">Dossier vide.</p>}
                  {!files && <p className="legend lic-empty">Lecture…</p>}
                </div>
              )}
            </>
          )}
        </section>

        <aside className="lic-view-side">
          <section className="panel" aria-label="Ressources">
            <h2>Ressources</h2>
            {[
              { name: 'Processeur', value: meters.cpu, width: meters.cpuWidth },
              { name: 'Mémoire', value: meters.memoryOf, width: meters.memoryWidth },
            ].map((m) => (
              <div key={m.name} className="lic-side-meter">
                <div className="row lic-meter-head">
                  <span className="legend">{m.name}</span>
                  <span className="mono">{m.value}</span>
                </div>
                <div className="lic-meter" role="img" aria-label={`${m.name} : ${m.value}`}>
                  <div className="lic-meter-fill" style={{ width: `${m.width}%` }} />
                </div>
              </div>
            ))}
          </section>

          <section className="panel" aria-label="Informations">
            <h2>Informations</h2>
            <dl className="lic-info">
              <dt>Identifiant</dt>
              <dd className="row">
                <span className="mono">{c.id.slice(0, 12)}</span>
                <button type="button" className="icon-btn" aria-label="Copier l’identifiant" onClick={() => void copyId(c)}>
                  <Icon name="copy" size={16} />
                </button>
              </dd>
              <dt>Image</dt>
              <dd className="mono">{c.image}</dd>
              {c.ports.length > 0 && (
                <>
                  <dt>Ports</dt>
                  <dd className="row lic-ports">
                    {c.ports.map((p) => {
                      const href = portUrl(c, p)
                      const key = `${p.hostPort}/${p.port}${p.protocol}`
                      return href ? (
                        <a key={key} className="mono lic-port live" href={href} target="_blank" rel="noreferrer">
                          {portLabel(p)}
                        </a>
                      ) : (
                        <span key={key} className="mono lic-port">
                          {portLabel(p)}
                        </span>
                      )
                    })}
                  </dd>
                </>
              )}
              {c.networks.length > 0 && (
                <>
                  <dt>Réseau</dt>
                  <dd className="mono">{c.networks.join(', ')}</dd>
                </>
              )}
              {c.mounts.length > 0 && (
                <>
                  <dt>Volumes</dt>
                  <dd className="lic-mounts">
                    {c.mounts.map((m) => (
                      <span key={m.destination} className="mono" title={m.source}>
                        {m.name ?? m.source} → {m.destination}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              <dt>Créé</dt>
              <dd>{relTime(c.createdAt)}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
