// Lunar Industries - Conteneurs: Simon's containers module (quack-board), an unofficial one competing with Bidule's
// own (turn that one off to use this one). Its own id, page, event and data; the same `terminal` role for a shell or
// the logs. The types of what its routes answer, and its event.

export type ContainerState = 'running' | 'paused' | 'restarting' | 'created' | 'exited' | 'dead' | 'other'
// A published port: `hostPort` on the machine (null until a running container gets one assigned) to `port` inside.
export type ContainerPort = { hostIp: string | null; hostPort: number | null; port: number; protocol: string }
export type Container = {
  id: string
  name: string
  image: string
  state: ContainerState
  // ISO dates, null when the engine never recorded one.
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  // The Compose project and service it belongs to, if any: the page frames each project.
  project: string | null
  service: string | null
  ports: ContainerPort[]
}
// `remove` stops a running container first (`rm -f`); its volumes stay.
export const CONTAINER_ACTIONS = ['start', 'stop', 'restart', 'remove'] as const
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number]

// A container as the page lists it: with the engine it runs on.
export type ContainerRow = Container & { engine: string }
// Its own view: the same, with what it is made of.
export type ContainerDetail = ContainerRow & {
  createdAt: string | null
  networks: string[]
  mounts: { name: string | null; source: string; destination: string }[]
}
export type ContainerList = {
  engines: { id: string; name: string }[]
  containers: ContainerRow[]
  // An engine that is there but did not answer (its daemon stopped, say): the page says so.
  errors: { engine: string; message: string }[]
}

// What a running container uses, as `docker stats` counts it: `cpu` in percent of one core (so up to 100 times the
// number of cores), `memory` in bytes out of its `limit` (the machine's memory when it has none). `id` is the short
// one the engine prints (the first characters of the container's id).
export type UsageRow = { engine: string; id: string; cpu: number; memory: number; limit: number }
// What the machine has to give (`cpus` cores, `memory` bytes) and what the running containers take of it.
export type Usage = { cpus: number; memory: number; containers: UsageRow[] }

// An entry of a folder inside a container.
export type ContainerFile = { name: string; directory: boolean }

declare module '@bidule/sdk/contracts' {
  interface Events {
    // A container started, stopped, appeared or went (once the page has asked for the list).
    'lunar-industries-containers.changed': Record<string, never>
  }
}
