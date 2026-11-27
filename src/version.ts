import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface Version {
  version: string
  commit: string
  date: string
  changed: boolean
}

const GIT_TIMEOUT_MS = 5000

export async function readVersion(appRoot: string): Promise<Version> {
  const pkg = await readFile(path.join(appRoot, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text) as { version?: string })
    .catch(() => ({ version: '' }))
  const [log, status] = await Promise.all([git(appRoot, ['log', '-1', '--format=%h %cs']), git(appRoot, ['status', '--porcelain', '--untracked-files=no'])])
  const [commit = '', date = ''] = log.trim().split(' ')
  return { version: pkg.version ?? '', commit, date, changed: Boolean(status.trim()) }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS }, (error, stdout) => resolve(error ? '' : stdout))
  })
}
