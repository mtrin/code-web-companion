import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { config } from './config.ts'

const SHUTDOWN_GRACE_MS = 3000

const { app, chats } = await createApp(config)

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`code-web-companion listening on http://${info.address}:${info.port}, reading ${config.projectsDir}`)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    chats.leaveAll()
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref()
  })
}
