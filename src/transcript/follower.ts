import { stat } from 'node:fs/promises'
import { Branches } from './branches.ts'
import { contextTokens, createEntryReader, parseLine } from './parse.ts'
import { readLines } from './reader.ts'
import type { Entry, RenderedEntry } from './types.ts'

export type FollowerEvent =
  | { type: 'append' | 'reset'; entries: RenderedEntry[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'context'; tokens: number }
type Listener = (event: FollowerEvent) => void
type Render = (entry: Entry, seq: number) => RenderedEntry
interface Item {
  record: string
  entry: RenderedEntry
}

const IDLE_DISPOSE_MS = 120_000

export class Follower {
  private items: Item[] = []
  private shown: RenderedEntry[] = []
  private usage: { record: string; tokens: number }[] = []
  private tokens = 0
  private readonly branches = new Branches()
  private read = createEntryReader()
  private offset = 0
  private seq = 0
  private busy = false
  private poller: NodeJS.Timeout | undefined
  private idle: NodeJS.Timeout | undefined
  private readonly listeners = new Set<Listener>()
  private readonly ready: Promise<unknown>
  readonly path: string
  private readonly render: Render
  private readonly pollMs: number
  private readonly onIdle: () => void

  constructor(path: string, render: Render, pollMs: number, onIdle: () => void) {
    this.path = path
    this.render = render
    this.pollMs = pollMs
    this.onIdle = onIdle
    this.ready = this.pump()
    this.idle = setTimeout(this.onIdle, IDLE_DISPOSE_MS)
  }

  async snapshot(): Promise<{ entries: RenderedEntry[]; context: number }> {
    await this.ready
    return { entries: this.shown.slice(), context: this.tokens }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    clearTimeout(this.idle)
    this.poller ??= setInterval(() => void this.tick(), this.pollMs)
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size) return
      clearInterval(this.poller)
      this.poller = undefined
      this.idle = setTimeout(this.onIdle, IDLE_DISPOSE_MS)
    }
  }

  dispose(): void {
    clearInterval(this.poller)
    clearTimeout(this.idle)
    this.listeners.clear()
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.ready
      for (const event of await this.pump()) for (const listener of this.listeners) listener(event)
    } catch {
      return
    } finally {
      this.busy = false
    }
  }

  private async pump(): Promise<FollowerEvent[]> {
    const { size } = await stat(this.path)
    const truncated = size < this.offset
    if (truncated) {
      this.offset = 0
      this.items = []
      this.usage = []
      this.branches.clear()
      this.read = createEntryReader()
    }
    if (size === this.offset && !truncated) return []
    this.offset = await readLines(this.path, this.offset, (line) => {
      const record = parseLine(line)
      if (!record) return
      this.branches.add(record)
      for (const entry of this.read(record)) this.items.push({ record: record.uuid ?? '', entry: this.render(entry, this.seq++) })
      const tokens = contextTokens(record)
      if (tokens) this.usage.push({ record: record.uuid ?? '', tokens })
    })
    const before = this.shown
    const live = this.branches.live()
    this.shown = this.items.filter((item) => live(item.record)).map((item) => item.entry)
    const events: FollowerEvent[] = truncated ? [{ type: 'reset', entries: this.shown.slice() }] : changes(before, this.shown)
    const tokens = this.usage.findLast((item) => live(item.record))?.tokens ?? 0
    if (tokens !== this.tokens) {
      this.tokens = tokens
      events.push({ type: 'context', tokens })
    }
    return events
  }
}

function changes(before: RenderedEntry[], after: RenderedEntry[]): FollowerEvent[] {
  const kept = new Set(after.map((entry) => entry.id))
  const known = new Set(before.map((entry) => entry.id))
  const removed = before.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id)
  const added = after.filter((entry) => !known.has(entry.id))
  const lastSeq = before.at(-1)?.seq ?? -1
  if (added.some((entry) => entry.seq <= lastSeq)) return [{ type: 'reset', entries: after.slice() }]
  const events: FollowerEvent[] = []
  if (removed.length) events.push({ type: 'remove', ids: removed })
  if (added.length) events.push({ type: 'append', entries: added })
  return events
}

export class FollowerPool {
  private readonly followers = new Map<string, Follower>()
  private readonly render: Render
  private readonly pollMs: number

  constructor(render: Render, pollMs: number) {
    this.render = render
    this.pollMs = pollMs
  }

  acquire(path: string): Follower {
    const existing = this.followers.get(path)
    if (existing) return existing
    const follower = new Follower(path, this.render, this.pollMs, () => {
      follower.dispose()
      this.followers.delete(path)
    })
    this.followers.set(path, follower)
    return follower
  }
}
