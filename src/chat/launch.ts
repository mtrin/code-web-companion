import { spawn } from 'node:child_process'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { CONFIG_KEYS } from '../config.ts'

const MARKER = '\0code-web-companion-env\0'
const SHELL_TIMEOUT_MS = 15_000
const DROPPED = new Set([...CONFIG_KEYS, 'PWD', 'OLDPWD', 'SHLVL', '_'])

type Environment = Record<string, string>

export function shellEnvironment(): Promise<Environment> {
  const base = cleaned(process.env, true)
  return new Promise((resolve) => {
    const child = spawn(base.SHELL || 'bash', ['-lic', "printf '\\0code-web-companion-env\\0'; env -0"], {
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
      const start = output.lastIndexOf(MARKER)
      if (start < 0) return resolve(base)
      const captured: Environment = {}
      for (const pair of output.slice(start + MARKER.length).split('\0')) {
        const split = pair.indexOf('=')
        if (split > 0) captured[pair.slice(0, split)] = pair.slice(split + 1)
      }
      resolve(cleaned(captured, false))
    })
  })
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
