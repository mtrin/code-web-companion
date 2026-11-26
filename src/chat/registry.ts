import type { Config } from '../config.ts'
import { logError } from '../log.ts'
import { tmuxRunner, type TmuxRun } from '../tmux-web/run.ts'
import type { TmuxWeb } from '../tmux-web/server.ts'
import { openSessions, VIEWER_ENTRYPOINT, type OpenSession } from '../transcript/open.ts'
import { ChatHost } from './host.ts'
import { shellEnvironment } from './launch.ts'
import { ancestors, paneOf, TerminalLink } from './terminal.ts'
import type { ChatLink, ChatStatus, Decision, LinkOptions } from './types.ts'

type Listener = (status: ChatStatus) => void

interface Server {
  run: TmuxRun
  pane: string
  terminal?: string
  attach?: string
}

const SWEEP_MS = 60_000
const START_POLL_MS = 500
const START_TIMEOUT_MS = 30_000
const START_COLS = 120
const START_ROWS = 40
const FAILED_LINES = 15

export class ChatRegistry {
  private readonly links = new Map<string, ChatLink>()
  private readonly starting = new Map<string, { terminal: string; attach: string }>()
  private readonly startups = new Map<string, Promise<ChatStatus>>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly last = new Map<string, { error: string; notice: string }>()
  private readonly logged = new Map<string, string>()
  private readonly config: Config
  private readonly tmuxWeb: TmuxWeb
  private readonly defaultTmux: TmuxRun

  constructor(config: Config, tmuxWeb: TmuxWeb) {
    this.config = config
    this.tmuxWeb = tmuxWeb
    this.defaultTmux = tmuxRunner(config.tmuxBin)
    setInterval(() => this.sweep(), SWEEP_MS).unref()
  }

  joined(): Set<string> {
    return new Set([...this.links.keys(), ...this.starting.keys()])
  }

  summary(id: string): Pick<ChatStatus, 'joined' | 'mode' | 'state' | 'leaving'> | null {
    if (!this.links.has(id) && !this.starting.has(id)) return null
    const { joined, mode, state, leaving } = this.status(id)
    return { joined, mode, state, leaving }
  }

  status(id: string): ChatStatus {
    const link = this.links.get(id)
    if (link) return link.status()
    const starting = this.starting.get(id)
    const last = this.last.get(id)
    return {
      joined: Boolean(starting),
      mode: starting ? 'terminal' : 'headless',
      state: starting ? 'starting' : 'closed',
      leaving: false,
      draft: '',
      asks: [],
      error: last?.error ?? '',
      notice: last?.notice ?? '',
      ...(starting ? { where: 'Starting Claude in tmux-web.', ...starting } : {}),
    }
  }

  async join(id: string, cwd: string): Promise<ChatStatus> {
    const existing = this.links.get(id)
    if (existing) return existing.status()
    if (this.starting.has(id)) return this.status(id)
    this.last.delete(id)
    const elsewhere = await this.openElsewhere(id)
    const terminal = elsewhere.find((entry) => paneOf(entry.tmux))
    if (terminal) {
      const server = await this.serverOf(terminal)
      return this.connect(id, (options) => new TerminalLink({ ...options, pid: terminal.pid, ...server }))
    }
    if (elsewhere.length) {
      const next = this.config.headlessChat ? 'join again.' : 'join again: it reopens in tmux.'
      this.last.set(id, { error: `This session is open in a terminal outside tmux, so the page cannot reach it. Exit it there, then ${next}`, notice: '' })
      this.emit(id, this.status(id))
      return this.status(id)
    }
    if (this.config.headlessChat) return this.connect(id, (options) => new ChatHost({ ...options, cwd }))
    const startup = this.startInTmuxWeb(id, cwd).finally(() => this.startups.delete(id))
    this.startups.set(id, startup)
    return startup
  }

  // Resumes a closed session inside tmux-web, waits for Claude Code to register it, then links to its pane.
  private async startInTmuxWeb(id: string, cwd: string): Promise<ChatStatus> {
    const name = `cc-${id.slice(0, 8)}`
    this.starting.set(id, { terminal: name, attach: this.tmuxWeb.attachCommand(name) })
    this.emit(id, this.status(id))
    try {
      if (!(await this.tmuxWeb.has(name))) {
        const command = [...this.config.claudeWrapper, this.config.claudeBin, '--resume', id]
        await this.tmuxWeb.start({ name, cwd, command, env: await shellEnvironment(), cols: START_COLS, rows: START_ROWS })
      }
      const entry = await this.waitForClaude(id, name)
      const server = await this.serverOf(entry)
      this.starting.delete(id)
      return this.connect(id, (options) => new TerminalLink({ ...options, pid: entry.pid, ...server }))
    } catch (error) {
      this.starting.delete(id)
      this.last.set(id, { error: error instanceof Error ? error.message : String(error), notice: '' })
      this.emit(id, this.status(id))
      return this.status(id)
    }
  }

  // Waits until Claude Code lists the session as open in a tmux pane. A Claude that exits is reported with its
  // last screen; one that is still starting after the timeout keeps running, like any tmux session.
  private async waitForClaude(id: string, name: string): Promise<OpenSession> {
    const until = Date.now() + START_TIMEOUT_MS
    let alive = true
    while (Date.now() < until) {
      const entry = (await this.openElsewhere(id)).find((item) => paneOf(item.tmux))
      if (entry) return entry
      alive = (await this.tmuxWeb.panes()).some((pane) => pane.session === name && !pane.dead)
      if (!alive) break
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS))
    }
    if (alive) throw new Error(`Claude is still starting in tmux-web. Join again in a moment, or watch it with: ${this.tmuxWeb.attachCommand(name)}`)
    const screen = (await this.tmuxWeb.capture(name))
      .split('\n')
      .filter((line) => line.trim())
      .slice(-FAILED_LINES)
      .join('\n')
    await this.tmuxWeb.kill(name)
    throw new Error(`Claude did not start in tmux-web${screen ? `:\n${screen}` : '.'}`)
  }

  // Which tmux server holds the session's pane: tmux-web when one of its panes runs Claude or one of Claude's parents.
  private async serverOf(entry: OpenSession): Promise<Server> {
    const chain = [entry.pid, ...(await ancestors(entry.pid))]
    const pane = (await this.tmuxWeb.panes()).find((item) => !item.dead && chain.includes(item.pid))
    if (!pane) return { run: this.defaultTmux, pane: paneOf(entry.tmux) }
    return { run: this.tmuxWeb.run, pane: pane.pane, terminal: pane.session, attach: this.tmuxWeb.attachCommand(pane.session) }
  }

  private async openElsewhere(id: string): Promise<OpenSession[]> {
    return ((await openSessions(this.config.registryDir)).get(id) ?? []).filter((entry) => entry.entrypoint !== VIEWER_ENTRYPOINT)
  }

  private async connect(id: string, make: (options: LinkOptions & { config: Config }) => ChatLink): Promise<ChatStatus> {
    const link = make({
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
    })
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
    await this.startups.get(id)
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
