import type { ServerContext } from '@bidule/api/extensions'

// The module's settings (bidule.json), read together.
export type TempsSettings = {
  // ISO numbers, 1 = Monday.
  workDays: Set<number>
  integrationBranches: string[]
  deployBranches: string[]
  defaultLabel: string
  absentLabel: string
  deployLabel: string
}

const K = 'lunar-industries-temps'

export const list = (value: unknown) =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

// Out-of-range values are left out; an empty list expects no day at all.
export const workDaysOf = (value: unknown) =>
  new Set(
    list(value)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
  )

export const DEFAULT_SETTINGS: TempsSettings = {
  workDays: new Set([1, 2, 3, 4, 5]),
  integrationBranches: ['main', 'master', 'develop', 'launchpad', 'factory', 'orbit'],
  deployBranches: ['launchpad', 'orbit'],
  defaultLabel: 'Développement',
  absentLabel: 'Absent',
  deployLabel: 'Déploiement',
}

export async function readSettings(ctx: ServerContext): Promise<TempsSettings> {
  const get = (key: string) => ctx.settings.get(`${K}.${key}`)
  const text = async (key: keyof TempsSettings, fallback: string) => String((await get(key)) ?? '').trim() || fallback
  const work = await get('workDays')
  return {
    workDays: work === undefined ? DEFAULT_SETTINGS.workDays : workDaysOf(work),
    integrationBranches: list((await get('integrationBranches')) ?? DEFAULT_SETTINGS.integrationBranches.join(', ')),
    deployBranches: list((await get('deployBranches')) ?? DEFAULT_SETTINGS.deployBranches.join(', ')),
    defaultLabel: await text('defaultLabel', DEFAULT_SETTINGS.defaultLabel),
    absentLabel: await text('absentLabel', DEFAULT_SETTINGS.absentLabel),
    deployLabel: await text('deployLabel', DEFAULT_SETTINGS.deployLabel),
  }
}
