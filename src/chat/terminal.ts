import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { Config } from '../config.ts'
import { openEntry } from '../transcript/open.ts'
import type { ChatLink, ChatState, ChatStatus, Decision, LinkOptions } from './types.ts'

interface TerminalOptions extends LinkOptions {
  config: Config
  pid: number
  pane: string
}

const POLL_MS = 1500
const ENTER_DELAY_MS = 200
const TMUX_TIMEOUT_MS = 5000
const BUFFER = 'code-web-companion'
const PANE_FORMAT = '#{pane_pid} #{window_panes} #{pane_index} window #{session_name}:#{window_index} "#{window_name}"'
const PANE_INFO = /^(\d+) (\d+) (\d+) (.*)$/
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const STATES: Record<string, ChatState> = { busy: 'working', waiting: 'waiting', idle: 'idle' }

export function paneOf(tmuxField: string): string {
  const pane = tmuxField.slice(tmuxField.lastIndexOf('.') + 1)
  return /^%\d+$/.test(pane) ? pane : ''
}

export class TerminalLink implements ChatLink {
  lastActivity = Date.now()
  readonly busy = false
  private readonly options: TerminalOptions
  private state: ChatState = 'idle'
  private closed = false
  private error = ''
  private place = ''
  private poller: NodeJS.Timeout | undefined

  constructor(options: TerminalOptions) {
    this.options = options
  }

  status(): ChatStatus {
    return {
      joined: !this.closed,
      mode: 'terminal',
      state: this.closed ? 'closed' : this.state,
      leaving: false,
      draft: '',
      asks: [],
      error: this.error,
      notice: '',
      where: this.closed ? '' : `Messages go to your terminal in tmux ${this.place || 'pane'}. Approvals and questions are answered there.`,
    }
  }

  async start(): Promise<void> {
    await this.refresh()
    if (this.closed) return
    await this.verifyPane()
    this.poller = setInterval(() => void this.refresh(), POLL_MS)
    this.publish()
  }

  async send(text: string): Promise<void> {
    await this.refresh()
    if (this.closed) throw new Error('The terminal session has closed.')
    if (this.state === 'waiting') throw new Error('Claude is waiting for an answer in the terminal. Answer it there, then send again.')
    await this.verifyPane()
    const clean = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
    const { pane } = this.options
    await this.tmux(['load-buffer', '-b', BUFFER, '-'], clean)
    await this.tmux(['paste-buffer', '-b', BUFFER, '-d', '-p', '-t', pane])
    await new Promise((resolve) => setTimeout(resolve, ENTER_DELAY_MS))
    await this.tmux(['send-keys', '-t', pane, 'Enter'])
    this.lastActivity = Date.now()
    this.state = 'working'
    this.publish()
  }

  async interrupt(): Promise<void> {
    await this.refresh()
    if (this.state !== 'working') return
    await this.verifyPane()
    await this.tmux(['send-keys', '-t', this.options.pane, 'Escape'])
  }

  respond(_id: string, _decision: Decision): boolean {
    return false
  }

  leave(): void {
    this.close('')
  }

  private async refresh(): Promise<void> {
    if (this.closed) return
    const { config, pid, id } = this.options
    const entry = await openEntry(config.registryDir, pid, id)
    if (!entry) return this.close('The terminal session closed. Join again to chat from here.')
    const state = STATES[entry.status] ?? 'idle'
    if (state === this.state) return
    this.state = state
    this.publish()
  }

  private async verifyPane(): Promise<void> {
    const { pane, pid } = this.options
    const info = PANE_INFO.exec((await this.tmux(['display-message', '-p', '-t', pane, PANE_FORMAT])).trim())
    const [, panePid = '', panes = '', paneIndex = '', window = `pane ${pane}`] = info ?? []
    const place = Number(panes) > 1 ? `${window}, pane ${paneIndex}` : window
    if (!Number(panePid) || !(await ancestors(pid)).includes(Number(panePid))) throw new Error(`tmux ${place} no longer holds this session.`)
    if (place === this.place) return
    this.place = place
    this.publish()
  }

  private close(error: string): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.poller)
    this.error = error
    this.publish()
    this.options.onClosed()
  }

  private publish(): void {
    this.options.publish(this.status())
  }

  private tmux(args: string[], input?: string): Promise<string> {
    return runTmux(this.options.config.tmuxBin, args, input)
  }
}

async function ancestors(pid: number): Promise<number[]> {
  const chain: number[] = []
  let current = pid
  while (current > 1 && chain.length < 32) {
    const stat = await readFile(`/proc/${current}/stat`, 'utf8').catch(() => '')
    const parent = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[1])
    if (!parent) break
    chain.push(parent)
    current = parent
  }
  return chain
}

function runTmux(bin: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, ['-u', ...args], { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout)
    })
    child.stdin?.on('error', () => undefined)
    if (input === undefined) child.stdin?.end()
    else child.stdin?.end(input)
  })
}
