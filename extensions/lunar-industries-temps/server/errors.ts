import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

// What the module refuses (a draft that cannot be sent, a line unknown), as `{ error }` with its status.
export class TempsError extends Exception {
  constructor(message: string, status = 422) {
    super(message, { status })
  }

  async handle(error: this, ctx: HttpContext) {
    ctx.response.status(error.status).send({ error: error.message })
  }
}
