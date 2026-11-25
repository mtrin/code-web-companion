import { randomBytes } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export const TOKEN_HEADER = 'x-viewer-token'

export function createToken(): string {
  return randomBytes(24).toString('base64url')
}

export function localOnly(token: string): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? ''
    if (!LOCAL_HOSTS.has(hostname(host))) return c.text('forbidden host', 403)
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin')
      if (!origin || origin !== `http://${host}`) return c.text('forbidden origin', 403)
      if (c.req.header(TOKEN_HEADER) !== token) return c.text('missing token', 403)
    }
    await next()
  }
}

function hostname(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  return host.split(':')[0] ?? ''
}
