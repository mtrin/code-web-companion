import { execFile } from 'node:child_process'

export type TmuxRun = (args: string[], input?: string) => Promise<string>

const TMUX_TIMEOUT_MS = 5000

// Runs one tmux command. `server` selects the server, such as ['-L', socket, '-f', config]; empty means the default server.
// `env` is the environment of the tmux client, and of the server when this command starts it.
export function tmuxRunner(bin: string, server: string[] = [], env?: NodeJS.ProcessEnv): TmuxRun {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(bin, ['-u', ...server, ...args], { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS, env }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout)
      })
      child.stdin?.on('error', () => undefined)
      if (input === undefined) child.stdin?.end()
      else child.stdin?.end(input)
    })
}
