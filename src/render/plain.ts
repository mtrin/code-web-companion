import type { MarkdownIt } from 'markdown-it'

type CodeBlock = (content: string, info: string) => string
type Segment = { kind: 'text'; lines: string[] } | { kind: 'code'; info: string; lines: string[] }

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const INDENTED = /^[ \t]/
const WEB_SCHEMA = /^https?:$/i

export function createPlainRenderer(md: MarkdownIt, codeBlock: CodeBlock): (text: string) => string {
  const escape = md.utils.escapeHtml

  const linkify = (value: string) => {
    const matches = (md.linkify.match(value) ?? []).filter((match) => WEB_SCHEMA.test(match.schema))
    let html = ''
    let last = 0
    for (const match of matches) {
      html += `${escape(value.slice(last, match.index))}<a href="${escape(match.url)}" target="_blank" rel="noopener noreferrer">${escape(match.text)}</a>`
      last = match.lastIndex
    }
    return html + escape(value.slice(last))
  }

  const paragraph = (lines: string[]) =>
    `<p class="text${lines.some((line) => INDENTED.test(line)) ? ' mono' : ''}">${linkify(lines.join('\n'))}</p>\n`

  const text = (lines: string[]) => {
    let html = ''
    let block: string[] = []
    for (const line of [...lines, '']) {
      if (line.trim()) block.push(line)
      else if (block.length) {
        html += paragraph(block)
        block = []
      }
    }
    return html
  }

  return (source) =>
    segments(source)
      .map((segment) => (segment.kind === 'code' ? codeBlock(segment.lines.join('\n'), segment.info) : text(segment.lines)))
      .join('')
}

function segments(source: string): Segment[] {
  const out: Segment[] = []
  let plain: string[] = []
  let code: { marker: string; info: string; lines: string[] } | undefined
  for (const line of source.split('\n')) {
    if (code) {
      const close = FENCE_CLOSE.exec(line)?.[1]
      if (close && close[0] === code.marker[0] && close.length >= code.marker.length) {
        out.push({ kind: 'code', info: code.info, lines: code.lines })
        code = undefined
      } else code.lines.push(line)
      continue
    }
    const open = FENCE_OPEN.exec(line)
    const marker = open?.[1]
    const info = open?.[2] ?? ''
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      if (plain.length) out.push({ kind: 'text', lines: plain })
      plain = []
      code = { marker, info: info.trim(), lines: [] }
    } else plain.push(line)
  }
  if (code) out.push({ kind: 'code', info: code.info, lines: code.lines })
  if (plain.length) out.push({ kind: 'text', lines: plain })
  return out
}
