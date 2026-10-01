import type { ServerContext } from '@bidule/api/extensions'
import '@bidule/ext-git/contract'
import '../contract.ts'
import { KanbanService } from './service.ts'

// For the controller, once started (its page's first request starts it).
export let service: KanbanService

export function activate(ctx: ServerContext) {
  // The git role is optional (`uses`): without it, the board shows no branch.
  service = new KanbanService(async () => (ctx.has('git') ? ctx.use('git') : null))
}
