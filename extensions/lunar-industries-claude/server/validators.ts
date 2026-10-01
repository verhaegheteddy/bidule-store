import vine from '@vinejs/vine'
import { EFFORT_LEVELS, IMAGE_TYPES, PERMISSION_MODES } from '../contract.ts'

// Images and text files a message carries (the interface reads them; ~10 Mo of base64 at most each).
const attachments = {
  images: vine
    .array(vine.object({ name: vine.string().maxLength(255), mediaType: vine.enum(IMAGE_TYPES), data: vine.string().maxLength(14_000_000) }))
    .maxLength(10)
    .optional(),
  files: vine
    .array(vine.object({ name: vine.string().maxLength(255), text: vine.string().maxLength(1_000_000) }))
    .maxLength(10)
    .optional(),
}

export const startValidator = vine.create({
  repos: vine.array(vine.string().trim().minLength(1)).distinct(),
  prompt: vine.string().trim().maxLength(100_000),
  mode: vine.enum(PERMISSION_MODES),
  model: vine.string().trim().minLength(1).nullable().optional(),
  effort: vine.enum(EFFORT_LEVELS).nullable().optional(),
  resume: vine.string().trim().minLength(1).optional(),
  taskId: vine.string().trim().minLength(1).nullable().optional(),
  cwd: vine.string().trim().minLength(1).optional(),
  ...attachments,
})

export const eventsValidator = vine.create({
  after: vine.number().min(0).optional(),
  cwd: vine.string().trim().minLength(1).optional(),
})

export const contextValidator = vine.create({
  cwd: vine.string().trim().minLength(1).optional(),
})

export const messageValidator = vine.create({
  text: vine.string().trim().maxLength(100_000).optional(),
  ...attachments,
})

export const decisionValidator = vine.create({
  allow: vine.boolean(),
  always: vine.boolean().optional(),
  answers: vine.record(vine.string()).optional(),
  message: vine.string().trim().maxLength(10_000).optional(),
})

export const modeValidator = vine.create({ mode: vine.enum(PERMISSION_MODES) })
export const modelValidator = vine.create({ model: vine.string().trim().minLength(1).nullable() })
export const effortValidator = vine.create({ effort: vine.enum(EFFORT_LEVELS).nullable() })
export const archiveValidator = vine.create({ archived: vine.boolean() })

export const taskValidator = vine.create({
  taskId: vine.string().trim().minLength(1).nullable(),
  cwd: vine.string().trim().minLength(1).optional(),
})

export const watchValidator = vine.create({ cwd: vine.string().trim().minLength(1).optional() })
