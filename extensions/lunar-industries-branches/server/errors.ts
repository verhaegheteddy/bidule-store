import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

// What the module refuses (unknown branch, no forge, the forge's own refusal), as `{ error }` with its status.
export class BranchesError extends Exception {
  constructor(message: string, status = 422) {
    super(message, { status })
  }

  async handle(error: this, ctx: HttpContext) {
    ctx.response.status(error.status).send({ error: error.message })
  }
}
