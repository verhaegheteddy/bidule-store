// The paths of a repo inside WSL, as Windows reaches it (the same convention as the git extension's runner):
// \\wsl.localhost\Debian\home\simon (or the older \\wsl$\Debian\…) → Debian, /home/simon.
export function parseWslPath(path: string): { distro: string; linux: string } | null {
  const m = path.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i)
  if (!m) return null
  return { distro: m[1], linux: (m[2] ?? '\\').replace(/\\/g, '/').replace(/(.)\/$/, '$1') }
}

export const wslPath = (distro: string, linux: string) => `\\\\wsl.localhost\\${distro}${linux.replace(/\//g, '\\')}`
