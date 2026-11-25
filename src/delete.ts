import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { liveFiles } from './archive.ts'
import type { SessionMeta } from './transcript/types.ts'

export interface DeleteResult {
  ok: boolean
  message: string
}

const MAX_CITE_BYTES = 2 * 1024 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules'])

export async function deleteSession(meta: SessionMeta, roots: { projectsDir: string; archiveDir: string; citeRoots: string[] }): Promise<DeleteResult> {
  const citedIn = await findCitation(meta.id.slice(0, 8), roots.citeRoots)
  if (citedIn) return { ok: false, message: `This session is cited in ${citedIn}, so deleting it would break that link. Archive it instead.` }
  const targets = meta.archivedAt ? archivedFiles(meta, roots.archiveDir) : liveFiles(meta, roots.projectsDir)
  if (!targets) return { ok: false, message: 'This transcript is not where a session should be, so it was left alone.' }
  for (const target of targets) {
    const info = await stat(target).catch(() => undefined)
    if (info) await rm(target, { recursive: info.isDirectory() })
  }
  return { ok: true, message: `deleted ${meta.id}` }
}

function archivedFiles(meta: SessionMeta, archiveDir: string): string[] | undefined {
  const dir = path.dirname(path.resolve(meta.path))
  if (path.dirname(dir) !== path.resolve(archiveDir) || !new RegExp(`^\\d+-${meta.id}$`).test(path.basename(dir))) return undefined
  return [dir]
}

async function findCitation(needle: string, roots: string[]): Promise<string | undefined> {
  for (const root of roots) {
    for (const file of await textFiles(root)) {
      const text = await readFile(file, 'utf8').catch(() => '')
      if (text.includes(needle)) return file
    }
  }
  return undefined
}

async function textFiles(root: string): Promise<string[]> {
  const info = await stat(root).catch(() => undefined)
  if (!info) return []
  if (info.isFile()) return info.size <= MAX_CITE_BYTES ? [root] : []
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    if (path.relative(root, file).split(path.sep).some((part) => SKIP_DIRS.has(part))) continue
    const size = (await stat(file).catch(() => undefined))?.size ?? Infinity
    if (size <= MAX_CITE_BYTES) files.push(file)
  }
  return files
}
