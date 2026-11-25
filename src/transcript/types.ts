export type EntryKind = 'prompt' | 'reply' | 'output' | 'event'
export type EntryFormat = 'markdown' | 'plain'

export interface Entry {
  id: string
  kind: EntryKind
  ts: string
  label: string
  format: EntryFormat
  text: string
  note?: string
}

export interface RenderedEntry {
  seq: number
  id: string
  kind: EntryKind
  ts: string
  label: string
  lines: number
  html: string
  markdown: string
}

export interface SessionFile {
  id: string
  path: string
  mtimeMs: number
  size: number
  archivedAt?: string
}

export interface SessionMeta extends SessionFile {
  title: string
  cwd: string
  context: number
}
