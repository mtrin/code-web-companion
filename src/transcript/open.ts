import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const VIEWER_ENTRYPOINT = 'sdk-ts'

export interface OpenSession {
  pid: number
  status: string
  entrypoint: string
  tmux: string
}

interface RegistryEntry {
  pid?: number
  sessionId?: string
  procStart?: string | number
  status?: string
  entrypoint?: string
  tmux?: string
}

export async function openSessions(registryDir: string): Promise<Map<string, OpenSession[]>> {
  const names = await readdir(registryDir).catch(() => [])
  const entries = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => liveEntry(path.join(registryDir, name))))
  const open = new Map<string, OpenSession[]>()
  for (const entry of entries) {
    if (!entry?.sessionId) continue
    const list = open.get(entry.sessionId) ?? []
    list.push(toOpen(entry))
    open.set(entry.sessionId, list)
  }
  return open
}

export async function openEntry(registryDir: string, pid: number, sessionId: string): Promise<OpenSession | undefined> {
  const entry = await liveEntry(path.join(registryDir, `${pid}.json`))
  return entry?.sessionId === sessionId ? toOpen(entry) : undefined
}

function toOpen(entry: RegistryEntry): OpenSession {
  return { pid: entry.pid ?? 0, status: entry.status ?? 'unknown', entrypoint: entry.entrypoint ?? '', tmux: entry.tmux ?? '' }
}

async function liveEntry(file: string): Promise<RegistryEntry | undefined> {
  const entry = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as RegistryEntry)
    .catch(() => undefined)
  if (!entry?.pid) return undefined
  const comm = await readFile(`/proc/${entry.pid}/comm`, 'utf8').catch(() => '')
  if (comm.trim() !== 'claude') return undefined
  if (entry.procStart != null) {
    const stat = await readFile(`/proc/${entry.pid}/stat`, 'utf8').catch(() => '')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    if (fields[19] !== String(entry.procStart)) return undefined
  }
  return entry
}
