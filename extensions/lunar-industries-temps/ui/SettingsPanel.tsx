import { saveSettingValues, useSettingValues } from '@bidule/sdk'
import { DAYS_SHORT } from './format.ts'

const KEY = 'lunar-industries-temps.workDays'
const NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']

// The work days, one box per day: a past work day with nothing is « à remplir », another day « non travaillé ».
export function SettingsPanel() {
  const values = useSettingValues()
  if (!values) return null
  const raw = values[KEY]
  const days = new Set(
    String(raw ?? '1, 2, 3, 4, 5')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => n >= 1 && n <= 7)
  )
  const toggle = (n: number) => {
    const next = new Set(days)
    if (next.has(n)) next.delete(n)
    else next.add(n)
    void saveSettingValues({ [KEY]: [...next].sort().join(', ') })
  }
  return (
    <div className="field wide">
      Jours de travail
      <div className="row lit-workdays" role="group" aria-label="Jours de travail">
        {DAYS_SHORT.map((short, i) => (
          <button key={short} type="button" className="chip-btn" aria-pressed={days.has(i + 1)} aria-label={NAMES[i]} onClick={() => toggle(i + 1)}>
            {short}
          </button>
        ))}
      </div>
      <span className="hint muted">
        {days.size} jour{days.size > 1 ? 's' : ''} par semaine. Un jour de travail passé sans rien est « à remplir », un autre jour « non travaillé ».
      </span>
    </div>
  )
}
