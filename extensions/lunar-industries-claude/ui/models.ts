import { EFFORT_LEVELS, type SessionEffort, type SessionMode, type SessionModel } from '../contract.ts'

// Taken from quack-board (Simon's pages/claude/models.ts): modes, models and effort as the selects offer them.

export type Option = { value: string; label: string }

// What a skill does, in a few words: the first sentence of its description, without the details after a dash nor
// the « À utiliser quand… » written for Claude. The new session window and the / menu show it.
export function summaryOf(description: string): string {
  const sentence = description.split(/\.(\s|$)/)[0] ?? ''
  return (sentence.split(' - ')[0] ?? '').trim()
}

// What Claude may do without asking: the conversation and the new session window offer the same modes.
export const MODES: { value: SessionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Demander', hint: 'Claude demande avant chaque modification et chaque commande.' },
  { value: 'acceptEdits', label: 'Modifs auto', hint: 'Les modifications de fichiers passent ; les commandes demandent.' },
  { value: 'plan', label: 'Plan', hint: 'Claude lit et propose un plan, sans rien modifier.' },
  { value: 'auto', label: 'Auto', hint: 'Claude décide seul de ce qui est sûr et demande pour le reste.' },
  {
    value: 'bypassPermissions',
    label: 'Tout autoriser',
    hint: 'Claude fait tout sans demander, sauf pour les outils de l’app qui écrivent.',
  },
]

// A select's value, or a saved setting, as a mode; undefined for a value no mode has.
export const modeOf = (value: unknown) => MODES.find((m) => m.value === value)

const EFFORT_LABELS: Record<SessionEffort, string> = {
  low: 'Faible',
  medium: 'Moyen',
  high: 'Élevé',
  xhigh: 'Très élevé',
  max: 'Maximal',
}

// The empty value of the selects: Claude Code's default (the user's settings), sent as null.
export const DEFAULT = ''

// Claude Code lists its default model under the value `default`: the « Par défaut » option stands for it.
export function modelOptions(models: SessionModel[]): Option[] {
  return [
    { value: DEFAULT, label: 'Modèle par défaut' },
    ...models.filter((m) => m.value !== 'default').map((m) => ({ value: m.value, label: m.label })),
  ]
}

// The effort levels the model takes; for the default model, those of Claude Code's default.
export function effortsOf(models: SessionModel[], model: string | null): SessionEffort[] {
  return models.find((m) => m.value === (model ?? 'default'))?.efforts ?? []
}

export function effortOptions(models: SessionModel[], model: string | null): Option[] {
  return [
    { value: DEFAULT, label: 'Effort par défaut' },
    ...effortsOf(models, model).map((e) => ({ value: e, label: EFFORT_LABELS[e] })),
  ]
}

// A select's value as an effort: null for the default, or for a value no model has.
export const effortOf = (value: unknown): SessionEffort | null => EFFORT_LEVELS.find((e) => e === value) ?? null

export const modelHint = (models: SessionModel[], model: string | null) =>
  models.find((m) => m.value === (model ?? 'default'))?.description ?? ''
