import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import type {
  ContainerAction,
  ContainerDetail,
  ContainerFile,
  ContainerList,
  Usage,
} from '../contract.ts'
import type { ContainerCli } from './cli.ts'

// What the terminal runs (see TerminalLaunch in the core).
export type Launch = { argv: string[]; cwd: string }

export class ContainerError extends Exception {
  async handle(error: this, ctx: HttpContext) {
    ctx.response.status(error.status).send({ error: error.message })
  }
}

// What a container's id or name looks like (never an option: no leading `-`).
const CONTAINER = /^[\w][\w.-]{0,127}$/
const LOG_TAIL = 500

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Taken from quack-board (ContainerService, Simon's latest): the containers of every engine present (Docker,
 * Podman, or both). Once the page has asked for them, each engine's events are watched: every start, stop or removal
 * is told (`lunar-industries-containers.changed`). What they use, a container's logs and files are asked of the
 * engines only when the page asks (while it is open). A shell inside or the logs in the terminal are built here
 * from a known engine and a known container: the window never sends a command.
 */
export class ContainerService {
  #watching = new Map<string, () => void>()

  constructor(
    protected engines: ContainerCli[],
    protected changed: () => void,
    // The extension's folder in the app's data: the ticked containers are kept there.
    protected dataDir: () => Promise<string>
  ) {}

  async #present(): Promise<ContainerCli[]> {
    const present = await Promise.all(this.engines.map((e) => e.isConfigured().catch(() => false)))
    return this.engines.filter((_, i) => present[i])
  }

  async #engine(engineId: string): Promise<ContainerCli> {
    const engine = (await this.#present()).find((e) => e.id === engineId)
    if (!engine) throw new ContainerError('Moteur de conteneurs introuvable', { status: 404 })
    return engine
  }

  // A known engine, and an id that cannot pass for an option.
  async #target(engineId: string, id: string): Promise<ContainerCli> {
    if (!CONTAINER.test(id)) throw new ContainerError('Conteneur inconnu', { status: 404 })
    return this.#engine(engineId)
  }

  async list(): Promise<ContainerList> {
    const engines = await this.#present()
    const out: ContainerList = { engines: engines.map((e) => ({ id: e.id, name: e.name })), containers: [], errors: [] }
    await Promise.all(
      engines.map(async (e) => {
        this.#watch(e)
        try {
          for (const c of await e.list()) out.containers.push({ ...c, engine: e.id })
        } catch (err) {
          out.errors.push({ engine: e.name, message: messageOf(err) })
        }
      })
    )
    out.containers.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  async detail(engineId: string, id: string): Promise<ContainerDetail> {
    const engine = await this.#target(engineId, id)
    try {
      return { ...(await engine.detail(id)), engine: engine.id }
    } catch (err) {
      throw new ContainerError(messageOf(err), { status: 404 })
    }
  }

  async act(engineId: string, id: string, action: ContainerAction): Promise<void> {
    const engine = await this.#target(engineId, id)
    try {
      await engine.act(id, action)
    } catch (err) {
      throw new ContainerError(messageOf(err), { status: 422 })
    }
    // The events would say it too, but the page should not wait for them.
    this.changed()
  }

  // A shell in the container (bash where there is one, sh otherwise), or its last lines then what follows.
  async launch(engineId: string, id: string, kind: 'shell' | 'logs', home: string): Promise<Launch> {
    const engine = await this.#target(engineId, id)
    const argv =
      kind === 'logs'
        ? [engine.cli, 'logs', '--follow', '--tail', '500', id]
        : [engine.cli, 'exec', '-it', id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']
    return { argv, cwd: home }
  }

  // What the running containers use of the machine, every engine together: the machine is the biggest of the
  // engines' (Docker and Podman may share it), the containers are each engine's own.
  async usage(): Promise<Usage> {
    const out: Usage = { cpus: 0, memory: 0, containers: [] }
    await Promise.all(
      (await this.#present()).map(async (e) => {
        try {
          const u = await e.usage()
          out.cpus = Math.max(out.cpus, u.cpus)
          out.memory = Math.max(out.memory, u.memory)
          for (const c of u.containers) out.containers.push({ ...c, engine: e.id })
        } catch {
          // An engine that does not answer has the list's error; no numbers for it.
        }
      })
    )
    return out
  }

  async logs(engineId: string, id: string, since?: string): Promise<string[]> {
    const engine = await this.#target(engineId, id)
    try {
      return await engine.logs(id, { tail: LOG_TAIL, since })
    } catch (err) {
      throw new ContainerError(messageOf(err), { status: 422 })
    }
  }

  async files(engineId: string, id: string, path: string): Promise<ContainerFile[]> {
    const engine = await this.#target(engineId, id)
    try {
      return await engine.files(id, path)
    } catch (err) {
      throw new ContainerError(messageOf(err), { status: 422 })
    }
  }

  // The containers ticked (`engine:id`), kept in the extension's data: coming back, even after the app was closed,
  // the user finds them ticked.
  async selection(): Promise<string[]> {
    const file = join(await this.dataDir(), 'selection.json')
    if (!existsSync(file)) return []
    try {
      const keys = JSON.parse(await readFile(file, 'utf8')) as unknown
      return Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : []
    } catch {
      return []
    }
  }

  async select(keys: string[]): Promise<void> {
    const file = join(await this.dataDir(), 'selection.json')
    await writeFile(`${file}.tmp`, JSON.stringify(keys))
    await rename(`${file}.tmp`, file)
  }

  #watch(engine: ContainerCli): void {
    if (this.#watching.has(engine.id)) return
    this.#watching.set(
      engine.id,
      engine.watch(() => this.changed())
    )
  }

  stop(): void {
    for (const unwatch of this.#watching.values()) unwatch()
    this.#watching.clear()
  }
}
