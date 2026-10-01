import { describe, expect, test } from 'vitest'
import { BranchesError } from '../server/errors.ts'
import { branch, fakeForge, fakeGit, service, task } from './fakes.ts'

const app = '/r/app'
const all = () => [
  branch({ name: 'main', isDefault: true }),
  branch({ name: 'develop' }),
  branch({ name: '42-ecran-de-connexion', taskId: 't1' }),
  branch({ name: 'tsk-7-paiement' }),
]

describe('the listing', () => {
  test('without the default and integration branches, which are the repo’s targets; issues read from the names', async () => {
    const { git } = fakeGit(all(), fakeForge().client)
    const { s } = service(git, { settings: { 'lunar-industries-branches.hidden': 'main, develop', 'lunar-industries-branches.reviewTarget': 'develop' } })
    const l = await s.list()
    expect(l.branches.map((b) => b.name)).toEqual(['42-ecran-de-connexion', 'tsk-7-paiement'])
    expect(l.branches[0]).toMatchObject({ forge: 'gitlab', issueNumber: 42 })
    expect(l.branches[1].issueNumber).toBeNull()
    expect(l.repos).toEqual([{ path: app, label: 'app', forge: 'gitlab', targets: ['main', 'develop'], reviewTarget: null }])
    expect(l.defaultTarget).toBe('develop')
  })

  test('a repo without a forge (or its token) lists its branches without one', async () => {
    const { git } = fakeGit(all(), null)
    const l = await service(git).s.list()
    expect(l.branches.every((b) => b.forge === null)).toBe(true)
  })
})

describe('on the forge', () => {
  test('a draft review towards the repo’s target, titled after the task, closing the issue', async () => {
    const forge = fakeForge()
    const { git, syncs } = fakeGit(all(), forge.client)
    const { s } = service(git, { tasks: [task('t1', 'Écran de connexion')] })
    await s.setTarget(app, 'develop')
    await s.review(app, '42-ecran-de-connexion', null)
    expect(forge.reviews).toEqual([
      {
        source: '42-ecran-de-connexion',
        target: 'develop',
        title: 'Écran de connexion',
        description: 'Closes #42\n\nTâche : https://notion.so/t1',
        draft: true,
      },
    ])
    // git read again: the review and the CI follow.
    expect(syncs()).toBe(1)
  })

  test('without any target, the review is refused', async () => {
    const { git } = fakeGit(all(), fakeForge().client)
    await expect(service(git).s.review(app, 'tsk-7-paiement', null)).rejects.toThrow(/cible/)
  })

  test('the latest pipeline relaunched, its manual jobs, one played', async () => {
    const forge = fakeForge()
    const { git } = fakeGit(all(), forge.client)
    const { s } = service(git)
    await s.retry(app, 'tsk-7-paiement')
    expect((await s.jobs(app, 'tsk-7-paiement')).map((j) => j.id)).toEqual([7, 8])
    await s.play(app, 'tsk-7-paiement', 7)
    await s.runPipeline(app, 'tsk-7-paiement')
    expect(forge.calls).toEqual(['retry 99', 'jobs 99', 'play 7', 'run tsk-7-paiement'])
  })

  test('where the review, pipeline and issue are, read now', async () => {
    const { git } = fakeGit(all(), fakeForge().client)
    expect(await service(git).s.links(app, '42-ecran-de-connexion')).toEqual({
      reviewUrl: 'https://gitlab.com/team/app/-/merge_requests/12',
      pipelineUrl: 'https://gitlab.com/team/app/-/pipelines/99',
      issueUrl: 'https://gitlab.com/team/app/-/issues/42',
    })
  })

  test('a forge’s refusal keeps its words; a server error is a 502', async () => {
    const denied = Object.assign(new Error('GitLab refuse : le jeton doit pouvoir écrire'), { status: 403 })
    const down = Object.assign(new Error('GitLab 503'), { status: 503 })
    const refusing = fakeGit(all(), fakeForge({ runPipeline: async () => Promise.reject(denied) }).client)
    const failing = fakeGit(all(), fakeForge({ runPipeline: async () => Promise.reject(down) }).client)
    const one = service(refusing.git).s.runPipeline(app, 'tsk-7-paiement')
    await expect(one).rejects.toMatchObject({ status: 422, message: denied.message })
    await expect(service(failing.git).s.runPipeline(app, 'tsk-7-paiement')).rejects.toMatchObject({ status: 502 })
  })

  test('no forge, an unknown branch: said', async () => {
    const none = fakeGit(all(), null)
    await expect(service(none.git).s.runPipeline(app, 'tsk-7-paiement')).rejects.toThrow(/pas de remote/)
    const err = await service(fakeGit(all(), fakeForge().client).git)
      .s.links(app, 'nope')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BranchesError)
    expect(err).toMatchObject({ status: 404 })
  })
})

describe('the task and the target', () => {
  test('a branch linked through the git role, a target kept per repo and announced', async () => {
    const { git, links } = fakeGit(all(), null)
    const { s, saved, changed } = service(git)
    await s.link(app, 'tsk-7-paiement', 't1')
    await s.link(app, 'tsk-7-paiement', null)
    expect(links).toEqual([`${app} tsk-7-paiement t1`, `${app} tsk-7-paiement null`])
    await s.setTarget(app, 'main')
    expect(JSON.parse(saved['lunar-industries-branches.targets'])).toEqual({ [app]: 'main' })
    await s.setTarget(app, null)
    expect(JSON.parse(saved['lunar-industries-branches.targets'])).toEqual({})
    expect(changed()).toBe(2)
    await expect(s.setTarget('/elsewhere', 'main')).rejects.toMatchObject({ status: 404 })
  })
})
