import type { ServerContext } from '@bidule/api/extensions'
import '../contract.ts'
import { ContainerCli } from './cli.ts'
import { ContainerService } from './service.ts'

// For the controller, once started (its page's first request starts it).
export let service: ContainerService
export let prepare: ServerContext['terminal']['prepare']

export async function activate(ctx: ServerContext) {
  // Both engines, by their command line: a missing one simply lists nothing.
  service = new ContainerService(
    [new ContainerCli('podman', 'Podman'), new ContainerCli('docker', 'Docker')],
    () => void ctx.events.emit('lunar-industries-containers.changed', {}),
    () => ctx.dataDir()
  )
  prepare = (launch) => ctx.terminal.prepare(launch)
}
