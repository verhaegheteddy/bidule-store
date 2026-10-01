import { useEffect, useState } from 'react'
import { saveSettingValues, useSettingValues, type Board } from '@bidule/sdk'
import { board as readBoard } from './api.ts'
import { parseList } from './layout.ts'

const HIDDEN = 'lunar-industries-kanban.hidden'

// Réglages › Lunar Industries - Kanban: the columns shown. They are the source's statuses: shown once a source of
// tasks gives them.
export function KanbanSettings() {
  const [board, setBoard] = useState<Board | null>(null)
  const values = useSettingValues()
  useEffect(() => {
    void readBoard().then((b) => setBoard(b.source === null ? null : b))
  }, [])
  if (!board?.columns.length || !values) return null
  const hidden = parseList(values[HIDDEN])
  return (
    <div className="fields">
      <div className="field wide">
        Colonnes affichées
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {board.columns.map((c) => {
            const shown = !hidden.includes(c.name)
            return (
              <button
                key={c.name}
                type="button"
                className="chip-btn"
                aria-pressed={shown}
                onClick={() =>
                  void saveSettingValues({
                    [HIDDEN]: JSON.stringify(shown ? [...hidden, c.name] : hidden.filter((h) => h !== c.name)),
                  })
                }
              >
                {c.name}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
