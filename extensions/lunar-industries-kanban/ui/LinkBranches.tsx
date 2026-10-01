import { useMemo, useState } from 'react'
import { Modal } from '@bidule/sdk'
import type { BranchRef, KanbanBranch } from '../contract.ts'
import { branchKey, linkRows } from './layout.ts'

// « Lier des branches… »: the task's branches to tick, searched by name or repo, grouped by repo.
export function LinkBranches({
  title,
  taskId,
  branches,
  titleOf,
  save,
  close,
}: {
  title: string
  taskId: string
  branches: KanbanBranch[]
  titleOf: (taskId: string) => string
  save: (refs: BranchRef[]) => Promise<void>
  close: () => void
}) {
  const [query, setQuery] = useState('')
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(branches.filter((b) => b.taskId === taskId).map(branchKey)),
  )
  const [saving, setSaving] = useState(false)
  const rows = useMemo(() => linkRows(branches, taskId, query, titleOf, checked), [branches, taskId, query, titleOf, checked])
  const toggle = (key: string) =>
    setChecked((set) => {
      const next = new Set(set)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const submit = async () => {
    setSaving(true)
    try {
      await save(branches.filter((b) => checked.has(branchKey(b))).map(({ repo, name }) => ({ repo, name })))
      close()
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal label={`Branches de « ${title} »`} onClose={close}>
      <h2>Branches de « {title} »</h2>
      <label className="field">
        Chercher une branche
        <input type="search" autoComplete="off" spellCheck={false} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="lik-checks" role="group" aria-label="Branches">
        {rows.map((row, i) => (
          <div key={row.key}>
            {row.repo !== rows[i - 1]?.repo && <div className="legend lik-check-group">{row.repo}</div>}
            <label className="trow lik-check">
              <input type="checkbox" checked={row.checked} onChange={() => toggle(row.key)} />
              <span className="mono lik-check-name" title={row.name}>
                {row.name}
              </span>
              {row.note && (
                <span className="legend lik-check-note" title={row.note}>
                  {row.note}
                </span>
              )}
            </label>
          </div>
        ))}
        {!rows.length && <p className="legend">Aucune branche ne correspond.</p>}
      </div>
      <div className="row">
        <span className="grow" />
        <button type="button" className="btn" onClick={close}>
          Annuler
        </button>
        <button type="button" className="btn-cta" disabled={saving} onClick={() => void submit()}>
          Enregistrer
        </button>
      </div>
    </Modal>
  )
}
