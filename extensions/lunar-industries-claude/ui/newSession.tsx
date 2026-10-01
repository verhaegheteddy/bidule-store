import { useState } from 'react'
import { Modal, openDialog, react, useSettingValues, type Task } from '@bidule/sdk'
import type { SessionEffort, SessionMode } from '../contract.ts'
import { api, errorMessage } from './api.ts'
import { DEFAULT, effortOf, effortOptions, effortsOf, modelHint, modelOptions, modeOf, MODES, summaryOf } from './models.ts'
import { useBoard, useModels, useTemplates } from './state.ts'
import { TaskSelect } from './TaskSelect.tsx'

// The skill « Démarrer la tâche » asks for: it takes a task from its plan to staging (the issue, the MR and the
// worktrees on the way).
export const START_SKILL = 'workspace:task-to-staging'

type Options = { taskId?: string | null; skill?: string | null }

// The first message prepared from a task: Claude reads the rest with its tools.
const messageFor = (task: Task | undefined) => (task ? `Tâche ${task.ref ? `${task.ref} : ` : ''}${task.title}.` : '')

// A skill as the first message: Claude applies it to the task, when there is one.
function skillMessage(name: string, task: Task | undefined): string {
  const about = task ? ` à la tâche ${task.ref ? `${task.ref} ` : ''}(« ${task.title} »)` : ''
  return `Applique le skill ${name}${about}.`
}

/**
 * A new Claude session (Simon's new-session): its task (or none; the task's branches get their worktrees), its first
 * message, prepared from the task or from a skill, its starting mode, model and effort. The repos are not asked: the
 * API takes those of the task's branches. Closed with the new session's id.
 */
function NewSession({ options, done }: { options: Options; done: (id: string | null) => void }) {
  const board = useBoard()
  const tasks = board?.tasks ?? []
  const settings = useSettingValues()
  const models = useModels()
  const templates = useTemplates()
  const [taskId, setTaskId] = useState<string | null>(options.taskId ?? null)
  const task = tasks.find((t) => t.id === taskId)
  const suggested = (t: Task | undefined) => (options.skill ? skillMessage(options.skill, t) : messageFor(t))
  // null until the user writes: the message follows the task until then.
  const [written, setWritten] = useState<string | null>(null)
  const message = written ?? suggested(task)
  // Those of the last session started (the API keeps them in the settings); null: Claude Code's default.
  const [mode, setMode] = useState<SessionMode | null>(null)
  const [model, setModel] = useState<string | null | undefined>(undefined)
  const [effort, setEffort] = useState<SessionEffort | null | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const shownMode = mode ?? modeOf(settings?.['lunar-industries-claude.defaultMode'])?.value ?? 'default'
  const shownModel = model === undefined ? String(settings?.['lunar-industries-claude.defaultModel'] ?? '') || null : model
  const shownEffort = effort === undefined ? effortOf(settings?.['lunar-industries-claude.defaultEffort']) : effort
  const effortChoices = effortOptions(models, shownModel)

  // An effort the new model does not take goes back to the default.
  const pickModel = (value: string) => {
    const next = value || null
    setModel(next)
    if (shownEffort && !effortsOf(models, next).includes(shownEffort)) setEffort(null)
  }

  const start = async () => {
    const prompt = message.trim()
    if (!prompt) return
    setStarting(true)
    try {
      const { id } = await api.start({
        repos: [],
        prompt,
        mode: shownMode,
        model: shownModel,
        effort: shownEffort,
        taskId,
      })
      done(id)
    } catch (err) {
      react('panic', errorMessage(err), errorMessage(err))
    } finally {
      setStarting(false)
    }
  }

  const title = options.skill ? 'Démarrer la tâche' : 'Nouvelle session Claude'
  return (
    <Modal label={title} onClose={() => done(null)}>
      <div className="lc-new">
        <header className="lc-new-head">
          <h2>{title}</h2>
          <p className="legend">
            {options.skill
              ? 'Claude déroule la tâche avec le skill de l’équipe : plan, issue et MR, travail dans des worktrees à part (vos dépôts restent sur leur branche actuelle), puis mise en staging.'
              : 'Claude travaille dans des worktrees à part : vos dépôts restent sur leur branche actuelle.'}
          </p>
        </header>

        <div className="lc-new-body">
          <section className="lc-new-section" aria-label="Tâche">
            <TaskSelect label="Tâche" tasks={tasks} value={taskId} none="Sans tâche" onChange={setTaskId} />
            <span className="legend">
              {taskId
                ? 'Les branches de la tâche auront chacune leur worktree.'
                : 'Ou lancez une session sans tâche, pour une question ponctuelle.'}
            </span>
          </section>

          <section className="lc-new-section" aria-labelledby="lc-new-message">
            <div className="row">
              <h3 id="lc-new-message" className="grow">
                Premier message
              </h3>
              {templates.length > 0 && (
                <select
                  className="lc-select"
                  aria-label={options.skill ? 'Partir d’un autre skill' : 'Partir d’un skill'}
                  value=""
                  onChange={(e) => e.target.value && setWritten(skillMessage(e.target.value, task))}
                >
                  <option value="">{options.skill ? 'Un autre skill…' : 'Partir d’un skill…'}</option>
                  {templates.map((t) => (
                    <option key={t.name} value={t.name} title={summaryOf(t.description)}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <label className="field wide">
              <span className="sr-only">Premier message</span>
              <textarea
                className="lc-textarea lc-new-textarea"
                placeholder="Que doit faire Claude ?"
                value={message}
                onChange={(e) => setWritten(e.target.value)}
              />
            </label>
            {task && written === null && <span className="legend">Préparé depuis la tâche, modifiable.</span>}
          </section>

          <section className="lc-new-section" aria-labelledby="lc-new-settings">
            <h3 id="lc-new-settings">Réglages de départ</h3>
            <div className="lc-new-settings">
              <label className="field">
                Mode
                <select value={shownMode} onChange={(e) => setMode(modeOf(e.target.value)?.value ?? 'default')}>
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Modèle
                <select value={shownModel ?? DEFAULT} onChange={(e) => pickModel(e.target.value)}>
                  {modelOptions(models).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Effort
                <select
                  value={shownEffort ?? DEFAULT}
                  disabled={effortChoices.length < 2}
                  onChange={(e) => setEffort(effortOf(e.target.value))}
                >
                  {effortChoices.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <span className="legend">{modeOf(shownMode)?.hint}</span>
            {modelHint(models, shownModel) && <span className="legend">{modelHint(models, shownModel)}</span>}
          </section>
        </div>

        <div className="row">
          <span className="grow" />
          <button type="button" className="btn" onClick={() => done(null)}>
            Annuler
          </button>
          <button type="button" className="btn-cta" disabled={starting || !message.trim()} onClick={() => void start()}>
            {starting ? 'Lancement…' : options.skill ? 'Démarrer la tâche' : 'Lancer la session'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// The new session's id, or null when the window was closed without starting one.
export function openNewSession(options: Options = {}): Promise<string | null> {
  return new Promise((resolve) => {
    openDialog((close) => (
      <NewSession
        options={options}
        done={(id) => {
          close()
          resolve(id)
        }}
      />
    ))
  })
}
