import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { processLookup, type ProcessLookup } from '../processes.ts'

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
  const files = names.filter((name) => name.endsWith('.json'))
  const lookup = files.length ? await processLookup() : undefined
  const entries = lookup ? await Promise.all(files.map((name) => liveEntry(path.join(registryDir, name), lookup))) : []
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
  const entry = await liveEntry(path.join(registryDir, `${pid}.json`), await processLookup())
  return entry?.sessionId === sessionId ? toOpen(entry) : undefined
}

function toOpen(entry: RegistryEntry): OpenSession {
  return { pid: entry.pid ?? 0, status: entry.status ?? 'unknown', entrypoint: entry.entrypoint ?? '', tmux: entry.tmux ?? '' }
}

async function liveEntry(file: string, lookup: ProcessLookup): Promise<RegistryEntry | undefined> {
  const entry = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as RegistryEntry)
    .catch(() => undefined)
  if (!entry?.pid) return undefined
  const info = await lookup(entry.pid)
  if (!info?.claude) return undefined
  if (entry.procStart != null && info.started !== undefined && info.started !== String(entry.procStart)) return undefined
  return entry
}
