import type { HttpContext } from '@adonisjs/core/http'
import { BranchesError } from '@bidule/ext-lunar-industries-branches/server/errors'
import { service } from '@bidule/ext-lunar-industries-branches/server/index'
import {
  branchValidator,
  linkValidator,
  reviewValidator,
  targetValidator,
} from '@bidule/ext-lunar-industries-branches/server/validators'

const ok = { ok: true as const }

// Taken from quack-board (Simon's board_controller and forge_controller): the branches, a branch's task, and what
// is done on its forge (every write confirmed first in the page).
export default class BranchesController {
  async index() {
    return service.list()
  }

  async links({ request }: HttpContext) {
    const { repo, name } = await request.validateUsing(branchValidator)
    return service.links(repo, name)
  }

  async jobs({ request }: HttpContext) {
    const { repo, name } = await request.validateUsing(branchValidator)
    return { jobs: await service.jobs(repo, name) }
  }

  async link({ request }: HttpContext) {
    const { repo, name, taskId } = await request.validateUsing(linkValidator)
    await service.link(repo, name, taskId)
    return ok
  }

  async pipeline({ request }: HttpContext) {
    const { repo, name } = await request.validateUsing(branchValidator)
    await service.runPipeline(repo, name)
    return ok
  }

  async retry({ request }: HttpContext) {
    const { repo, name } = await request.validateUsing(branchValidator)
    await service.retry(repo, name)
    return ok
  }

  async play({ params, request }: HttpContext) {
    const { repo, name } = await request.validateUsing(branchValidator)
    const id = Number(params.id)
    if (!Number.isInteger(id)) throw new BranchesError('Job inconnu', 404)
    await service.play(repo, name, id)
    return ok
  }

  async review({ request }: HttpContext) {
    const { repo, name, target } = await request.validateUsing(reviewValidator)
    await service.review(repo, name, target ?? null)
    return ok
  }

  async target({ request }: HttpContext) {
    const { repo, target } = await request.validateUsing(targetValidator)
    await service.setTarget(repo, target)
    return ok
  }
}
