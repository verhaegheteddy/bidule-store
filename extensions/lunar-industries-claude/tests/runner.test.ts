import { describe, expect, it } from 'vitest'
import { bundledCandidates, parseAuthStatus, pathInWsl, placeOf, sessionEnv, wslArgs, type ClaudeWsl } from '../server/runner.ts'

// Taken from quack-board (tests/unit/claude_runner.spec.ts, Simon's).

const ubuntu: ClaudeWsl = { distro: 'Ubuntu', home: '/home/me', claude: '/home/me/.local/bin/claude' }

describe('Claude runner · where Claude Code runs', () => {
  it('a folder of this machine runs the SDK’s own Claude Code', async () => {
    const place = await placeOf('/home/me/app', 'linux', async () => {
      throw new Error('WSL must not be asked')
    })
    expect(place).toEqual({ cwd: '/home/me/app', configDir: undefined, wsl: null, options: {} })
  })

  it('on Windows, a repo inside WSL runs the distro’s, in its Linux path', async () => {
    const place = await placeOf('\\\\wsl.localhost\\Ubuntu\\home\\me\\app', 'win32', async () => ubuntu)
    expect(place.cwd).toBe('/home/me/app')
    expect(place.configDir).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude')
    expect(place.options.pathToClaudeCodeExecutable).toBe(ubuntu.claude)
    expect(place.options.spawnClaudeCodeProcess).toBeTypeOf('function')
  })

  it('on Windows, a repo on the Windows side is refused', async () => {
    await expect(placeOf('C:\\dev\\app', 'win32', async () => ubuntu)).rejects.toThrow(/doivent être dans WSL/)
  })

  it('wsl.exe runs the distro’s claude with the SDK’s arguments and its variables only', () => {
    const args = wslArgs(ubuntu, '/home/me/app', {
      args: ['--output-format', 'stream-json'],
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', PATH: 'C:\\Windows', APPDATA: 'C:\\x', DEBUG: '1' },
    })
    expect(args).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '/home/me/app',
      '-e',
      'env',
      'CLAUDE_CODE_ENTRYPOINT=sdk-ts',
      'DEBUG=1',
      '/home/me/.local/bin/claude',
      '--output-format',
      'stream-json',
    ])
  })
})

describe('Claude runner · paths inside WSL', () => {
  it('a Windows path goes under /mnt, a folder of the distro keeps its Linux path', () => {
    expect(pathInWsl('C:\\Program Files\\Bidule\\resources\\plugin')).toBe('/mnt/c/Program Files/Bidule/resources/plugin')
    expect(pathInWsl('\\\\wsl.localhost\\Ubuntu\\home\\me\\plugin')).toBe('/home/me/plugin')
    expect(pathInWsl('/home/me/plugin')).toBe('/home/me/plugin')
  })
})

describe('Claude runner · environment and detection', () => {
  it('a session’s environment has no Claude Code variable and no API key', () => {
    const env = sessionEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ANTHROPIC_API_KEY: 'sk-x',
      ANTHROPIC_BASE_URL: 'https://proxy',
      HOME: '/home/me',
    })
    expect(env).toEqual({ PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://proxy', HOME: '/home/me' })
  })

  it('the SDK’s Claude Code is looked for in the package of the system', () => {
    expect(bundledCandidates('linux', 'x64')).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-x64/claude',
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude',
    ])
    expect(bundledCandidates('darwin', 'arm64')).toEqual(['@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'])
  })

  it('reads the login from `claude auth status`', () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', subscriptionType: 'pro' })
    expect(parseAuthStatus(out)).toEqual({ loggedIn: true, email: 'me@example.com', subscription: 'pro' })
    expect(parseAuthStatus('not json')).toEqual({ loggedIn: false, email: null, subscription: null })
  })
})
