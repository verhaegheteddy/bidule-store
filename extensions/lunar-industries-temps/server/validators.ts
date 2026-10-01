import vine from '@vinejs/vine'

const day = () => vine.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const dayValidator = vine.create({
  params: vine.object({ day: day() }),
})

export const monthValidator = vine.create({
  params: vine.object({
    year: vine.number().withoutDecimals().min(2000).max(2100),
    month: vine.number().withoutDecimals().min(1).max(12),
  }),
})

// A day's lines, shares in twentieths of a day; the sum (20) and the uniqueness of (task, label) are checked by
// days.ts. The Time Log's other properties are all optional: an empty one is null.
export const draftValidator = vine.create({
  params: vine.object({ day: day() }),
  lines: vine.array(
    vine.object({
      taskId: vine.string().nullable(),
      label: vine.string().trim().maxLength(200),
      share: vine.number().withoutDecimals().min(0).max(20),
      confirmed: vine.boolean().optional(),
      repo: vine.string().nullable().optional(),
      branch: vine.string().nullable().optional(),
      props: vine.record(vine.any().nullable()).optional(),
    })
  ),
})

// A line without a task: attached to a task, or kept as such.
export const resolveValidator = vine.create({
  params: vine.object({ day: day(), id: vine.number().withoutDecimals() }),
  taskId: vine.string().trim().minLength(1).optional(),
  confirmed: vine.boolean().optional(),
})
