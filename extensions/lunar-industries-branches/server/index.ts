import type { ServerContext } from '@bidule/api/extensions'
// Its roles' types only: erased once compiled (the app has no @bidule/ext-git package to load at run time).
import type {} from '@bidule/ext-git/contract'
import '../contract.ts'
import { BranchesService } from './service.ts'

// For the controller, once started (its page's first request starts it).
export let service: BranchesService

export async function activate(ctx: ServerContext) {
  service = new BranchesService({
    git: () => ctx.use('git'),
    tasks: async () => (ctx.has('tasks') ? ctx.use('tasks') : null),
    setting: (key) => ctx.settings.get(key),
    save: (key, value) => ctx.settings.set(key, value),
    changed: () => void ctx.events.emit('lunar-industries-branches.changed', {}),
  })
}
