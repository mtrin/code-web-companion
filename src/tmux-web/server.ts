// tmux-web: the companion's own tmux server, on its own socket and with its own configuration.
// It knows nothing about Claude: it starts sessions, lists panes and hands out runners and control clients.
import path from 'node:path'
import { ControlClient } from './control.ts'
import { tmuxRunner, type TmuxRun } from './run.ts'

export const TMUX_CONFIG = path.join(import.meta.dirname, 'tmux.conf')

export interface Pane {
  session: string
  pane: string
  pid: number
  dead: boolean
}

export interface StartOptions {
  name: string
  cwd: string
  command: string[]
  env: Record<string, string>
  cols: number
  rows: number
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export class TmuxWeb {
  readonly bin: string
  readonly socket: string
  readonly run: TmuxRun
  readonly env: NodeJS.ProcessEnv | undefined
  private readonly clients = new Map<string, { client: ControlClient; refs: number }>()

  // `env` is the environment the server starts with; every pane inherits it unless a session overrides a variable.
  constructor(bin: string, socket: string, env?: NodeJS.ProcessEnv) {
    this.bin = bin
    this.socket = socket
    this.env = env
    this.run = tmuxRunner(bin, ['-L', socket, '-f', TMUX_CONFIG], env)
  }

  // Starts a detached session whose only pane runs `command` directly, without a shell around it.
  async start(options: StartOptions): Promise<void> {
    const env = Object.entries(options.env).flatMap(([key, value]) => (ENV_NAME.test(key) && !value.includes('\n') ? ['-e', literal(`${key}=${value}`)] : []))
    const size = ['-x', String(options.cols), '-y', String(options.rows)]
    // tmux gives a new pane the PATH of the client that creates it, not the session's, so the client runs with `env` too.
    const run = tmuxRunner(this.bin, ['-L', this.socket, '-f', TMUX_CONFIG], { ...this.env, ...options.env })
    await run(['new-session', '-d', '-s', options.name, '-c', options.cwd, ...size, ...env, '--', ...options.command.map(literal)])
  }

  // Every pane on the server; empty when the server is not running.
  async panes(): Promise<Pane[]> {
    const out = await this.run(['list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}']).catch(() => '')
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [session = '', pane = '', pid = '', dead = ''] = line.split('\t')
        return { session, pane, pid: Number(pid), dead: dead === '1' }
      })
  }

  async has(name: string): Promise<boolean> {
    return this.run(['has-session', '-t', `=${name}`]).then(
      () => true,
      () => false,
    )
  }

  async kill(name: string): Promise<void> {
    await this.run(['kill-session', '-t', `=${name}`]).catch(() => undefined)
  }

  // The visible screen of the session's active pane, as plain text.
  async capture(name: string): Promise<string> {
    return this.run(['capture-pane', '-p', '-t', `=${name}:`]).catch(() => '')
  }

  attachCommand(name: string): string {
    return `tmux -L ${this.socket} attach -t ${name}`
  }

  // One control client per session, shared by every viewer; it detaches when the last viewer releases it.
  async control(name: string): Promise<{ client: ControlClient; release: () => void }> {
    let entry = this.clients.get(name)
    if (!entry || entry.client.closed) {
      const created = { client: new ControlClient(this.bin, ['-L', this.socket, '-f', TMUX_CONFIG], name, this.env), refs: 0 }
      created.client.onExit(() => this.clients.get(name) === created && this.clients.delete(name))
      this.clients.set(name, created)
      entry = created
    }
    const current = entry
    current.refs++
    let released = false
    const release = () => {
      if (released) return
      released = true
      current.refs--
      if (current.refs > 0) return
      current.client.close()
      if (this.clients.get(name) === current) this.clients.delete(name)
    }
    try {
      await current.client.ready
    } catch (error) {
      release()
      throw error
    }
    return { client: current.client, release }
  }

  // The control client of a session someone is viewing, for input and size changes.
  viewing(name: string): ControlClient | undefined {
    const client = this.clients.get(name)?.client
    return client && !client.closed ? client : undefined
  }
}

// tmux reads an argument ending in ';' as the end of a command; '\;' keeps the semicolon.
function literal(value: string): string {
  return value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value
}
