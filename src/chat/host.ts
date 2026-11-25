import { query, type CanUseTool, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Config } from '../config.ts'
import { openSessions, VIEWER_ENTRYPOINT } from '../transcript/open.ts'
import { shellEnvironment, wrappedSpawn } from './launch.ts'
import type { Ask, ChatLink, ChatState, ChatStatus, Decision, LinkOptions, Question } from './types.ts'

interface Pending {
  ask: Ask
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
}

interface HostOptions extends LinkOptions {
  cwd: string
  config: Config
}

const DRAFT_THROTTLE_MS = 120
const DRAFT_SETTLE_MS = 1500
const CLOSE_GRACE_MS = 15_000
const TERMINAL_CHECK_MS = 5000
const INPUT_PREVIEW_CHARS = 4000
const STDERR_TAIL_CHARS = 2000

class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private done = false

  push(text: string): void {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    this.wake?.()
  }

  end(): void {
    this.done = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.done) return
      await new Promise<void>((resolve) => (this.wake = resolve))
      this.wake = undefined
    }
  }
}

export class ChatHost implements ChatLink {
  lastActivity = Date.now()
  private readonly options: HostOptions
  private readonly inbox = new Inbox()
  private readonly pending = new Map<string, Pending>()
  private session: Query | undefined
  private state: ChatState = 'starting'
  private leaving = false
  private interrupted = false
  private draft = ''
  private error = ''
  private notice = ''
  private stderr = ''
  private draftTimer: NodeJS.Timeout | undefined
  private settleTimer: NodeJS.Timeout | undefined
  private closeTimer: NodeJS.Timeout | undefined
  private terminalWatch: NodeJS.Timeout | undefined

  constructor(options: HostOptions) {
    this.options = options
  }

  get busy(): boolean {
    return this.state === 'working' || this.pending.size > 0
  }

  status(): ChatStatus {
    return {
      joined: this.state !== 'closed',
      mode: 'headless',
      state: this.state,
      leaving: this.leaving,
      draft: this.draft,
      asks: [...this.pending.values()].map((pending) => pending.ask),
      error: this.error,
      notice: this.notice,
    }
  }

  async start(): Promise<void> {
    const { id, cwd, config } = this.options
    const env = await shellEnvironment()
    const session = query({
      prompt: this.inbox,
      options: {
        cwd,
        resume: id,
        env,
        pathToClaudeCodeExecutable: config.claudeBin,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        canUseTool: this.ask,
        spawnClaudeCodeProcess: wrappedSpawn(config.claudeWrapper, (text) => (this.stderr = (this.stderr + text).slice(-STDERR_TAIL_CHARS))),
      },
    })
    this.session = session
    void this.consume(session)
    try {
      await session.initializationResult()
      if (this.state === 'starting') this.state = 'idle'
      this.terminalWatch = setInterval(() => void this.watchTerminal(), TERMINAL_CHECK_MS)
    } catch (error) {
      this.error = describe(error, this.stderr)
      this.close()
    }
    this.publishNow()
  }

  private async watchTerminal(): Promise<void> {
    if (this.leaving || this.state === 'closed') return
    const open = (await openSessions(this.options.config.registryDir)).get(this.options.id) ?? []
    if (!open.some((entry) => entry.entrypoint !== VIEWER_ENTRYPOINT)) return
    this.notice = 'This session was opened in a terminal, so the chat here closed. Join again to send through the terminal.'
    this.leave()
  }

  async send(text: string): Promise<void> {
    if (this.state === 'closed' || this.leaving) throw new Error('This chat is not joined.')
    this.inbox.push(text)
    this.state = 'working'
    this.error = ''
    this.lastActivity = Date.now()
    this.publishNow()
  }

  async interrupt(): Promise<void> {
    if (this.state !== 'working') return
    this.interrupted = true
    await this.session?.interrupt()
  }

  respond(id: string, decision: Decision): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false
    if (decision.behavior === 'allow') {
      pending.resolve({ behavior: 'allow', updatedInput: decision.answers ? { ...pending.input, answers: decision.answers } : pending.input })
    } else {
      pending.resolve({ behavior: 'deny', message: decision.message || 'The user denied this from the web viewer.' })
    }
    return true
  }

  leave(): void {
    if (this.state === 'closed') return
    this.leaving = true
    if (this.state === 'working') this.publishNow()
    else this.close()
  }

  private readonly ask: CanUseTool = (toolName, input, options) => {
    const ask: Ask = {
      id: options.toolUseID,
      tool: options.displayName ?? toolName,
      title: options.title ?? `Claude wants to use ${toolName}`,
      detail: options.description ?? options.decisionReason ?? '',
      input: preview(toolName, input),
      defaultToNo: Boolean(options.defaultToNo),
      ...(toolName === 'AskUserQuestion' ? { questions: questions(input) } : {}),
    }
    return new Promise<PermissionResult>((resolve) => {
      const settle = (result: PermissionResult) => {
        if (!this.pending.delete(ask.id)) return
        this.lastActivity = Date.now()
        this.publishNow()
        resolve(result)
      }
      this.pending.set(ask.id, { ask, input, resolve: settle })
      options.signal.addEventListener('abort', () => settle({ behavior: 'deny', message: 'Permission request cancelled.' }), { once: true })
      this.publishNow()
    })
  }

  private async consume(session: Query): Promise<void> {
    try {
      for await (const message of session) this.handle(message)
      if (!this.leaving && !this.error) this.error = describe('Claude Code stopped.', this.stderr)
    } catch (error) {
      if (!this.leaving) this.error = describe(error, this.stderr)
    } finally {
      this.finish()
    }
  }

  private handle(message: SDKMessage): void {
    this.lastActivity = Date.now()
    if (message.type === 'stream_event') {
      if (message.parent_tool_use_id) return
      const event = message.event
      if (event.type === 'message_start') this.setDraft('')
      else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') this.setDraft(this.draft + event.delta.text)
      return
    }
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      clearTimeout(this.settleTimer)
      this.settleTimer = setTimeout(() => this.setDraft(''), DRAFT_SETTLE_MS)
      return
    }
    if (message.type === 'result') {
      this.state = 'idle'
      this.draft = ''
      if (message.subtype !== 'success' && !this.interrupted) this.error = message.errors.join('\n') || message.subtype
      this.interrupted = false
      this.publishNow()
      if (this.leaving) this.close()
    }
  }

  private setDraft(text: string): void {
    clearTimeout(this.settleTimer)
    this.draft = text
    this.draftTimer ??= setTimeout(() => {
      this.draftTimer = undefined
      this.publishNow()
    }, DRAFT_THROTTLE_MS)
  }

  private close(): void {
    for (const pending of [...this.pending.values()]) pending.resolve({ behavior: 'deny', message: 'The web viewer left this session.' })
    this.inbox.end()
    this.closeTimer ??= setTimeout(() => this.session?.close(), CLOSE_GRACE_MS)
  }

  private finish(): void {
    clearInterval(this.terminalWatch)
    clearTimeout(this.closeTimer)
    clearTimeout(this.draftTimer)
    clearTimeout(this.settleTimer)
    this.state = 'closed'
    this.draft = ''
    this.pending.clear()
    this.publishNow()
    this.options.onClosed()
  }

  private publishNow(): void {
    this.options.publish(this.status())
  }
}

function preview(toolName: string, input: Record<string, unknown>): string {
  const text =
    toolName === 'Bash' && typeof input.command === 'string'
      ? input.command
      : toolName === 'ExitPlanMode' && typeof input.plan === 'string'
        ? input.plan
        : JSON.stringify(input, null, 2)
  return text.length > INPUT_PREVIEW_CHARS ? `${text.slice(0, INPUT_PREVIEW_CHARS)}\n…` : text
}

function questions(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) return []
  return input.questions.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    const options = Array.isArray(value.options) ? value.options : []
    return [
      {
        question: String(value.question ?? ''),
        header: String(value.header ?? ''),
        multiSelect: Boolean(value.multiSelect),
        options: options.map((option: unknown) => {
          const entry = (option ?? {}) as Record<string, unknown>
          return { label: String(entry.label ?? ''), description: String(entry.description ?? '') }
        }),
      },
    ]
  })
}

function describe(error: unknown, stderr: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return stderr.trim() ? `${message}\n${stderr.trim()}` : message
}
