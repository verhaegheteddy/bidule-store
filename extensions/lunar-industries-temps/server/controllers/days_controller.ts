import type { HttpContext } from '@adonisjs/core/http'
import { days } from '@bidule/ext-lunar-industries-temps/server/index'
import { DraftError } from '@bidule/ext-lunar-industries-temps/server/days'
import { TempsError } from '@bidule/ext-lunar-industries-temps/server/errors'
import {
  dayValidator,
  draftValidator,
  monthValidator,
  resolveValidator,
} from '@bidule/ext-lunar-industries-temps/server/validators'
import type { LineInput, Props } from '../../contract.ts'

// A refused edit is the user's to fix: its message says what is wrong.
async function edit(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (err) {
    if (err instanceof DraftError) throw new TempsError(err.message, 422)
    throw err
  }
}

// Taken from quack-board (DaysController, Simon's): the days, their drafts, sending them to the Time Log.
export default class DaysController {
  async show({ request }: HttpContext) {
    const { params } = await request.validateUsing(dayValidator)
    return days.view(params.day)
  }

  async recompute({ request }: HttpContext) {
    const { params } = await request.validateUsing(dayValidator)
    await days.recompute(params.day)
    return days.view(params.day)
  }

  async edit({ request }: HttpContext) {
    const { params } = await request.validateUsing(dayValidator)
    await days.edit(params.day)
    return days.view(params.day)
  }

  async absent({ request }: HttpContext) {
    const { params } = await request.validateUsing(dayValidator)
    await days.absent(params.day)
    return days.view(params.day)
  }

  async send({ request }: HttpContext) {
    const { params } = await request.validateUsing(dayValidator)
    await edit(() => days.send(params.day))
    return days.view(params.day)
  }

  async replace({ request }: HttpContext) {
    const { params, lines } = await request.validateUsing(draftValidator)
    const input: LineInput[] = lines.map((l) => ({ ...l, props: (l.props ?? {}) as Props }))
    await edit(() => days.replace(params.day, input))
    return days.view(params.day)
  }

  async discard({ request }: HttpContext) {
    const { params } = await request.validateUsing(dayValidator)
    await days.discard(params.day)
    return days.view(params.day)
  }

  async resolve({ request }: HttpContext) {
    const { params, ...change } = await request.validateUsing(resolveValidator)
    await edit(() => days.resolve(params.day, params.id, change))
    return days.view(params.day)
  }

  async week({ request }: HttpContext) {
    const { params } = await request.validateUsing(dayValidator)
    return { days: await days.week(params.day) }
  }

  async month({ request }: HttpContext) {
    const { params } = await request.validateUsing(monthValidator)
    return { days: await days.month(params.year, params.month) }
  }

  async summary() {
    return days.summary()
  }
}
