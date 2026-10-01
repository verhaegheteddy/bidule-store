import { useId, useState } from 'react'
import type { Task } from '@bidule/sdk'
import type { ListedBranch } from '../contract.ts'
import { findTasks } from './steps.ts'

/**
 * Taken from quack-board (Simon's task-picker): a field that finds a task as one types (title, reference, branch),
 * 8 at most, those not done first. It shows the task chosen; typing replaces it, leaving without a pick puts it back.
 */
export function TaskPicker({
  label,
  tasks,
  done,
  branches,
  current,
  picked,
}: {
  label: string
  tasks: Task[]
  done: Set<string>
  branches: ListedBranch[]
  current: string
  picked: (id: string) => void
}) {
  const id = useId()
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const open = query !== null
  // The current task's own title searches nothing: the list then offers every task.
  const results = open ? findTasks(tasks, done, branches, query === current ? '' : query) : []
  const choose = (task: Task | undefined) => {
    if (!task) return
    picked(task.id)
    setQuery(null)
  }
  return (
    <label className="field lib-picker">
      {label}
      <input
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && results[active] ? `${id}-${active}` : undefined}
        autoComplete="off"
        placeholder="Chercher une tâche (titre, ID, branche)…"
        value={query ?? current}
        onFocus={(e) => {
          setQuery(current)
          setActive(0)
          e.currentTarget.select()
        }}
        onBlur={() => setQuery(null)}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)))
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
          else if (e.key === 'Enter') choose(results[active])
          else if (e.key === 'Escape') e.currentTarget.blur()
          else return
          e.preventDefault()
        }}
      />
      {open && results.length > 0 && (
        <div id={`${id}-list`} role="listbox" className="menu lib-picker-list">
          {results.map((t, i) => (
            <div
              key={t.id}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className="menu-item lib-picker-item"
              // Before the field's blur: the choice is made while the list is still there.
              onMouseDown={(e) => {
                e.preventDefault()
                choose(t)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="ellipsis">{t.title}</span>
              {t.ref && <span className="legend mono">{t.ref}</span>}
            </div>
          ))}
        </div>
      )}
    </label>
  )
}
