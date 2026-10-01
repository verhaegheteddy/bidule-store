import { useEffect, useRef, useState } from 'react'
import { busy, execute, Modal, openDialog, react } from '@bidule/sdk'
import type {} from '@bidule/ext-terminal/contract'
import type { ContainerAction, ContainerRow } from '../contract.ts'
import { api, message } from './api.ts'
import { isUp } from './format.ts'
import { Icon } from './Icon.tsx'

// What a container's line and its view do with it: act, open a terminal on it, copy its id, remove it.

// The action, said by the mascot when it fails; true when it went through.
export async function act(c: ContainerRow, action: ContainerAction): Promise<boolean> {
  try {
    await busy(api.act({ params: { engine: c.engine, id: c.id }, body: { action } }))
    return true
  } catch (err) {
    const text = `${c.name} : ${message(err)}`
    react('panic', text, text)
    return false
  }
}

// A terminal tab on the container (the `terminal` role): a shell inside, or its logs.
export async function openTerminal(c: ContainerRow, kind: 'shell' | 'logs'): Promise<void> {
  try {
    const { session } = await api.terminal({ params: { engine: c.engine, id: c.id }, body: { kind } })
    await execute('terminal.open', { session, title: kind === 'logs' ? `Logs · ${c.name}` : c.name })
  } catch (err) {
    const text = `${c.name} : ${message(err)}`
    react('panic', text, text)
  }
}

export async function copyId(c: ContainerRow): Promise<void> {
  try {
    await navigator.clipboard.writeText(c.id)
    react('quack', 'Identifiant copié, coin !', 'Identifiant copié')
  } catch {
    react('panic', 'Impossible de copier', 'Impossible de copier')
  }
}

// Removing asks first, however many: it cannot be undone, and a running container is stopped to go.
export function confirmRemove(targets: ContainerRow[]): Promise<boolean> {
  const [first] = targets
  if (!first) return Promise.resolve(false)
  return new Promise((resolve) => {
    openDialog((close) => {
      const done = (ok: boolean) => {
        close()
        resolve(ok)
      }
      return (
        <Modal label="Supprimer des conteneurs" onClose={() => done(false)}>
          <h2>{targets.length > 1 ? `Supprimer ${targets.length} conteneurs ?` : `Supprimer ${first.name} ?`}</h2>
          <p>
            {targets.some(isUp) ? 'Ceux qui sont en marche seront arrêtés d’abord. ' : ''}
            Leurs volumes sont conservés.
          </p>
          <div className="row">
            <span className="grow" />
            <button type="button" className="btn" onClick={() => done(false)}>
              Annuler
            </button>
            <button type="button" className="btn lic-danger" onClick={() => done(true)}>
              Supprimer
            </button>
          </div>
        </Modal>
      )
    })
  })
}

export async function removeAll(targets: ContainerRow[]): Promise<boolean> {
  if (!(await confirmRemove(targets))) return false
  const done = await Promise.all(targets.map((c) => act(c, 'remove')))
  return done.every(Boolean)
}

// The rarer actions of a container, behind « … »: its view (from the list), copying its id, removing it.
export function ContainerMenu({
  c,
  disabled,
  details,
  removed,
}: {
  c: ContainerRow
  disabled?: boolean
  details?: () => void
  removed?: () => void
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!at) return
    menu.current?.querySelector('button')?.focus()
    const away = (e: Event) => !menu.current?.contains(e.target as Node) && setAt(null)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAt(null)
    addEventListener('mousedown', away)
    addEventListener('keydown', esc)
    return () => {
      removeEventListener('mousedown', away)
      removeEventListener('keydown', esc)
    }
  }, [at])
  const run = (fn: () => unknown) => {
    setAt(null)
    void fn()
  }
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Plus d’actions pour ${c.name}`}
        title="Plus d’actions"
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        disabled={disabled}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          // Under the button, its right edge on the button's, kept inside the window.
          setAt(at ? null : { x: Math.max(8, r.right - 220), y: Math.min(r.bottom + 4, innerHeight - 160) })
        }}
      >
        <Icon name="more" />
      </button>
      {at && (
        <div ref={menu} className="menu floating" role="menu" style={{ left: at.x, top: at.y }}>
          {details && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => run(details)}>
              Voir la fiche
            </button>
          )}
          <button type="button" role="menuitem" className="menu-item" onClick={() => run(() => copyId(c))}>
            Copier l’identifiant
          </button>
          <hr className="menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="menu-item lic-danger"
            onClick={() => run(async () => (await removeAll([c])) && removed?.())}
          >
            Supprimer
          </button>
        </div>
      )}
    </>
  )
}
