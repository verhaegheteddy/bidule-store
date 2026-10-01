import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'

// What the module refuses (off, unknown session or repo, a session already ended), as `{ error }` with its status.
export class SessionError extends Exception {
  constructor(message: string, status = 409) {
    super(message, { status })
  }

  async handle(error: this, ctx: HttpContext) {
    ctx.response.status(error.status).send({ error: error.message })
  }
}
