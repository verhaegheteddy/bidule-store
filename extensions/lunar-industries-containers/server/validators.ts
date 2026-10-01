import vine from '@vinejs/vine'
import { CONTAINER_ACTIONS } from '../contract.ts'

export const actionValidator = vine.create({
  action: vine.enum(CONTAINER_ACTIONS),
})

export const terminalValidator = vine.create({
  kind: vine.enum(['shell', 'logs'] as const),
})

// A folder inside the container, from its root.
export const filesValidator = vine.create({
  path: vine.string().startsWith('/').maxLength(4096),
})

// The lines written after this time (a line's own, as the engine gives it): the page follows the logs so.
export const logsValidator = vine.create({
  since: vine
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    .optional(),
})

// The containers ticked, as `engine:id`.
export const selectionValidator = vine.create({
  keys: vine.array(vine.string().maxLength(200)).maxLength(1000),
})
