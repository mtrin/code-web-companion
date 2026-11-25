import { existsSync } from 'node:fs'
import path from 'node:path'

const env = process.env
const home = env.HOME ?? ''
const TMUX_PATHS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/home/linuxbrew/.linuxbrew/bin/tmux']
const NATIVE_CLAUDE = path.join(home, '.local', 'bin', 'claude')
const list = (value: string | undefined, separator: RegExp) => (value ?? '').split(separator).filter(Boolean)

export const config = {
  host: env.HOST ?? '127.0.0.1',
  port: Number(env.PORT ?? 7878),
  projectsDir: env.PROJECTS_DIR ?? path.join(home, '.claude', 'projects'),
  hostHome: env.HOST_HOME ?? home,
  wslDistro: env.WSL_DISTRO ?? env.WSL_DISTRO_NAME ?? '',
  pollMs: Number(env.POLL_MS ?? 750),
  sessionLimit: Number(env.SESSION_LIMIT ?? 80),
  claudeBin: env.CLAUDE_BIN ?? (existsSync(NATIVE_CLAUDE) ? NATIVE_CLAUDE : 'claude'),
  claudeWrapper: list(env.CLAUDE_WRAPPER, /\s+/),
  tmuxBin: env.TMUX_BIN ?? TMUX_PATHS.find((file) => existsSync(file)) ?? 'tmux',
  registryDir: env.SESSION_REGISTRY ?? path.join(home, '.claude', 'sessions'),
  archiveDir: env.ARCHIVE_DIR ?? path.join(home, '.claude', 'archive'),
  citeRoots: list(env.CITE_ROOTS, /:/),
  chatIdleMs: Number(env.CHAT_IDLE_MS ?? 10 * 60_000),
  contextWindow: Number(env.CONTEXT_WINDOW ?? 1_000_000),
  appRoot: path.resolve(import.meta.dirname, '..'),
}

export type Config = typeof config

export const CONFIG_KEYS = [
  'HOST',
  'PORT',
  'PROJECTS_DIR',
  'HOST_HOME',
  'WSL_DISTRO',
  'POLL_MS',
  'SESSION_LIMIT',
  'CLAUDE_BIN',
  'CLAUDE_WRAPPER',
  'TMUX_BIN',
  'SESSION_REGISTRY',
  'ARCHIVE_DIR',
  'CITE_ROOTS',
  'CHAT_IDLE_MS',
  'CONTEXT_WINDOW',
]
