import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { archiveSession, restoreSession } from './archive.ts'
import { serviceEnvironment } from './chat/launch.ts'
import { ChatRegistry } from './chat/registry.ts'
import type { Decision } from './chat/types.ts'
import type { Config } from './config.ts'
import { deleteSession } from './delete.ts'
import { logError } from './log.ts'
import { createRenderer } from './render/markdown.ts'
import { createToken, localOnly } from './security.ts'
import { tmuxRoutes } from './tmux-web/routes.ts'
import { TmuxWeb } from './tmux-web/server.ts'
import { FollowerPool, type FollowerEvent } from './transcript/follower.ts'
import { openSessions, VIEWER_ENTRYPOINT, type OpenSession } from './transcript/open.ts'
import { isSessionId, SessionIndex } from './transcript/sessions.ts'
import type { SessionMeta } from './transcript/types.ts'
import { readVersion } from './version.ts'

const HEARTBEAT_MS = 20_000
const MAX_MESSAGE_CHARS = 200_000

export interface Viewer {
  app: Hono
  chats: ChatRegistry
}

export async function createApp(config: Config): Promise<Viewer> {
  const index = new SessionIndex(config.projectsDir, config.archiveDir, config.sessionLimit)
  const pool = new FollowerPool(createRenderer({ wslDistro: config.wslDistro }), config.pollMs)
  const tmuxWeb = new TmuxWeb(config.tmuxBin, config.tmuxSocket, serviceEnvironment())
  const chats = new ChatRegistry(config, tmuxWeb)
  const token = createToken()
  const hljsCss = await readFile(createRequire(import.meta.url).resolve('highlight.js/styles/github-dark.css'), 'utf8')
  const publicDir = path.relative(process.cwd(), path.join(config.appRoot, 'public')) || '.'
  const version = await readVersion(config.appRoot)

  const describe = (meta: SessionMeta, open: Map<string, OpenSession[]>) => {
    const processes = open.get(meta.id) ?? []
    const elsewhere = processes.filter((entry) => entry.entrypoint !== VIEWER_ENTRYPOINT)
    return {
      id: meta.id,
      title: meta.title,
      cwd: config.hostHome && meta.cwd.startsWith(config.hostHome) ? `~${meta.cwd.slice(config.hostHome.length)}` : meta.cwd,
      updated: new Date(meta.mtimeMs).toISOString(),
      size: meta.size,
      archivedAt: meta.archivedAt ?? null,
      open: elsewhere.length ? (elsewhere.find((entry) => entry.status !== 'idle') ?? elsewhere[0])?.status ?? 'idle' : null,
      chat: chats.summary(meta.id),
      context: meta.context || null,
      window: config.contextWindow,
    }
  }

  const sessionFor = async (c: Context) => {
    const id = c.req.param('id') ?? ''
    return { id, meta: await index.get(id) }
  }

  const app = new Hono()
  app.use('*', localOnly(token))

  app.get('/healthz', (c) => c.text('ok'))
  app.get('/api/token', (c) => c.json({ token }))
  app.get('/api/version', (c) => c.json(version))

  app.get('/api/sessions', async (c) => {
    const [sessions, open] = await Promise.all([index.list(), openSessions(config.registryDir)])
    return c.json({ sessions: sessions.map((meta) => describe(meta, open)) })
  })

  app.get('/api/archived', async (c) => {
    const sessions = await index.archived()
    return c.json({ sessions: sessions.map((meta) => describe(meta, new Map())) })
  })

  app.get('/api/sessions/:id/events', async (c) => {
    const { id, meta } = await sessionFor(c)
    if (!meta) return c.json({ error: 'unknown session' }, 404)
    const follower = pool.acquire(meta.path)
    const open = await openSessions(config.registryDir)
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve()
      const send = (event: string, data: unknown) => {
        chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined)
      }
      const pending: FollowerEvent[] = []
      let live = false
      const unsubscribe = follower.subscribe((event) => (live ? send(event.type, event) : pending.push(event)))
      const unchat = chats.subscribe(id, (status) => send('chat', status))
      const heartbeat = setInterval(() => send('ping', {}), HEARTBEAT_MS)
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve))
      try {
        const { entries, context } = await follower.snapshot()
        send('snapshot', { meta: describe(meta, open), entries, context })
        send('chat', chats.status(id))
        live = true
        for (const event of pending) send(event.type, event)
        await closed
      } finally {
        clearInterval(heartbeat)
        unsubscribe()
        unchat()
      }
    })
  })

  app.post('/api/sessions/:id/archive', async (c) => {
    const { id, meta } = await sessionFor(c)
    if (!meta || meta.archivedAt) return c.json({ error: 'unknown or already archived session' }, 404)
    if (chats.joined().has(id)) return refuse(c, 'archive', 'Leave the chat before archiving it.')
    if ((await openSessions(config.registryDir)).has(id)) return refuse(c, 'archive', 'Close this session in its terminal before archiving it.')
    const result = await archiveSession(meta, config)
    if (!result.ok) logError('archive', id, result.message)
    return c.json(result, result.ok ? 200 : 409)
  })

  app.post('/api/sessions/:id/delete', async (c) => {
    const { id, meta } = await sessionFor(c)
    if (!meta) return c.json({ error: 'unknown session' }, 404)
    if (chats.joined().has(id)) return refuse(c, 'delete', 'Leave the chat before deleting it.')
    if ((await openSessions(config.registryDir)).has(id)) return refuse(c, 'delete', 'Close this session in its terminal before deleting it.')
    const result = await deleteSession(meta, config)
    if (!result.ok) logError('delete', id, result.message)
    return result.ok ? c.json(result) : c.json({ error: result.message }, 409)
  })

  app.post('/api/sessions/:id/restore', async (c) => {
    const id = c.req.param('id')
    if (!isSessionId(id)) return c.json({ error: 'unknown session' }, 404)
    const result = await restoreSession(id, config)
    if (!result.ok) logError('unarchive', id, result.message)
    return c.json(result, result.ok ? 200 : 409)
  })

  app.post('/api/sessions/:id/chat/join', async (c) => {
    const { id, meta } = await sessionFor(c)
    if (!meta) return c.json({ error: 'unknown session' }, 404)
    if (meta.archivedAt) return c.json({ error: 'Unarchive this session before chatting in it.' }, 409)
    if (!meta.cwd) return c.json({ error: 'This session has no working folder to resume in.' }, 409)
    void chats.join(id, meta.cwd)
    return c.json(chats.status(id))
  })

  app.post('/api/sessions/:id/chat/leave', (c) => c.json(chats.leave(c.req.param('id'))))

  app.post('/api/sessions/:id/chat/messages', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text || text.length > MAX_MESSAGE_CHARS) return c.json({ error: 'empty or oversized message' }, 400)
    try {
      return c.json(await chats.send(c.req.param('id'), text))
    } catch (error) {
      return refuse(c, 'send', error)
    }
  })

  app.post('/api/sessions/:id/chat/interrupt', async (c) => {
    try {
      return c.json(await chats.interrupt(c.req.param('id')))
    } catch (error) {
      return refuse(c, 'stop', error)
    }
  })

  app.post('/api/sessions/:id/chat/asks/:askId', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { behavior?: unknown; answers?: unknown; message?: unknown }
    const decision = toDecision(body)
    if (!decision) return c.json({ error: 'invalid decision' }, 400)
    const ok = chats.respond(c.req.param('id'), c.req.param('askId'), decision)
    return ok ? c.json({ ok }) : c.json({ error: 'That request is no longer waiting.' }, 404)
  })

  app.route('/api/tmux', tmuxRoutes(tmuxWeb))

  app.get('/vendor/hljs.css', (c) => c.body(hljsCss, 200, { 'content-type': 'text/css; charset=utf-8' }))

  app.use(
    '/*',
    async (c, next) => {
      await next()
      c.header('cache-control', 'no-cache')
    },
    serveStatic({ root: publicDir }),
  )

  return { app, chats }
}

function refuse(c: Context, action: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  logError(action, c.req.param('id') ?? '', message)
  return c.json({ error: message }, 409)
}

function toDecision(body: { behavior?: unknown; answers?: unknown; message?: unknown }): Decision | undefined {
  if (body.behavior !== 'allow' && body.behavior !== 'deny') return undefined
  const decision: Decision = { behavior: body.behavior }
  if (typeof body.message === 'string') decision.message = body.message
  if (body.answers && typeof body.answers === 'object') {
    const answers = Object.entries(body.answers as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    decision.answers = Object.fromEntries(answers)
  }
  return decision
}
