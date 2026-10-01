import type { ContainerPort, ContainerRow, UsageRow } from '../contract.ts'

// Taken from quack-board (core/containers.ts, core/format.ts): what the list and a container's view say of them.

export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

// A container in a list of several engines' (Docker and Podman may both run one with the same id).
export const keyOf = (c: { engine: string; id: string }) => `${c.engine}:${c.id}`

// Where an action applies: a container that runs (or is about to, or is paused) can be restarted or stopped.
export const isUp = (c: Pick<ContainerRow, 'state'>) =>
  c.state === 'running' || c.state === 'restarting' || c.state === 'paused'

// « à l'instant », « il y a 26 min », « il y a 2 j ».
export function relTime(at: string | null): string {
  if (!at) return '—'
  const min = Math.round((Date.now() - new Date(at).getTime()) / 60_000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  if (min < 24 * 60) return `il y a ${Math.round(min / 60)} h`
  return `il y a ${Math.round(min / (24 * 60))} j`
}

// « en marche depuis 3 h », « arrêté il y a 2 j · code 137 ».
export function statusOf(c: ContainerRow): string {
  switch (c.state) {
    case 'running':
      return c.startedAt ? `en marche ${relTime(c.startedAt).replace(/^il y a/, 'depuis')}` : 'en marche'
    case 'paused':
      return 'en pause'
    case 'restarting':
      return 'redémarre…'
    case 'created':
      return 'créé, jamais démarré'
    default: {
      const code = c.exitCode ? ` · code ${c.exitCode}` : ''
      return `arrêté${c.finishedAt ? ` ${relTime(c.finishedAt)}` : ''}${code}`
    }
  }
}

// Where a published port answers: a link for a running container's TCP port.
export function portUrl(c: ContainerRow, p: ContainerPort): string | null {
  if (c.state !== 'running' || p.protocol !== 'tcp' || !p.hostPort) return null
  const host = !p.hostIp || p.hostIp === '127.0.0.1' ? 'localhost' : p.hostIp.includes(':') ? `[${p.hostIp}]` : p.hostIp
  return `http://${host}:${p.hostPort}`
}

export function portLabel(p: ContainerPort): string {
  const inside = p.protocol === 'tcp' ? `${p.port}` : `${p.port}/${p.protocol}`
  return !p.hostPort || p.hostPort === p.port ? inside : `${p.hostPort} → ${inside}`
}

// What a container uses: the engine gives the short id, the list has the long one.
export const usageRowOf = (rows: readonly UsageRow[], c: Pick<ContainerRow, 'engine' | 'id'>) =>
  rows.find((r) => r.engine === c.engine && c.id.startsWith(r.id))

const oneDecimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
const twoDecimals = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 })

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} o`
  if (bytes < 1024 ** 2) return `${oneDecimal.format(bytes / 1024)} Ko`
  if (bytes < 1024 ** 3) return `${oneDecimal.format(bytes / 1024 ** 2)} Mo`
  return `${twoDecimals.format(bytes / 1024 ** 3)} Go`
}

// « 0,4 % », « 12 % ».
export const fmtPercent = (percent: number) => `${oneDecimal.format(percent)} %`

export type LogLine = { stamp: string; time: string; text: string; level: 'error' | 'warn' | null }

// A line of the logs begins with its time (`--timestamps`): « 2026-10-01T07:12:03.114000000Z message ».
export function parseLine(line: string): LogLine {
  const space = line.indexOf(' ')
  const stamp = space > 0 ? line.slice(0, space) : ''
  const at = stamp ? new Date(stamp) : null
  const valid = at !== null && !Number.isNaN(at.getTime())
  const text = valid ? line.slice(space + 1) : line
  const two = (n: number) => String(n).padStart(2, '0')
  return {
    stamp: valid ? stamp : '',
    time: valid ? `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.${String(at.getMilliseconds()).padStart(3, '0')}` : '',
    text,
    level: /\b(ERROR|FATAL|PANIC|CRITICAL)\b/.test(text) ? 'error' : /\b(WARN|WARNING)\b/.test(text) ? 'warn' : null,
  }
}
