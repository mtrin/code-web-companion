import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SessionMeta } from './transcript/types.ts'

export interface ArchiveResult {
  ok: boolean
  message: string
}

interface Move {
  from: string
  to: string
}

interface Folders {
  projectsDir: string
  archiveDir: string
}

const ENTRY = /^\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export function liveFiles(meta: SessionMeta, projectsDir: string): string[] | undefined {
  const file = path.resolve(meta.path)
  if (path.basename(file) !== `${meta.id}.jsonl` || path.dirname(path.dirname(file)) !== path.resolve(projectsDir)) return undefined
  return [file, file.slice(0, -'.jsonl'.length)]
}

export async function archiveSession(meta: SessionMeta, folders: Folders): Promise<ArchiveResult> {
  const files = liveFiles(meta, folders.projectsDir)
  if (!files) return { ok: false, message: 'This transcript is not where a session should be, so it was left alone.' }
  const entry = path.join(folders.archiveDir, `${Date.now()}-${meta.id}`)
  const moves: Move[] = []
  for (const from of files) if (await stat(from).catch(() => undefined)) moves.push({ from, to: path.join(entry, path.basename(from)) })
  const done: Move[] = []
  try {
    await mkdir(entry, { recursive: true })
    for (const move of moves) {
      await relocate(move.from, move.to)
      done.push(move)
    }
    await writeFile(path.join(entry, 'restore.json'), JSON.stringify({ sessionId: meta.id, moves, trashedAt: new Date().toISOString() }, null, 2))
    return { ok: true, message: `archived ${meta.id}` }
  } catch (error) {
    for (const move of done.reverse()) await relocate(move.to, move.from).catch(() => undefined)
    await rmdir(entry).catch(() => undefined)
    return { ok: false, message: `Archiving failed: ${describe(error)}` }
  }
}

export async function restoreSession(id: string, folders: Folders): Promise<ArchiveResult> {
  const names = await readdir(folders.archiveDir).catch(() => [])
  const name = names.filter((candidate) => ENTRY.exec(candidate)?.[1] === id).sort().at(-1)
  if (!name) return { ok: false, message: `${id} is not in the archive.` }
  const entry = path.join(folders.archiveDir, name)
  const record = (await readFile(path.join(entry, 'restore.json'), 'utf8')
    .then((text) => JSON.parse(text) as { moves?: Move[] })
    .catch(() => undefined)) ?? { moves: [] }
  const root = path.resolve(folders.projectsDir) + path.sep
  const moves = (record.moves ?? []).map((move) => ({ from: path.resolve(move.from), to: path.join(entry, path.basename(move.to)) }))
  if (!moves.length || moves.some((move) => !move.from.startsWith(root) || path.basename(move.from) !== path.basename(move.to)))
    return { ok: false, message: 'The archive record for this session does not point into the projects folder, so it was left alone.' }
  for (const move of moves) {
    if (await stat(move.from).catch(() => undefined)) return { ok: false, message: `${move.from} already exists, so the archived copy was left alone.` }
  }
  try {
    for (const move of moves) {
      await mkdir(path.dirname(move.from), { recursive: true })
      await relocate(move.to, move.from)
    }
    await rm(entry, { recursive: true })
    return { ok: true, message: `restored ${id}` }
  } catch (error) {
    return { ok: false, message: `Unarchiving stopped part way: ${describe(error)}` }
  }
}

async function relocate(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, preserveTimestamps: true })
    await rm(from, { recursive: true })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
