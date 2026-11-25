import { open } from 'node:fs/promises'

const CHUNK = 4 * 1024 * 1024
const NEWLINE = 0x0a

export async function readLines(path: string, from: number, onLine: (line: string) => void): Promise<number> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    let position = from
    let consumed = from
    let carry = Buffer.alloc(0)
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - position))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      let start = 0
      for (let end = data.indexOf(NEWLINE, start); end !== -1; end = data.indexOf(NEWLINE, start)) {
        if (end > start) onLine(data.toString('utf8', start, end))
        consumed += end + 1 - start
        start = end + 1
      }
      carry = Buffer.from(data.subarray(start))
    }
    return consumed
  } finally {
    await handle.close()
  }
}

export async function readWindow(path: string, start: number, length: number): Promise<string[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const from = Math.max(0, Math.min(start, size))
    const buffer = Buffer.allocUnsafe(Math.min(length, size - from))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from)
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n')
    if (from > 0) lines.shift()
    if (from + bytesRead < size) lines.pop()
    return lines.filter(Boolean)
  } finally {
    await handle.close()
  }
}
