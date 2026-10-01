import { createTuyau, TuyauHTTPError } from '@tuyau/core/client'
import { registry } from './registry/index.ts'

// Its routes, typed (ui/registry, generated from them).
export const api = createTuyau({ baseUrl: location.origin, registry, headers: { Accept: 'application/json' } }).api
  .ext.lunarIndustriesContainers

// What to tell the user: the API's `error`, else what went wrong.
export const message = (err: unknown) =>
  err instanceof TuyauHTTPError
    ? ((err.response as { error?: string })?.error ?? `Erreur ${err.status}`)
    : (err as Error).message
