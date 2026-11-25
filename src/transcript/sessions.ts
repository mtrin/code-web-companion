import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { isHumanPrompt, latestContext, parseLine, promptText, type RawRecord } from './parse.ts'
import { readWindow } from './reader.ts'
import type { SessionFile, SessionMeta } from './types.ts'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ARCHIVE_ENTRY = /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const HEAD_BYTES = 1024 * 1024
const TAIL_BYTES = 512 * 1024
const TITLE_CHARS = 120

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id)
}

export class SessionIndex {
  private readonly cache = new Map<string, SessionMeta>()
  private readonly projectsDir: string
  private readonly archiveDir: string
  private readonly limit: number

  constructor(projectsDir: string, archiveDir: string, limit: number) {
    this.projectsDir = projectsDir
    this.archiveDir = archiveDir
    this.limit = limit
  }

  async list(): Promise<SessionMeta[]> {
    const files = await this.scan()
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return Promise.all(files.slice(0, this.limit).map((file) => this.meta(file)))
  }

  async archived(): Promise<SessionMeta[]> {
    const files = await this.scanArchive()
    files.sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
    return Promise.all(files.slice(0, this.limit).map((file) => this.meta(file)))
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    if (!isSessionId(id)) return undefined
    const file = (await this.scan()).find((candidate) => candidate.id === id) ?? (await this.scanArchive()).find((candidate) => candidate.id === id)
    return file ? this.meta(file) : undefined
  }

  private async scan(): Promise<SessionFile[]> {
    const projects = await readdir(this.projectsDir, { withFileTypes: true })
    const groups = await Promise.all(
      projects.filter((entry) => entry.isDirectory()).map((entry) => this.scanProject(path.join(this.projectsDir, entry.name))),
    )
    return groups.flat()
  }

  private async scanProject(dir: string): Promise<SessionFile[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl') && isSessionId(entry.name.slice(0, -6)))
        .map((entry) => sessionFile(path.join(dir, entry.name), entry.name.slice(0, -6))),
    )
    return files.filter((file): file is SessionFile => Boolean(file))
  }

  private async scanArchive(): Promise<SessionFile[]> {
    const entries = await readdir(this.archiveDir, { withFileTypes: true }).catch(() => [])
    const files = await Promise.all(
      entries.map((entry) => {
        const match = entry.isDirectory() ? ARCHIVE_ENTRY.exec(entry.name) : null
        if (!match?.[1] || !match[2]) return undefined
        const archivedAt = new Date(Number(match[1])).toISOString()
        return sessionFile(path.join(this.archiveDir, entry.name, `${match[2]}.jsonl`), match[2], archivedAt)
      }),
    )
    return files.filter((file): file is SessionFile => Boolean(file))
  }

  private async meta(file: SessionFile): Promise<SessionMeta> {
    const cached = this.cache.get(file.path)
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached
    const head = (await readWindow(file.path, 0, HEAD_BYTES)).map(parseLine)
    const tail = file.size > HEAD_BYTES ? (await readWindow(file.path, file.size - TAIL_BYTES, TAIL_BYTES)).map(parseLine) : head
    const meta = { ...file, title: title(tail, head) || file.id, cwd: head.find((record) => record?.cwd)?.cwd ?? '', context: latestContext(tail) }
    this.cache.set(file.path, meta)
    return meta
  }
}

async function sessionFile(file: string, id: string, archivedAt?: string): Promise<SessionFile | undefined> {
  const info = await stat(file).catch(() => undefined)
  if (!info || info.size === 0) return undefined
  return { id, path: file, mtimeMs: info.mtimeMs, size: info.size, ...(archivedAt ? { archivedAt } : {}) }
}

function title(tail: (RawRecord | null)[], head: (RawRecord | null)[]): string {
  const named = (records: (RawRecord | null)[]) =>
    records.findLast((record) => record?.type === 'custom-title' && record.customTitle)?.customTitle ??
    records.findLast((record) => record?.type === 'agent-name' && record.agentName)?.agentName
  const prompt = head.find((record) => record && isHumanPrompt(record))
  const firstLine = prompt ? promptText(prompt).trim().split('\n')[0] ?? '' : ''
  return named(tail) ?? named(head) ?? firstLine.slice(0, TITLE_CHARS)
}
