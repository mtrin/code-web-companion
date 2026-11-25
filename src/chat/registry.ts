import type { Config } from '../config.ts'
import { logError } from '../log.ts'
import { openSessions, VIEWER_ENTRYPOINT } from '../transcript/open.ts'
import { ChatHost } from './host.ts'
import { paneOf, TerminalLink } from './terminal.ts'
import type { ChatLink, ChatStatus, Decision } from './types.ts'

type Listener = (status: ChatStatus) => void

const SWEEP_MS = 60_000

export class ChatRegistry {
  private readonly links = new Map<string, ChatLink>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly last = new Map<string, { error: string; notice: string }>()
  private readonly logged = new Map<string, string>()
  private readonly config: Config

  constructor(config: Config) {
    this.config = config
    setInterval(() => this.sweep(), SWEEP_MS).unref()
  }

  joined(): Set<string> {
    return new Set(this.links.keys())
  }

  summary(id: string): Pick<ChatStatus, 'joined' | 'mode' | 'state' | 'leaving'> | null {
    const link = this.links.get(id)
    if (!link) return null
    const { joined, mode, state, leaving } = link.status()
    return { joined, mode, state, leaving }
  }

  status(id: string): ChatStatus {
    const last = this.last.get(id)
    return (
      this.links.get(id)?.status() ?? {
        joined: false,
        mode: 'headless',
        state: 'closed',
        leaving: false,
        draft: '',
        asks: [],
        error: last?.error ?? '',
        notice: last?.notice ?? '',
      }
    )
  }

  async join(id: string, cwd: string): Promise<ChatStatus> {
    const existing = this.links.get(id)
    if (existing) return existing.status()
    this.last.delete(id)
    const elsewhere = ((await openSessions(this.config.registryDir)).get(id) ?? []).filter((entry) => entry.entrypoint !== VIEWER_ENTRYPOINT)
    const terminal = elsewhere.find((entry) => paneOf(entry.tmux))
    if (elsewhere.length && !terminal) {
      this.last.set(id, { error: 'This session is open outside tmux, so the page cannot reach it. Close it there, then join again.', notice: '' })
      this.emit(id, this.status(id))
      return this.status(id)
    }
    const options = {
      id,
      config: this.config,
      publish: (status: ChatStatus) => this.emit(id, status),
      onClosed: () => {
        if (this.links.get(id) !== link) return
        this.links.delete(id)
        const status = link.status()
        this.last.set(id, { error: status.error, notice: status.notice })
        this.emit(id, this.status(id))
      },
    }
    const link: ChatLink = terminal
      ? new TerminalLink({ ...options, pid: terminal.pid, pane: paneOf(terminal.tmux) })
      : new ChatHost({ ...options, cwd })
    this.links.set(id, link)
    this.emit(id, link.status())
    try {
      await link.start()
    } catch (error) {
      this.links.delete(id)
      this.last.set(id, { error: error instanceof Error ? error.message : String(error), notice: '' })
      this.emit(id, this.status(id))
    }
    return this.status(id)
  }

  leave(id: string): ChatStatus {
    this.links.get(id)?.leave()
    return this.status(id)
  }

  async send(id: string, text: string): Promise<ChatStatus> {
    const link = this.require(id)
    await link.send(text)
    return link.status()
  }

  async interrupt(id: string): Promise<ChatStatus> {
    await this.require(id).interrupt()
    return this.status(id)
  }

  respond(id: string, askId: string, decision: Decision): boolean {
    return this.links.get(id)?.respond(askId, decision) ?? false
  }

  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(id, set)
    return () => {
      set.delete(listener)
      if (!set.size) this.listeners.delete(id)
    }
  }

  leaveAll(): void {
    for (const link of this.links.values()) link.leave()
  }

  private require(id: string): ChatLink {
    const link = this.links.get(id)
    if (!link) throw new Error('This chat is not joined.')
    return link
  }

  private emit(id: string, status: ChatStatus): void {
    if (!status.error) this.logged.delete(id)
    else if (this.logged.get(id) !== status.error) {
      this.logged.set(id, status.error)
      logError(`chat ${status.mode}`, id, status.error)
    }
    for (const listener of this.listeners.get(id) ?? []) listener(status)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, link] of this.links) {
      if (this.listeners.has(id) || link.busy) continue
      if (now - link.lastActivity > this.config.chatIdleMs) link.leave()
    }
  }
}
