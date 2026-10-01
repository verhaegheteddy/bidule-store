import { useId, useMemo, useState } from 'react'
import type { Task, TaskColumn } from '@bidule/sdk'

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// Taken from quack-board (components/task-picker, Simon's): a task found by its title or reference, eight at most,
// the tasks not done first. A combobox: the arrows go through the results, Enter picks one.
export function TaskPicker({
  tasks,
  columns,
  label,
  onPick,
}: {
  tasks: Task[]
  columns: TaskColumn[]
  label: string
  onPick: (taskId: string) => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const done = useMemo(() => new Set(columns.filter((c) => c.group === 'done').map((c) => c.name)), [columns])
  const results = useMemo(() => {
    const q = fold(query.trim())
    return tasks
      .filter((t) => !q || fold(`${t.title} ${t.ref ?? ''}`).includes(q))
      .sort((a, b) => Number(done.has(a.status)) - Number(done.has(b.status)))
      .slice(0, 8)
  }, [tasks, query, done])
  const pick = (t: Task) => {
    onPick(t.id)
    setQuery('')
    setOpen(false)
  }
  return (
    <div className="lit-picker">
      <label className="field">
        {label}
        <input
          type="text"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && results[active] ? `${id}-${active}` : undefined}
          autoComplete="off"
          placeholder="Titre ou référence de la tâche…"
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setActive((a) => Math.min(a + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter' && open && results[active]) {
              e.preventDefault()
              pick(results[active])
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
      </label>
      {open && results.length > 0 && (
        <ul className="menu lit-picker-list" role="listbox" id={`${id}-list`} aria-label={label}>
          {results.map((t, i) => (
            <li
              key={t.id}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className="menu-item lit-picker-item"
              // Before the field's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(t)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="ellipsis">{t.title}</span>
              {t.ref && <span className="mono legend">{t.ref}</span>}
              {done.has(t.status) && <span className="legend">terminée</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
