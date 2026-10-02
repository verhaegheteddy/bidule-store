import type { ServerContext } from '@bidule/api/extensions'
// Its roles' types only: erased once compiled (the app has no @bidule/ext-git package to load at run time).
import type {} from '@bidule/ext-git/contract'
import '../contract.ts'
import { Days } from './days.ts'
import { readSettings } from './settings.ts'
import { DbStore } from './store.ts'

// For the controller, once started (its page's first request starts it).
export let days: Days

export async function activate(ctx: ServerContext) {
  days = new Days({
    store: new DbStore(ctx.db),
    settings: () => readSettings(ctx),
    git: () => ctx.use('git'),
    tasks: async () => (ctx.has('tasks') ? ctx.use('tasks') : null),
    timeLog: async () => (ctx.has('timeLog') ? ctx.use('timeLog') : null),
    changed: () => void ctx.events.emit('lunar-industries-temps.changed', {}),
  })
  // The work moved on: today's proposal follows (a draft the user changed stays theirs).
  const follow = () =>
    void days.follow().catch((error: Error) => ctx.logger.warn(`Lunar Industries - Temps : ${error.message}`))
  ctx.events.on('git.changed', follow)
  ctx.events.on('tasks.changed', follow)
}
