import vine from '@vinejs/vine'

const branch = vine.object({ repo: vine.string().trim().minLength(1), name: vine.string().trim().minLength(1) })

export const branchesValidator = vine.create({ branches: vine.array(branch).maxLength(100) })

export const reviewValidator = vine.create({
  repo: vine.string().trim().minLength(1),
  name: vine.string().trim().minLength(1),
})
