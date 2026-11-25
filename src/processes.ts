import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export interface ProcessInfo {
  parent: number
  claude: boolean
  started?: string
}

export type ProcessLookup = (pid: number) => Promise<ProcessInfo | undefined>

const PS_TIMEOUT_MS = 5000
const CLAUDE = /(^|\/)claude(\s|$)|\/claude\/versions\/|@anthropic-ai\/claude-code\//

export async function processLookup(platform: string = process.platform): Promise<ProcessLookup> {
  if (platform === 'linux') return fromProc
  const [names, commands] = await Promise.all([ps(['-A', '-o', 'pid=,ppid=,comm=']), ps(['-A', '-o', 'pid=,args='])])
  const table = new Map<number, ProcessInfo>()
  for (const line of names.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) table.set(Number(match[1]), { parent: Number(match[2]), claude: CLAUDE.test(match[3] ?? '') })
  }
  for (const line of commands.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const info = match ? table.get(Number(match[1])) : undefined
    if (info && !info.claude) info.claude = CLAUDE.test(match?.[2] ?? '')
  }
  return async (pid) => table.get(pid)
}

async function fromProc(pid: number): Promise<ProcessInfo | undefined> {
  const [comm, stat] = await Promise.all([
    readFile(`/proc/${pid}/comm`, 'utf8').catch(() => ''),
    readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''),
  ])
  if (!stat) return undefined
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  return { parent: Number(fields[1]), claude: comm.trim() === 'claude', started: fields[19] }
}

function ps(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('ps', args, { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: 16 << 20 }, (error, stdout) => resolve(error ? '' : stdout))
  })
}
