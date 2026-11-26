// Terminal panel: a live view of a tmux-web session, fed by /api/tmux/<name>/stream, typing back through POSTs.
import { FitAddon, Terminal } from '/vendor/xterm.js'

const SIZE_DEBOUNCE_MS = 150
const RETRY_MS = 1000
const RETRIES = 5
const THEME = { background: '#181818', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' }

export function createTerminal(container, { post }) {
  const encoder = new TextEncoder()
  const fit = new FitAddon()
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: THEME,
  })
  term.loadAddon(fit)
  let opened = false
  let name = ''
  let source = null
  let queue = []
  let sending = false
  let sizeTimer
  let retryTimer
  let retries = 0

  // Keys typed in the terminal belong to Claude: the page's own shortcuts never see them.
  container.addEventListener('keydown', (event) => event.stopPropagation())
  term.onData((data) => send(encoder.encode(data)))
  term.onBinary((data) => send(Uint8Array.from(data, (char) => char.charCodeAt(0))))
  new ResizeObserver(() => resize()).observe(container)

  function show(next) {
    if (!opened) {
      term.open(container)
      opened = true
    }
    if (next === name && source) return resize()
    hide()
    name = next
    retries = 0
    term.reset()
    connect()
  }

  function connect() {
    source = new EventSource(`/api/tmux/${encodeURIComponent(name)}/stream`)
    source.addEventListener('screen', (event) => {
      retries = 0
      term.reset()
      term.write(decode(JSON.parse(event.data).data))
      resize()
    })
    source.addEventListener('output', (event) => term.write(decode(JSON.parse(event.data).data)))
    source.addEventListener('exit', () => {
      term.write('\r\n\x1b[2m[Claude exited]\x1b[0m\r\n')
      hide()
    })
    // A refused stream (the session is gone or not there yet) is not retried by EventSource itself.
    source.addEventListener('error', () => {
      if (source?.readyState !== EventSource.CLOSED) return
      source = null
      if (retries++ < RETRIES) retryTimer = setTimeout(() => name && !source && connect(), RETRY_MS)
      else term.write('\r\n\x1b[2m[The terminal is not available. Close the panel and open it again.]\x1b[0m\r\n')
    })
  }

  function hide() {
    clearTimeout(retryTimer)
    source?.close()
    source = null
    queue = []
    name = ''
  }

  function send(bytes) {
    if (!name) return
    queue.push(bytes)
    void flush()
  }

  // One request at a time keeps keys in order; keys typed meanwhile go together in the next request.
  async function flush() {
    if (sending || !queue.length || !name) return
    sending = true
    const bytes = concat(queue.splice(0))
    await post(`/api/tmux/${encodeURIComponent(name)}/input`, { data: encode(bytes) })
    sending = false
    void flush()
  }

  function resize() {
    clearTimeout(sizeTimer)
    sizeTimer = setTimeout(() => {
      if (!opened || !name || !container.offsetWidth) return
      fit.fit()
      void post(`/api/tmux/${encodeURIComponent(name)}/size`, { cols: term.cols, rows: term.rows })
    }, SIZE_DEBOUNCE_MS)
  }

  return {
    show,
    hide,
    focus: () => term.focus(),
    hasFocus: () => container.contains(document.activeElement),
    get name() {
      return name
    },
  }
}

function decode(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

function encode(bytes) {
  let text = ''
  for (let start = 0; start < bytes.length; start += 0x8000) text += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(text)
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
