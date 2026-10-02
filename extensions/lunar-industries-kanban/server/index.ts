import type { ServerContext } from '@bidule/api/extensions'
// Its roles' types only: erased once compiled (the app has no @bidule/ext-git package to load at run time).
import type {} from '@bidule/ext-git/contract'
import '../contract.ts'
import { KanbanService } from './service.ts'

// For the controller, once started (its page's first request starts it).
export let service: KanbanService

export function activate(ctx: ServerContext) {
  // The git role is optional (`uses`): without it, the board shows no branch.
  service = new KanbanService(async () => (ctx.has('git') ? ctx.use('git') : null))
}
