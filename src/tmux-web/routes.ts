// HTTP routes for a terminal view of a tmux-web session: Server-Sent Events carry the screen and its output,
// POST routes carry typed input and the viewer's size. The app's host, origin and token checks apply to all of them.
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { TmuxWeb } from './server.ts'

const HEARTBEAT_MS = 20_000
const MAX_INPUT_BYTES = 64 * 1024
const COLS = { min: 20, max: 500 }
const ROWS = { min: 5, max: 200 }

export function tmuxRoutes(tmuxWeb: TmuxWeb): Hono {
  const app = new Hono()

  app.get('/:name/stream', async (c) => {
    const name = c.req.param('name')
    if (!(await tmuxWeb.has(name))) return c.json({ error: 'unknown tmux session' }, 404)
    const control = await tmuxWeb.control(name).catch((error: unknown) => error as Error)
    if (control instanceof Error) return c.json({ error: control.message }, 409)
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve()
      const send = (event: string, data: unknown) => {
        chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined)
      }
      // Output and size changes that arrive while the screen is captured are sent right after it, in order.
      const queued: [string, unknown][] = []
      let live = false
      const emit = (event: string, data: unknown) => (live ? send(event, data) : queued.push([event, data]))
      const offOutput = control.client.onOutput((bytes) => emit('output', { data: bytes.toString('base64') }))
      const offSize = control.client.onSize((cols, rows) => emit('size', { cols, rows }))
      let offExit: () => void = () => undefined
      const ended = new Promise<void>((resolve) => {
        stream.onAbort(resolve)
        offExit = control.client.onExit(() => {
          send('exit', {})
          resolve()
        })
      })
      const heartbeat = setInterval(() => send('ping', {}), HEARTBEAT_MS)
      try {
        const screen = await control.client.screen().catch(() => ({ bytes: Buffer.alloc(0), cols: 0, rows: 0 }))
        send('screen', { data: screen.bytes.toString('base64'), cols: screen.cols, rows: screen.rows })
        for (const [event, data] of queued.splice(0)) send(event, data)
        live = true
        await ended
        await chain
      } finally {
        clearInterval(heartbeat)
        offOutput()
        offSize()
        offExit()
        control.release()
      }
    })
  })

  app.post('/:name/input', async (c) => {
    const client = tmuxWeb.viewing(c.req.param('name'))
    if (!client) return c.json({ error: 'Open the terminal view before typing into it.' }, 409)
    const body = (await c.req.json().catch(() => ({}))) as { data?: unknown }
    const bytes = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : Buffer.alloc(0)
    if (!bytes.length || bytes.length > MAX_INPUT_BYTES) return c.json({ error: 'empty or oversized input' }, 400)
    try {
      await client.input(bytes)
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  })

  app.post('/:name/size', async (c) => {
    const client = tmuxWeb.viewing(c.req.param('name'))
    if (!client) return c.json({ error: 'Open the terminal view first.' }, 409)
    const body = (await c.req.json().catch(() => ({}))) as { cols?: unknown; rows?: unknown }
    const cols = clamp(body.cols, COLS)
    const rows = clamp(body.rows, ROWS)
    if (!cols || !rows) return c.json({ error: 'invalid size' }, 400)
    try {
      await client.resize(cols, rows)
      return c.json({ ok: true, cols, rows })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  })

  return app
}

function clamp(value: unknown, range: { min: number; max: number }): number {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number > 0 ? Math.min(range.max, Math.max(range.min, number)) : 0
}
