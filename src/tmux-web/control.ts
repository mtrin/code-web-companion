// A tmux control mode client (tmux -C) attached to one session: it streams the pane's output as bytes,
// sends input bytes and size changes, and captures the current screen for a viewer that joins late.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

type Waiter = { resolve: (lines: string[]) => void; reject: (error: Error) => void }

const INPUT_CHUNK = 256
const BACKSLASH = 0x5c

export class ControlClient {
  readonly ready: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly target: string
  private readonly pending: Waiter[] = []
  private readonly outputs = new Set<(bytes: Buffer) => void>()
  private readonly exits = new Set<() => void>()
  private block: string[] | undefined
  private rest = Buffer.alloc(0)
  private attached = false
  private ended = false
  private markReady: () => void = () => undefined
  private failReady: (error: Error) => void = () => undefined

  constructor(bin: string, server: string[], name: string, env?: NodeJS.ProcessEnv) {
    this.target = `=${name}:`
    this.ready = new Promise((resolve, reject) => {
      this.markReady = resolve
      this.failReady = reject
    })
    this.ready.catch(() => undefined)
    this.child = spawn(bin, ['-u', ...server, '-C', 'attach', '-t', `=${name}`], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdin.on('error', () => undefined)
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk))
    this.child.on('error', (error) => this.end(error))
    this.child.on('exit', () => this.end(new Error('tmux control client exited')))
  }

  get closed(): boolean {
    return this.ended
  }

  onOutput(listener: (bytes: Buffer) => void): () => void {
    this.outputs.add(listener)
    return () => this.outputs.delete(listener)
  }

  onExit(listener: () => void): () => void {
    if (this.ended) listener()
    else this.exits.add(listener)
    return () => this.exits.delete(listener)
  }

  async command(line: string): Promise<string[]> {
    await this.ready
    if (this.ended) throw new Error('The tmux session has ended.')
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
      this.child.stdin.write(`${line}\n`)
    })
  }

  // Writes bytes to the pane as if typed: send-keys -H passes each byte through unchanged.
  async input(bytes: Buffer): Promise<void> {
    const sends: Promise<string[]>[] = []
    for (let start = 0; start < bytes.length; start += INPUT_CHUNK) {
      const hex = [...bytes.subarray(start, start + INPUT_CHUNK)].map((byte) => byte.toString(16).padStart(2, '0'))
      sends.push(this.command(`send-keys -t ${this.target} -H ${hex.join(' ')}`))
    }
    await Promise.all(sends)
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.command(`refresh-client -C ${cols}x${rows}`)
  }

  // The visible screen with its colours, then the cursor position, as bytes a terminal can draw from blank.
  async screen(): Promise<Buffer> {
    const [lines, [cursor = '0 0']] = await Promise.all([
      this.command(`capture-pane -p -e -t ${this.target}`),
      this.command(`display-message -p -t ${this.target} '#{cursor_x} #{cursor_y}'`),
    ])
    const [x = 0, y = 0] = cursor.split(' ').map(Number)
    return Buffer.from(`\x1b[0m\x1b[H\x1b[2J${lines.join('\x1b[0m\r\n')}\x1b[0m\x1b[${y + 1};${x + 1}H`, 'utf8')
  }

  close(): void {
    if (this.ended) return
    this.child.stdin.end()
    setTimeout(() => this.child.kill(), 1000).unref()
  }

  private read(chunk: Buffer): void {
    this.rest = Buffer.concat([this.rest, chunk])
    let end: number
    while ((end = this.rest.indexOf(10)) >= 0) {
      const line = this.rest.subarray(0, end)
      this.rest = this.rest.subarray(end + 1)
      this.line(line)
    }
  }

  private line(raw: Buffer): void {
    const text = raw.toString('utf8')
    if (this.block) {
      const end = /^%(end|error) /.exec(text)
      if (!end) return void this.block.push(text)
      const lines = this.block
      this.block = undefined
      // The first block answers the attach itself; every later one answers the oldest pending command.
      if (!this.attached) {
        this.attached = true
        if (end[1] === 'error') this.end(new Error(lines.join(' ') || 'tmux refused to attach'))
        else this.markReady()
        return
      }
      const waiter = this.pending.shift()
      if (end[1] === 'error') waiter?.reject(new Error(lines.join(' ')))
      else waiter?.resolve(lines)
      return
    }
    if (text.startsWith('%begin ')) {
      this.block = []
      return
    }
    if (text.startsWith('%output ')) {
      const head = /^%output %\d+ /.exec(text)
      if (!head) return
      const bytes = decode(raw.subarray(Buffer.byteLength(head[0])))
      for (const listener of this.outputs) listener(bytes)
      return
    }
    if (text.startsWith('%exit')) this.end(new Error('The tmux session has ended.'))
  }

  private end(error: Error): void {
    if (this.ended) return
    this.ended = true
    this.failReady(error)
    for (const waiter of this.pending.splice(0)) waiter.reject(error)
    for (const listener of this.exits) listener()
    this.exits.clear()
    this.outputs.clear()
    if (this.child.exitCode === null) this.child.kill()
  }
}

// %output escapes bytes below 32 and the backslash as \ooo (three octal digits); every other byte is sent as is.
function decode(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length)
  let size = 0
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0
    if (byte === BACKSLASH && i + 3 < data.length && isOctal(data[i + 1]) && isOctal(data[i + 2]) && isOctal(data[i + 3])) {
      out[size++] = ((data[i + 1]! - 48) << 6) | ((data[i + 2]! - 48) << 3) | (data[i + 3]! - 48)
      i += 3
    } else out[size++] = byte
  }
  return out.subarray(0, size)
}

function isOctal(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 48 && byte <= 55
}
