import type { HttpContext } from '@adonisjs/core/http'
import { service } from '@bidule/ext-lunar-industries-kanban/server/index'
import { branchesValidator, reviewValidator } from '@bidule/ext-lunar-industries-kanban/server/validators'

// The cards' branches (git role): the list, a task's branches replaced, where a card's mark leads.
export default class KanbanController {
  async branches() {
    return service.branches()
  }

  async setBranches({ params, request }: HttpContext) {
    const { branches } = await request.validateUsing(branchesValidator)
    return service.setBranches(params.id, branches)
  }

  async review({ request }: HttpContext) {
    const ref = await request.validateUsing(reviewValidator)
    return { url: await service.reviewUrl(ref) }
  }
}
