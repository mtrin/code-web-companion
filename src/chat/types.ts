export type ChatState = 'starting' | 'idle' | 'working' | 'waiting' | 'closed'
export type ChatMode = 'headless' | 'terminal'

export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

export interface Ask {
  id: string
  tool: string
  title: string
  detail: string
  input: string
  defaultToNo: boolean
  questions?: Question[]
}

export interface ChatStatus {
  joined: boolean
  mode: ChatMode
  state: ChatState
  leaving: boolean
  draft: string
  asks: Ask[]
  error: string
  notice: string
  where?: string
  // tmux-web session name when Claude runs there; the page opens its terminal panel with it.
  terminal?: string
  // Command that attaches a terminal to that tmux-web session.
  attach?: string
}

export interface Decision {
  behavior: 'allow' | 'deny'
  answers?: Record<string, string>
  message?: string
}

export interface ChatLink {
  readonly busy: boolean
  readonly lastActivity: number
  status(): ChatStatus
  start(): Promise<void>
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  respond(id: string, decision: Decision): boolean
  leave(): void
}

export interface LinkOptions {
  id: string
  publish: (status: ChatStatus) => void
  onClosed: () => void
}
