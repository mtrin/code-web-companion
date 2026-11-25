import hljs from 'highlight.js'
import MarkdownIt, { type Token } from 'markdown-it'
import type { Entry, RenderedEntry } from '../transcript/types.ts'
import { createPlainRenderer } from './plain.ts'

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>'

const LINE_HINT = /:(\d+)(?:-\d+)?$/

export interface RendererOptions {
  wslDistro: string
}

export function createRenderer(options: RendererOptions): (entry: Entry, seq: number) => RenderedEntry {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  const escape = md.utils.escapeHtml
  const validateLink = md.validateLink.bind(md)
  md.validateLink = (url) => /^file:\/\//i.test(url) || validateLink(url)

  const codeBlock = (content: string, info: string) => {
    const lang = info.trim().split(/\s+/)[0] ?? ''
    const known = Boolean(lang && hljs.getLanguage(lang))
    const code = content.replace(/\n$/, '')
    const body = known ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : escape(code)
    const caption = lang ? `<figcaption>${escape(lang)}</figcaption>` : ''
    const langClass = known ? ` language-${escape(lang)}` : ''
    return `<figure class="code">${caption}<button class="copy" type="button" title="Copy" aria-label="Copy code">${COPY_ICON}</button><pre><code class="hljs${langClass}">${body}</code></pre></figure>\n`
  }

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    return token ? codeBlock(token.content, token.info) : ''
  }
  md.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx]
    return token ? codeBlock(token.content, '') : ''
  }

  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n'
  md.renderer.rules.table_close = () => '</table></div>\n'

  md.renderer.rules.link_open = (tokens, idx, opts, _env, self) => {
    const token = tokens[idx]
    if (!token) return ''
    const href = String(token.attrGet('href') ?? '')
    const local = localPath(href)
    if (local) {
      const line = lineHint(tokens[idx + 1])
      const target = options.wslDistro ? `vscode-remote/wsl+${encodeURIComponent(options.wslDistro)}` : 'file'
      token.attrSet('href', `vscode://${target}${local}${line ? `:${line}` : ''}`)
      token.attrSet('class', 'local')
      token.attrSet('title', safeDecode(local))
    } else if (/^https?:/i.test(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
    return self.renderToken(tokens, idx, opts)
  }

  const plain = createPlainRenderer(md, codeBlock)

  return (entry, seq) => ({
    seq,
    id: entry.id,
    kind: entry.kind,
    ts: entry.ts,
    label: entry.label,
    lines: entry.text.split('\n').length,
    html:
      (entry.format === 'plain' ? plain(entry.text) : md.render(entry.text)) +
      (entry.note ? `<p class="note">${escape(entry.note)}</p>\n` : ''),
    markdown: entry.text,
  })
}

function localPath(href: string): string | undefined {
  if (/^file:\/\//i.test(href)) return href.replace(/^file:\/\/(localhost)?/i, '')
  if (href.startsWith('/') && !href.startsWith('//')) return href.split('#')[0]
  return undefined
}

function lineHint(token: Token | undefined): string | undefined {
  return token?.type === 'text' ? LINE_HINT.exec(token.content)?.[1] : undefined
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}
