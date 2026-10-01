import { describe, expect, it } from 'vitest'
import { mergeLogs, parseDetail, parseListing, parseStats } from '../server/cli.ts'
import { parseLine } from './format.ts'

// Taken from quack-board (tests/unit/containers.spec.ts, Simon's): what the engines print, read.
describe('Lunar Industries - Conteneurs', () => {
  it('reads what the running containers use', () => {
    expect(parseStats('3f2a9c1b7d4e|0.50%|21.5MiB / 7.6GiB\nbad\n')).toEqual([
      { id: '3f2a9c1b7d4e', cpu: 0.5, memory: Math.round(21.5 * 1024 ** 2), limit: Math.round(7.6 * 1024 ** 3) },
    ])
  })

  it('lists a folder, folders first', () => {
    expect(parseListing('b.txt\nusr/\na.txt\netc/\n')).toEqual([
      { name: 'etc', directory: true },
      { name: 'usr', directory: true },
      { name: 'a.txt', directory: false },
      { name: 'b.txt', directory: false },
    ])
  })

  it('orders stdout and stderr by their time', () => {
    expect(mergeLogs('2026-10-01T07:00:02Z b\n2026-10-01T07:00:00Z a', '2026-10-01T07:00:01Z err')).toEqual([
      '2026-10-01T07:00:00Z a',
      '2026-10-01T07:00:01Z err',
      '2026-10-01T07:00:02Z b',
    ])
  })

  it('reads one container with its networks and mounts', () => {
    const d = parseDetail(
      JSON.stringify([
        {
          Id: 'abc123',
          Name: '/web',
          Created: '2026-09-30T10:00:00Z',
          Config: { Image: 'nginx', Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web' } },
          State: { Status: 'running', StartedAt: '2026-10-01T07:00:00Z' },
          NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, Networks: { shop_default: {} } },
          Mounts: [{ Name: 'data', Source: '/var/lib/x', Destination: '/data' }],
        },
      ]),
    )
    expect(d).toMatchObject({
      name: 'web',
      project: 'shop',
      service: 'web',
      createdAt: '2026-09-30T10:00:00.000Z',
      networks: ['shop_default'],
      mounts: [{ name: 'data', source: '/var/lib/x', destination: '/data' }],
      ports: [{ hostIp: null, hostPort: 8080, port: 80, protocol: 'tcp' }],
    })
  })

  it('reads a log line: its time, its text, its level', () => {
    const l = parseLine('2026-10-01T07:12:03.114000000Z ERROR boom')
    expect(l).toMatchObject({ stamp: '2026-10-01T07:12:03.114000000Z', text: 'ERROR boom', level: 'error' })
    expect(parseLine('sans heure')).toMatchObject({ stamp: '', time: '', text: 'sans heure', level: null })
  })
})
