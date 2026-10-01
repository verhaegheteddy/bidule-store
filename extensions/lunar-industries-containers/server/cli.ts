// Taken from quack-board (apps/api/app/connectors/containers/container_cli.ts, Simon's latest), on the base of
// Bidule's official containers extension (its Flatpak handling).
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import type {
  Container,
  ContainerAction,
  ContainerDetail,
  ContainerFile,
  ContainerPort,
  ContainerState,
  UsageRow,
} from '../contract.ts'

// Inside the Flatpak sandbox, the engines live on the host. They run from the home folder: flatpak-spawn starts a
// command in the current folder, and the API's (inside /app) does not exist on the host.
const HOST = process.env['FLATPAK_ID'] ? ['flatpak-spawn', '--host'] : []
const HOME = homedir()

// A failed command, with what it printed before failing (inspect prints the containers it found).
class CommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string
  ) {
    super(message)
  }
}

// What a command prints on stdout, and on stderr too (a container's logs come out of both).
function run(cli: string, args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string }> {
  const [file, ...pre] = [...HOST, cli]
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...pre, ...args],
      { timeout, maxBuffer: 64 * 1024 * 1024, cwd: HOME },
      (err, stdout, stderr) =>
        err ? reject(new CommandError(stderr.trim() || err.message, stdout)) : resolve({ stdout, stderr })
    )
  })
}
const exec = async (cli: string, args: string[], timeout?: number) => (await run(cli, args, timeout)).stdout

// What `docker inspect` and `podman inspect` both give (Podman follows Docker's format), as far as the page needs.
type Bindings = Record<string, { HostIp?: string; HostPort?: string }[] | null> | null
type Inspected = {
  Id: string
  Name?: string
  IsInfra?: boolean
  Created?: string
  Config?: { Image?: string; Labels?: Record<string, string> | null }
  State?: { Status?: string; StartedAt?: string; FinishedAt?: string; ExitCode?: number }
  NetworkSettings?: { Ports?: Bindings; Networks?: Record<string, unknown> | null } | null
  Mounts?: { Name?: string | null; Source?: string; Destination?: string }[] | null
  HostConfig?: { PortBindings?: Bindings } | null
}

const STATES: ContainerState[] = ['running', 'paused', 'restarting', 'created', 'exited', 'dead']

// An engine's « never » is year 1 (0001-01-01T00:00:00Z).
function date(value: string | undefined): string | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1971 ? null : at.toISOString()
}

// `8008/tcp` → its bindings. Several per port (IPv4 and IPv6) show once; an address open to all is no address.
function ports(bindings: Bindings | undefined): ContainerPort[] {
  const out = new Map<string, ContainerPort>()
  for (const [key, list] of Object.entries(bindings ?? {})) {
    const [port, protocol = 'tcp'] = key.split('/')
    for (const b of list ?? []) {
      const hostPort = b.HostPort ? Number(b.HostPort) : null
      const hostIp = b.HostIp && !['0.0.0.0', '::', ''].includes(b.HostIp) ? b.HostIp : null
      const id = `${hostPort}/${port}/${protocol}`
      if (!out.has(id)) out.set(id, { hostIp, hostPort, port: Number(port), protocol })
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port || (a.hostPort ?? 0) - (b.hostPort ?? 0))
}

function toContainer(c: Inspected): Container {
  const labels = c.Config?.Labels ?? {}
  const status = c.State?.Status ?? ''
  const state: ContainerState = STATES.includes(status as ContainerState) ? (status as ContainerState) : 'other'
  // A running container has its actual ports (random ones included); a stopped one, only what it asks for.
  const live = state === 'running' ? ports(c.NetworkSettings?.Ports) : []
  return {
    id: c.Id,
    name: (c.Name ?? c.Id.slice(0, 12)).replace(/^\//, ''),
    image: c.Config?.Image ?? '',
    state,
    startedAt: date(c.State?.StartedAt),
    finishedAt: date(c.State?.FinishedAt),
    exitCode: state === 'exited' || state === 'dead' ? (c.State?.ExitCode ?? null) : null,
    project: labels['com.docker.compose.project'] ?? labels['io.podman.compose.project'] ?? null,
    service: labels['com.docker.compose.service'] ?? labels['io.podman.compose.service'] ?? null,
    ports: live.length ? live : ports(c.HostConfig?.PortBindings),
  }
}

// The containers of an inspect output, a pod's infra container (Podman) left out.
const inspected = (json: string) => (JSON.parse(json || '[]') as Inspected[]).filter((c) => !c.IsInfra)

export function parseInspect(json: string): Container[] {
  return inspected(json).map(toContainer)
}

// The one container an inspect output holds, with what it is made of: its networks and what is mounted in it.
export function parseDetail(json: string): Omit<ContainerDetail, 'engine'> {
  const [c] = inspected(json)
  if (!c) throw new Error('Conteneur introuvable')
  return {
    ...toContainer(c),
    createdAt: date(c.Created),
    networks: Object.keys(c.NetworkSettings?.Networks ?? {}).sort(),
    mounts: (c.Mounts ?? []).map((m) => ({ name: m.Name || null, source: m.Source ?? '', destination: m.Destination ?? '' })),
  }
}

// `21.5MiB`, `1.2GB`, `512kB` → bytes. Docker counts MiB as 1024 × 1024 and MB as 1000 × 1000.
const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  kib: 1024,
  mb: 1e6,
  mib: 1024 ** 2,
  gb: 1e9,
  gib: 1024 ** 3,
  tb: 1e12,
  tib: 1024 ** 4,
}
function bytes(text: string): number {
  const found = /^([\d.]+)\s*([a-z]*)$/i.exec(text.trim())
  const unit = UNITS[(found?.[2] ?? 'b').toLowerCase()]
  return found?.[1] && unit ? Math.round(Number(found[1]) * unit) : 0
}

// What `stats --no-stream --format '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}'` prints, a line a running container:
// `3f2a9c1b7d4e|0.50%|21.5MiB / 7.6GiB`. The ids are the short ones, the engine's `ps` gives the long ones.
export function parseStats(text: string): Omit<UsageRow, 'engine'>[] {
  const out: Omit<UsageRow, 'engine'>[] = []
  for (const line of text.split('\n')) {
    const [id, cpu, usage] = line.trim().split('|')
    if (!id || cpu === undefined || usage === undefined) continue
    const [memory = '', limit = ''] = usage.split('/')
    out.push({ id, cpu: Number.parseFloat(cpu) || 0, memory: bytes(memory), limit: bytes(limit) })
  }
  return out
}

// What `ls -1Ap` prints: a name a line, a `/` after a folder's. Folders come first, each group by name.
export function parseListing(text: string): ContainerFile[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => (l.endsWith('/') ? { name: l.slice(0, -1), directory: true } : { name: l, directory: false }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
}

// A line of a container's logs begins with its time (`--timestamps`), which orders what came out of stdout and
// stderr.
export function mergeLogs(...outputs: string[]): string[] {
  return outputs
    .flatMap((o) => o.split('\n'))
    .filter((l) => l.length > 0)
    .map((line, i) => ({ line, i }))
    .sort((a, b) => {
      const x = a.line.slice(0, 30)
      const y = b.line.slice(0, 30)
      return x < y ? -1 : x > y ? 1 : a.i - b.i
    })
    .map((l) => l.line)
}

/**
 * Docker and Podman through their command line, which both accept the same commands (`ps`, `inspect`, `start`,
 * `stats`, `logs`, `events`): one class, given the command. Only the user's own containers show (no sudo); a missing
 * command leaves the engine out.
 */
export class ContainerCli {
  #version: { at: number; value: Promise<string | null> } | null = null
  #host: Promise<{ cpus: number; memory: number }> | null = null

  constructor(
    readonly cli: 'docker' | 'podman',
    readonly name: string
  ) {}

  get id(): string {
    return this.cli
  }

  // The engine's version, or null without it. `docker` may be Podman's stand-in (podman-docker): that one is
  // already shown as Podman, so it counts as no Docker. Checked once a minute at most.
  version(): Promise<string | null> {
    if (this.#version && Date.now() - this.#version.at < 60_000) return this.#version.value
    const value = exec(this.cli, ['--version'], 5_000).then(
      (out) => (this.cli === 'docker' && /podman/i.test(out) ? null : out.trim()),
      () => null
    )
    this.#version = { at: Date.now(), value }
    return value
  }

  async isConfigured(): Promise<boolean> {
    return (await this.version()) !== null
  }

  async list(): Promise<Container[]> {
    const out = await exec(this.cli, ['ps', '-a', '-q', '--no-trunc'])
    const ids = out.split(/\s+/).filter(Boolean)
    if (!ids.length) return []
    // A container removed between the two commands makes inspect fail, but the others are still in its output.
    const json = await exec(this.cli, ['inspect', '--type', 'container', ...ids]).catch((err: unknown) => {
      if (err instanceof CommandError && err.stdout.trim()) return err.stdout
      throw err
    })
    return parseInspect(json)
  }

  async detail(id: string): Promise<Omit<ContainerDetail, 'engine'>> {
    return parseDetail(await exec(this.cli, ['inspect', '--type', 'container', id]))
  }

  async act(id: string, action: ContainerAction): Promise<void> {
    // A running container is stopped before it goes (`rm -f`); its volumes stay.
    await exec(this.cli, action === 'remove' ? ['rm', '-f', id] : [action, id], 60_000)
  }

  // The machine's cores and memory, which do not change while the engine runs: asked once.
  host(): Promise<{ cpus: number; memory: number }> {
    const format = this.cli === 'docker' ? '{{.NCPU}}|{{.MemTotal}}' : '{{.Host.CPUs}}|{{.Host.MemTotal}}'
    this.#host ??= exec(this.cli, ['info', '--format', format], 15_000).then(
      (out) => {
        const [cpus, memory] = out.trim().split('|')
        return { cpus: Number(cpus) || 0, memory: Number(memory) || 0 }
      },
      () => ({ cpus: 0, memory: 0 })
    )
    return this.#host
  }

  async usage(): Promise<{ cpus: number; memory: number; containers: Omit<UsageRow, 'engine'>[] }> {
    const [host, out] = await Promise.all([
      this.host(),
      exec(this.cli, ['stats', '--no-stream', '--format', '{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}'], 30_000),
    ])
    return { ...host, containers: parseStats(out) }
  }

  async files(id: string, path: string): Promise<ContainerFile[]> {
    // `ls` is given the path after `--`, so a folder named like an option is still a folder.
    return parseListing(await exec(this.cli, ['exec', id, 'ls', '-1Ap', '--', path]))
  }

  // The last `tail` lines, or those written after `since` (a line's own time: the page follows the logs so).
  async logs(id: string, options: { tail: number; since?: string }): Promise<string[]> {
    const from = options.since ? ['--since', options.since] : ['--tail', String(options.tail)]
    const { stdout, stderr } = await run(this.cli, ['logs', '--timestamps', ...from, id])
    return mergeLogs(stdout, stderr)
  }

  watch(onChange: () => void): () => void {
    let child: ChildProcess | null = null
    let stopped = false
    let debounce: NodeJS.Timeout | undefined
    let retry: NodeJS.Timeout | undefined
    const start = () => {
      const [file, ...pre] = [...HOST, this.cli]
      child = spawn(file, [...pre, 'events', '--format', '{{json .}}', '--filter', 'type=container'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: HOME,
      })
      // One change often comes as several events (create, start, attach…): they count once.
      child.stdout?.on('data', () => {
        clearTimeout(debounce)
        debounce = setTimeout(onChange, 300)
      })
      child.on('error', () => {})
      // The engine restarted, or the command died: listen again a little later.
      child.on('exit', () => {
        if (!stopped) retry = setTimeout(start, 10_000)
      })
    }
    start()
    return () => {
      stopped = true
      clearTimeout(debounce)
      clearTimeout(retry)
      child?.kill()
    }
  }
}
