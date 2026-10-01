import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudePlace } from '../contract.ts'
import { parseWslPath, wslPath } from './wsl.ts'

/**
 * Taken from quack-board (connectors/claude_runner.ts, Simon's): where Claude Code runs for a folder. On Windows, the
 * repos live in WSL and get the distro's own Claude Code, run through wsl.exe like its git: Linux paths and tools,
 * and the login made in the distro. Elsewhere (the Flatpak included), the Claude Code the SDK ships for this system.
 */

export interface ClaudeWsl {
  distro: string
  home: string
  // Absolute path of `claude` in the distro.
  claude: string
}

export interface Place {
  // The session's folder, as Claude Code sees it (a Linux path inside WSL).
  cwd: string
  // Where its sessions are saved, as this process reaches it; undefined: this machine's ~/.claude.
  configDir: string | undefined
  wsl: ClaudeWsl | null
  // What the SDK needs to run that Claude Code.
  options: Pick<Options, 'pathToClaudeCodeExecutable' | 'spawnClaudeCodeProcess'>
}

// `claude` lives in a folder the user's shell adds to PATH (~/.local/bin): asked to their interactive login shell.
// The last line of its output is the answer (an interactive shell may print a banner first).
const LOOKUP = `shell=$(getent passwd "$(id -un)" | cut -d: -f7)
found=$("\${shell:-sh}" -ilc 'command -v claude' </dev/null 2>/dev/null | tail -n 1)
[ -x "$found" ] || found="$HOME/.local/bin/claude"
printf '%s\\n%s\\n%s\\n' "$found" "$HOME" "$WSL_DISTRO_NAME"
`

const found = new Map<string, Promise<ClaudeWsl>>()

// distro: empty for WSL's default one.
export function claudeInWsl(distro = ''): Promise<ClaudeWsl> {
  let lookup = found.get(distro)
  if (!lookup) {
    lookup = new Promise<ClaudeWsl>((resolve, reject) => {
      const child = execFile(
        'wsl.exe',
        [...(distro ? ['-d', distro] : []), '-e', 'sh', '-s'],
        { timeout: 30_000, windowsHide: true },
        (err, stdout) => {
          const [claude, home, name] = stdout.replace(/\r/g, '').trim().split('\n').slice(-3)
          if (err || !claude || !home || !name) reject(new Error(`Claude Code introuvable dans WSL${distro ? ` (${distro})` : ''}`))
          else resolve({ distro: name, home, claude })
        }
      )
      child.stdin?.end(LOOKUP)
    })
    found.set(distro, lookup)
    // A failure (WSL stopped, claude not installed yet) is looked up again next time.
    lookup.catch(() => found.delete(distro))
  }
  return lookup
}

// The distro's Claude Code folder, as Windows reaches it: where its sessions are saved.
export const configDirOf = (wsl: ClaudeWsl) => wslPath(wsl.distro, `${wsl.home}/.claude`)

/**
 * The environment of a session's Claude Code: this process's, without what would change who pays or where it runs.
 * Claude Code refuses to start inside another Claude Code session (the app may be launched from one), and an API key
 * would bill the use instead of the user's subscription.
 */
export function sessionEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith('CLAUDE') || key === 'ANTHROPIC_API_KEY') continue
    out[key] = value
  }
  return out
}

// Only the variables the SDK sets for Claude Code reach the distro: Windows' own would mislead it.
const FORWARDED = /^(CLAUDE|ANTHROPIC|MCP_|DISABLE_|ENABLE_|DEBUG)/

// wsl.exe's arguments: the distro's `claude` run in `linuxCwd`, with the SDK's arguments and variables.
export function wslArgs(wsl: ClaudeWsl, linuxCwd: string, options: Pick<SpawnOptions, 'args' | 'env'>) {
  const env = Object.entries(options.env)
    .filter(([key, value]) => value !== undefined && FORWARDED.test(key))
    .map(([key, value]) => `${key}=${value}`)
  return ['-d', wsl.distro, '--cd', linuxCwd, '-e', 'env', ...env, wsl.claude, ...options.args]
}

// For the SDK's `spawnClaudeCodeProcess`: the distro's `claude` with the same arguments; the SDK talks to it through
// stdin and stdout, which wsl.exe relays.
function spawnInWsl(wsl: ClaudeWsl, linuxCwd: string) {
  return (options: SpawnOptions): SpawnedProcess =>
    spawn('wsl.exe', wslArgs(wsl, linuxCwd, options), {
      // stderr is not read: left piped, a chatty Claude Code would fill it and block.
      stdio: ['pipe', 'pipe', 'ignore'],
      signal: options.signal,
      windowsHide: true,
    })
}

// Where a folder's Claude Code runs and keeps its sessions.
export async function placeOf(
  folder: string,
  platform: NodeJS.Platform = process.platform,
  lookup: (distro: string) => Promise<ClaudeWsl> = claudeInWsl
): Promise<Place> {
  if (platform !== 'win32') return { cwd: folder, configDir: undefined, wsl: null, options: {} }
  const inWsl = parseWslPath(folder)
  if (!inWsl) throw new Error(`Sous Windows, les dépôts doivent être dans WSL : ${folder}`)
  const wsl = await lookup(inWsl.distro)
  return {
    cwd: inWsl.linux,
    configDir: configDirOf(wsl),
    wsl,
    options: { pathToClaudeCodeExecutable: wsl.claude, spawnClaudeCodeProcess: spawnInWsl(wsl, inWsl.linux) },
  }
}

// A path of this machine as a WSL distro sees it: a Windows drive under /mnt, a folder of the distro by its Linux path.
export function pathInWsl(path: string): string {
  const inWsl = parseWslPath(path)
  if (inWsl) return inWsl.linux
  const drive = path.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!drive) return path
  return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
}

// The packages that may hold the Claude Code the SDK ships, in the order the SDK tries them.
export function bundledCandidates(platform: NodeJS.Platform, arch: string): string[] {
  const base = '@anthropic-ai/claude-agent-sdk'
  const names = platform === 'linux' ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`] : [`${base}-${platform}-${arch}`]
  return names.map((n) => `${n}/claude${platform === 'win32' ? '.exe' : ''}`)
}

// The Claude Code the SDK runs on this machine, or null when its package is missing.
export function bundledClaude(): string | null {
  const require = createRequire(import.meta.url)
  for (const candidate of bundledCandidates(process.platform, process.arch)) {
    try {
      return require.resolve(candidate)
    } catch {
      // Not installed for this libc or system.
    }
  }
  return null
}

// What `claude auth status` prints: a JSON object.
export function parseAuthStatus(stdout: string): Pick<ClaudePlace, 'loggedIn' | 'email' | 'subscription'> {
  try {
    const status = JSON.parse(stdout) as { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown }
    return {
      loggedIn: status.loggedIn === true,
      email: typeof status.email === 'string' ? status.email : null,
      subscription: typeof status.subscriptionType === 'string' ? status.subscriptionType : null,
    }
  } catch {
    return { loggedIn: false, email: null, subscription: null }
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, windowsHide: true, env: sessionEnv() }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.replace(/\r/g, '').trim())
    )
  })
}

async function statusOf(where: string, ask: (args: string[]) => Promise<string>): Promise<ClaudePlace> {
  try {
    // « 2.1.283 (Claude Code) »
    const version = (await ask(['--version'])).split(' ')[0] || null
    return { where, version, ...parseAuthStatus(await ask(['auth', 'status'])), error: null }
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).split('\n')[0]
    return { where, version: null, loggedIn: false, email: null, subscription: null, error }
  }
}

/**
 * The Claude Code the sessions run: the one the SDK ships for this machine, or on Windows the one of WSL's default
 * distro. Its version, and whether it is logged in. Nothing is sent to Claude.
 */
export async function detect(platform: NodeJS.Platform = process.platform): Promise<ClaudePlace[]> {
  if (platform === 'win32') {
    const wsl = await claudeInWsl().catch(() => null)
    return [
      await statusOf(wsl ? `WSL (${wsl.distro})` : 'WSL', async (args) => {
        const { distro, claude } = wsl ?? (await claudeInWsl())
        return run('wsl.exe', ['-d', distro, '-e', claude, ...args])
      }),
    ]
  }
  const local = bundledClaude()
  if (!local) {
    return [{ where: 'Ce poste', version: null, loggedIn: false, email: null, subscription: null, error: 'Le Claude Code du SDK manque pour ce système' }]
  }
  return [await statusOf('Ce poste', (args) => run(local, args))]
}
