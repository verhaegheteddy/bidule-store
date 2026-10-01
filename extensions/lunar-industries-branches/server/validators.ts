import vine from '@vinejs/vine'

const branch = { repo: vine.string().trim().minLength(1), name: vine.string().trim().minLength(1) }

export const branchValidator = vine.create(branch)
export const linkValidator = vine.create({ ...branch, taskId: vine.string().trim().minLength(1).nullable() })
export const reviewValidator = vine.create({ ...branch, target: vine.string().trim().minLength(1).nullable().optional() })
export const targetValidator = vine.create({
  repo: vine.string().trim().minLength(1),
  target: vine.string().trim().minLength(1).nullable(),
})
