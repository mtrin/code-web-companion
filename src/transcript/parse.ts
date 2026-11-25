import type { Entry } from './types.ts'

interface Option {
  label?: string
  description?: string
}

interface Question {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: Option[]
}

interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: { questions?: Question[]; plan?: unknown }
  tool_use_id?: string
  content?: string | Block[]
}

interface Usage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface RawRecord {
  type?: string
  subtype?: string
  uuid?: string
  parentUuid?: string | null
  logicalParentUuid?: string | null
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  origin?: { kind?: string }
  promptSource?: string
  message?: { content?: string | Block[]; usage?: Usage }
  content?: string
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number }
  attachment?: { type?: string; prompt?: string | Block[]; commandMode?: string }
  toolUseResult?: unknown
  customTitle?: string
  agentName?: string
  cwd?: string
}

const SHELL_TAGS = /<(bash-input|bash-stdout|bash-stderr|command-name|command-args|command-message|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g

const OUTPUT_ONLY = /^(?:\s*<(bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>)+\s*$/

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g

const WEB_SOURCE = 'sdk'

const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

const SAID = 'the user said:\n'

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' }

export function parseLine(line: string): RawRecord | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' ? (value as RawRecord) : null
  } catch {
    return null
  }
}

export function createEntryReader(): (record: RawRecord) => Entry[] {
  const asks = new Map<string, Block>()
  return (record) => {
    if (record.isSidechain || record.isMeta || record.isCompactSummary) return []
    if (record.type === 'assistant') return replyEntries(record, asks)
    if (record.type === 'user') return [...answerEntries(record, asks), ...promptEntries(record)]
    if (record.type === 'attachment') return queuedEntries(record)
    if (record.type === 'system') return systemEntries(record)
    return []
  }
}

export function isTurnRecord(record: RawRecord): boolean {
  if (record.type === 'user' || record.type === 'assistant') return true
  if (record.type === 'system') return record.subtype === 'local_command'
  return record.type === 'attachment' && record.attachment?.type === 'queued_command'
}

export function contextTokens(record: RawRecord): number {
  const usage = record.message?.usage
  if (record.type !== 'assistant' || record.isSidechain || !usage) return 0
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
}

export function latestContext(records: (RawRecord | null)[]): number {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    const tokens = record ? contextTokens(record) : 0
    if (tokens) return tokens
  }
  return 0
}

export function isHumanPrompt(record: RawRecord): boolean {
  const typed = record.origin?.kind === 'human' || record.promptSource === WEB_SOURCE
  return record.type === 'user' && typed && !record.isMeta && !record.isSidechain
}

export function promptText(record: RawRecord): string {
  const content = record.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n\n')
}

function replyEntries(record: RawRecord, asks: Map<string, Block>): Entry[] {
  const content = record.message?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block, index): Entry[] => {
    const id = `${record.uuid}:${index}`
    const ts = record.timestamp ?? ''
    if (block.type === 'text' && block.text?.trim()) return [{ id, kind: 'reply', ts, label: 'Claude', format: 'markdown', text: block.text }]
    if (block.type !== 'tool_use' || !block.id || !ASK_TOOLS.has(block.name ?? '')) return []
    asks.set(block.id, block)
    if (block.name === 'ExitPlanMode') {
      const plan = block.input?.plan
      return typeof plan === 'string' && plan.trim() ? [{ id, kind: 'reply', ts, label: 'Claude, plan', format: 'markdown', text: plan }] : []
    }
    const text = questionText(block.input?.questions ?? [])
    return text ? [{ id, kind: 'reply', ts, label: 'Claude, question', format: 'markdown', text }] : []
  })
}

function questionText(questions: Question[]): string {
  return questions
    .map((item) => {
      const title = item.header ? `**${item.header}**: ${item.question ?? ''}` : (item.question ?? '')
      const pick = item.multiSelect ? ' (one or more)' : ''
      const options = (item.options ?? []).map((option) => `- ${option.label ?? ''}${option.description ? `: ${option.description}` : ''}`)
      return [`${title}${pick}`, options.join('\n')].filter((part) => part.trim()).join('\n\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

function answerEntries(record: RawRecord, asks: Map<string, Block>): Entry[] {
  const content = record.message?.content
  if (!Array.isArray(content)) return []
  const ts = record.timestamp ?? ''
  return content.flatMap((block, index): Entry[] => {
    const ask = block.type === 'tool_result' ? asks.get(block.tool_use_id ?? '') : undefined
    if (!ask) return []
    const id = `${record.uuid}:${index}`
    const result = objectOf(record.toolUseResult)
    if (ask.name === 'AskUserQuestion') {
      const text = answerText(result, ask) ?? refusal(block, 'Declined the questions')
      return [{ id, kind: 'prompt', ts, label: 'You, answer', format: 'markdown', text }]
    }
    const approved = typeof result?.plan === 'string' || blockText(block).startsWith('User has approved')
    const entries: Entry[] = []
    if (typeof ask.input?.plan !== 'string' && typeof result?.plan === 'string' && result.plan.trim()) {
      entries.push({ id: `${id}:plan`, kind: 'reply', ts, label: 'Claude, plan', format: 'markdown', text: result.plan })
    }
    entries.push({ id, kind: 'prompt', ts, label: 'You, plan', format: 'markdown', text: approved ? 'Approved the plan' : refusal(block, 'Declined the plan') })
    return entries
  })
}

function answerText(result: Record<string, unknown> | undefined, ask: Block): string | undefined {
  const answers = objectOf(result?.answers)
  if (!answers || !Object.keys(answers).length) return undefined
  const notes = objectOf(result?.annotations)
  const questions = ask.input?.questions ?? []
  return Object.entries(answers)
    .map(([question, answer]) => {
      const header = questions.find((item) => item.question === question)?.header || question
      const note = objectOf(notes?.[question])?.notes
      const lines = [`**${header}**: ${String(answer)}`]
      if (typeof note === 'string' && note.trim()) lines.push(`Notes: ${note.trim()}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

function refusal(block: Block, fallback: string): string {
  const text = blockText(block)
  const at = text.indexOf(SAID)
  if (at < 0) return fallback
  const said = text.slice(at + SAID.length).trim()
  if (said.startsWith('The user wants to clarify')) return 'Asked to talk the questions over first'
  return said || fallback
}

function blockText(block: Block): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => item.type === 'text' && item.text)
    .map((item) => item.text)
    .join('\n\n')
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function queuedEntries(record: RawRecord): Entry[] {
  const item = record.attachment
  if (item?.type !== 'queued_command' || item.commandMode !== 'prompt') return []
  const prompt = item.prompt
  const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? blockText({ content: prompt }) : ''
  if (!text.trim()) return []
  return [{ id: record.uuid ?? '', kind: 'prompt', ts: record.timestamp ?? '', label: 'You, mid-turn', format: 'markdown', text: promptBody(text) }]
}

function systemEntries(record: RawRecord): Entry[] {
  const ts = record.timestamp ?? ''
  if (record.subtype === 'compact_boundary') {
    return [{ id: record.uuid ?? '', kind: 'event', ts, label: 'Compacted', format: 'plain', text: compactText(record) }]
  }
  const text = record.content
  if (record.subtype !== 'local_command' || typeof text !== 'string' || !text.trim()) return []
  if (OUTPUT_ONLY.test(text)) return outputEntries(record, text)
  return [{ id: record.uuid ?? '', kind: 'prompt', ts, label: 'You, command', format: 'markdown', text: promptBody(text) }]
}

function compactText(record: RawRecord): string {
  const meta = record.compactMetadata
  const how = meta?.trigger === 'auto' ? ' automatically' : ''
  const sizes = meta?.preTokens && meta.postTokens ? `, ${thousands(meta.preTokens)} to ${thousands(meta.postTokens)} tokens` : ''
  return `Conversation compacted${how}${sizes}`
}

function thousands(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

function promptEntries(record: RawRecord): Entry[] {
  const content = record.message?.content
  const text = promptText(record)
  if (!text.trim()) return []
  if (OUTPUT_ONLY.test(text)) return outputEntries(record, text)
  const images = Array.isArray(content) ? content.filter((block) => block.type === 'image').length : 0
  const shell = text.includes('<bash-input>')
  const kind = record.origin?.kind
  const label = shell ? 'You, shell' : record.promptSource === WEB_SOURCE ? 'You, web' : !kind || kind === 'human' ? 'You' : kind
  const note = images ? `${images} image${images > 1 ? 's' : ''} attached` : undefined
  return [{ id: record.uuid ?? '', kind: 'prompt', ts: record.timestamp ?? '', label, format: 'markdown', text: promptBody(text), note }]
}

function outputEntries(record: RawRecord, text: string): Entry[] {
  const body = [...text.matchAll(SHELL_TAGS)]
    .map(([, , value = '']) => tagValue(value))
    .filter((value) => value.trim())
    .join('\n\n')
  if (!body.trim()) return []
  const formatted = body.includes('\n') ? fence(body, '') : body
  return [{ id: record.uuid ?? '', kind: 'output', ts: record.timestamp ?? '', label: 'Output', format: 'plain', text: formatted }]
}

function tagValue(body: string): string {
  return unescapeEntities(body).replace(ANSI, '').replace(/\n+$/, '')
}

export function promptBody(text: string): string {
  if (!SHELL_TAGS.test(text)) return text
  SHELL_TAGS.lastIndex = 0
  const parts: string[] = []
  let name = ''
  let args = ''
  for (const [, tag, body = ''] of text.matchAll(SHELL_TAGS)) {
    const value = tagValue(body)
    if (tag === 'bash-input') parts.push(fence(`$ ${value}`, 'sh'))
    else if (tag === 'command-name') name = value
    else if (tag === 'command-args') args = value
    else if (tag !== 'command-message' && value.trim()) parts.push(fence(value, ''))
  }
  if (name) parts.unshift(fence(`${name} ${args}`.trim(), ''))
  const rest = text.replace(SHELL_TAGS, '').trim()
  if (rest) parts.push(rest)
  return parts.join('\n\n')
}

export function fence(body: string, lang: string): string {
  let longest = 2
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const marks = '`'.repeat(longest + 1)
  return `${marks}${lang}\n${body}\n${marks}`
}

function unescapeEntities(value: string): string {
  return value.replace(/&(lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity)
}
