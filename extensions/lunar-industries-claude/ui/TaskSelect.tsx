import type { Task } from '@bidule/sdk'

// A task among the board's (the user's own), by its reference and title; `none` names the empty choice.
export function TaskSelect({
  label,
  tasks,
  value,
  none,
  disabled,
  onChange,
}: {
  label: string
  tasks: Task[]
  value: string | null
  none: string
  disabled?: boolean
  onChange: (id: string | null) => void
}) {
  return (
    <label className="field lc-task-field">
      <span className={label ? '' : 'sr-only'}>{label}</span>
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{none}</option>
        {value && !tasks.some((t) => t.id === value) && <option value={value}>Tâche en cours</option>}
        {tasks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.ref ? `${t.ref} · ${t.title}` : t.title}
          </option>
        ))}
      </select>
    </label>
  )
}
