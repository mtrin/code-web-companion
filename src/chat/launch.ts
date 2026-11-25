import { spawn } from 'node:child_process'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { CONFIG_KEYS } from '../config.ts'

const START = '__code_web_companion_env__'
const END = '__code_web_companion_end__'
const DUMP = 'process.stdout.write(JSON.stringify(process.env))'
const SHELL_TIMEOUT_MS = 15_000
const DROPPED = new Set([...CONFIG_KEYS, 'PWD', 'OLDPWD', 'SHLVL', '_'])

type Environment = Record<string, string>

export function shellEnvironment(): Promise<Environment> {
  const base = cleaned(process.env, true)
  const script = `printf '%s' ${START}; ${quoted(process.execPath)} -e '${DUMP}'; printf '%s' ${END}`
  return new Promise((resolve) => {
    const child = spawn(base.SHELL || 'bash', ['-lic', script], {
      cwd: base.HOME,
      env: base,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SHELL_TIMEOUT_MS,
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => resolve(base))
    child.on('close', () => {
      const output = Buffer.concat(chunks).toString('utf8')
      const start = output.lastIndexOf(START)
      const end = output.indexOf(END, start)
      if (start < 0 || end < 0) return resolve(base)
      try {
        const captured = JSON.parse(output.slice(start + START.length, end)) as Environment
        resolve(captured.PATH ? cleaned(captured, false) : base)
      } catch {
        resolve(base)
      }
    })
  })
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function wrappedSpawn(wrapper: string[], onStderr: (text: string) => void): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const [first, ...rest] = wrapper
    const [command, args] = first ? [first, [...rest, options.command, ...options.args]] : [options.command, options.args]
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.cwd ? { ...options.env, PWD: options.cwd } : options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    })
    child.stderr.on('data', (chunk: Buffer) => onStderr(chunk.toString('utf8')))
    return child
  }
}

function cleaned(source: NodeJS.ProcessEnv, dropClaude: boolean): Environment {
  const out: Environment = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || DROPPED.has(key) || (dropClaude && key.startsWith('CLAUDE'))) continue
    out[key] = value
  }
  return out
}
