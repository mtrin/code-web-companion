import { COLLAPSE_ICON, createAnnotator } from './annotate.js'
import { createPrompt } from './prompt.js'
import { createTerminal } from './terminal.js'

const OLD_PREFIX = 'code-md-viewer:'
for (const key of Object.keys(localStorage).filter((name) => name.startsWith(OLD_PREFIX))) {
  const renamed = `code-web-companion:${key.slice(OLD_PREFIX.length)}`
  if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key) ?? '')
  localStorage.removeItem(key)
}

const $ = (id) => document.getElementById(id)
const els = {
  expand: $('expand'),
  header: $('session-header'),
  notesChip: $('notes-chip'),
  sessions: $('sessions'),
  filter: $('filter'),
  title: $('title'),
  cwd: $('cwd'),
  openBadge: $('open-badge'),
  context: $('context'),
  status: $('status'),
  entries: $('entries'),
  draft: $('draft'),
  main: $('main'),
  dock: $('dock'),
  asks: $('asks'),
  chatError: $('chat-error'),
  chatNotice: $('chat-notice'),
  chatAttach: $('chat-attach'),
  compose: $('compose'),
  message: $('message'),
  chatState: $('chat-state'),
  stop: $('stop'),
  send: $('send'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
  terminal: $('terminal'),
  terminalToggle: $('terminal-toggle'),
}

const REFRESH_MS = 10_000
const STICK_PX = 160
const ROLLABLE_PX = 480
const TOAST_MS = 7000
const CHEVRON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ARCHIVE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 3.5h12v3H2zM3 6.5v6.5h10V6.5M6.5 9h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
const RESTORE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const TRASH_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 4.5h11M6 4.5V2.8h4v1.7M4 4.5l.7 8.7h6.6l.7-8.7M6.7 7v4M9.3 7v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const WARN_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 2.2l6.2 11H1.8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.3v3.2M8 11.4v.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
const HIGH_CONTEXT = 0.8
const ARM_GUARD_MS = 500
const ARM_MS = 4000
const CHAT_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 3h11v7.5h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>'
const JOIN_TITLES = {
  off: 'Join chat',
  starting: 'Starting Claude Code. Click to go back to reading',
  idle: 'Chat ready. Click to go back to reading',
  working: 'Claude is working. Click to go back to reading',
  waiting: 'Claude is waiting for an answer. Click to go back to reading',
  leaving: 'Claude is finishing this turn, then the chat closes',
}
const CHAT_STATES = {
  starting: 'Starting Claude Code',
  idle: 'Ready',
  working: 'Claude is working',
  waiting: 'Claude is waiting for an answer',
  closed: 'Reading only',
}
const TERMINAL_STATES = {
  starting: 'Starting Claude in tmux',
  idle: 'Ready, sending to your terminal',
  working: 'Claude is working in your terminal',
  waiting: 'Claude is waiting for an answer in your terminal',
  closed: 'Reading only',
}
const EXPAND_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5L9 7M2.5 13.5L7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const DRAFT_STORE = 'code-web-companion:draft:'

let token = ''
let view = 'live'
let sessions = []
let current = null
let contextWindow = 0
let toastTimer
let expanded = false
let pinned = false
let sending = false
const sources = new WeakMap()
const annotator = createAnnotator({
  currentId: () => current?.id ?? null,
  lastReply,
  send: sendMessage,
  compose: composeMessage,
  collapse,
  expanded: () => expanded,
  changed: paintChip,
  viewport,
  scroller: () => els.main,
})
const prompt = createPrompt(els.message, { send: sendMessage, changed: saveDraft })
const terminal = createTerminal(els.terminal, { post: api })
let terminalOpen = false
let lastChatState = ''

// The message box takes focus back only when the terminal panel does not have it.
function focusPrompt() {
  if (!terminal.hasFocus()) prompt.focus()
}

function setTerminal(open) {
  terminalOpen = open && Boolean(current?.chat?.terminal)
  document.body.classList.toggle('with-terminal', terminalOpen)
  els.terminal.hidden = !terminalOpen
  els.terminalToggle.classList.toggle('active', terminalOpen)
  if (terminalOpen) terminal.show(current.chat.terminal)
  else terminal.hide()
}

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-viewer-token': token },
    body: JSON.stringify(body ?? {}),
  })
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, data }
}

async function loadSessions() {
  try {
    const response = await fetch(view === 'live' ? '/api/sessions' : '/api/archived')
    sessions = (await response.json()).sessions
    contextWindow = sessions.find((s) => s.window)?.window ?? contextWindow
    if (current?.context) {
      const session = sessions.find((s) => s.id === current.id)
      if (session) session.context = current.context
    }
    renderSessions()
    if (current) updateHeader(sessions.find((s) => s.id === current.id) ?? current.meta)
  } catch {
    els.status.textContent = 'session list unavailable'
  }
}

function renderSessions() {
  const query = els.filter.value.trim().toLowerCase()
  const visible = sessions.filter((s) => !query || s.title.toLowerCase().includes(query) || s.cwd.toLowerCase().includes(query))
  els.sessions.replaceChildren(...visible.map(sessionRow))
}

function sessionRow(s) {
  const row = document.createElement('div')
  row.className = `row${s.id === current?.id ? ' active' : ''}`
  row.dataset.id = s.id
  const link = document.createElement('a')
  link.href = `#${s.id}`
  const when = s.archivedAt ? `archived ${ago(s.archivedAt)}` : ago(s.updated)
  link.append(span('t', s.title), span('m', `${s.cwd}  ·  ${when}`))
  if (s.open) {
    const badges = span('badges', '')
    badges.append(badge(s.open, `open ${s.open}`, `Open in a terminal (${s.open})`))
    link.append(badges)
  }
  const actions = span('row-actions', '')
  const remove = rowButton(s.id, 'delete', TRASH_ICON)
  paintDelete(remove, s)
  actions.append(remove)
  if (view === 'live') {
    const archive = rowButton(s.id, 'archive', ARCHIVE_ICON)
    paintArchive(archive, s)
    const join = rowButton(s.id, 'join', CHAT_ICON)
    paintJoin(join, s.chat)
    actions.append(archive, join)
  } else {
    const restore = rowButton(s.id, 'restore', RESTORE_ICON)
    restore.title = 'Unarchive'
    actions.append(restore)
  }
  const bar = span('ctx', '')
  bar.append(span('fill', ''))
  row.append(link, actions, bar)
  paintRowContext(row, s.context)
  row.addEventListener('mouseleave', () => disarm(remove))
  return row
}

function short(n) {
  if (n >= 999_500) return `${+(n / 1e6).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function ratioOf(tokens) {
  return tokens && contextWindow ? tokens / contextWindow : 0
}

function contextLabel(tokens) {
  return `${short(tokens)} / ${short(contextWindow)}, ${Math.round(ratioOf(tokens) * 100)}%`
}

function paintMeter(meter, tokens) {
  const ratio = ratioOf(tokens)
  meter.classList.toggle('high', ratio >= HIGH_CONTEXT)
  meter.querySelector('.fill').style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`
}

function paintRowContext(row, tokens) {
  const bar = row.querySelector(':scope > .ctx')
  bar.hidden = !ratioOf(tokens)
  paintMeter(bar, tokens)
  row.querySelector(':scope > a').title = tokens ? `Context ${contextLabel(tokens)}` : ''
}

function showContext(tokens) {
  if (!current) return
  current.context = tokens
  els.context.hidden = !ratioOf(tokens)
  if (tokens) {
    paintMeter(els.context, tokens)
    els.context.querySelector('.label').textContent = contextLabel(tokens)
    els.context.title = `Context window: ${tokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens, as of the last reply`
  }
  const session = sessions.find((s) => s.id === current.id)
  if (session) session.context = tokens
  const row = els.sessions.querySelector(`.row[data-id="${CSS.escape(current.id)}"]`)
  if (row) paintRowContext(row, tokens)
}

function paintDelete(button, session) {
  button.disabled = Boolean(session.open || session.chat)
  button.title = button.disabled ? 'Close or leave this session before deleting it' : 'Delete permanently, without archiving'
}

function arm(button) {
  button.classList.add('armed')
  button.dataset.armedAt = String(Date.now())
  button.innerHTML = WARN_ICON
  button.title = 'Click again to delete permanently. This cannot be undone'
  clearTimeout(Number(button.dataset.timer))
  button.dataset.timer = String(setTimeout(() => disarm(button), ARM_MS))
}

function disarm(button) {
  if (!button.classList.contains('armed')) return
  clearTimeout(Number(button.dataset.timer))
  button.classList.remove('armed')
  delete button.dataset.armedAt
  button.innerHTML = TRASH_ICON
  button.title = 'Delete permanently, without archiving'
}

async function deleteAction(button) {
  if (!button.classList.contains('armed')) return arm(button)
  if (Date.now() - Number(button.dataset.armedAt) < ARM_GUARD_MS) return
  const id = button.dataset.id
  const session = sessions.find((s) => s.id === id)
  clearTimeout(Number(button.dataset.timer))
  button.classList.replace('armed', 'deleting')
  button.disabled = true
  const { ok, data } = await api(`/api/sessions/${id}/delete`)
  if (!ok) {
    button.classList.remove('deleting')
    button.disabled = false
    button.innerHTML = TRASH_ICON
    return toast(data.error ?? 'Could not delete this session')
  }
  toast(`Deleted ${session?.title ?? id}`)
  await loadSessions()
  if (current?.id !== id) return
  current.source.close()
  current = null
  els.entries.replaceChildren()
  location.hash = sessions[0]?.id ?? ''
  open(selectedId())
}

function rowButton(id, action, icon) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row-action'
  button.dataset.id = id
  button.dataset.action = action
  button.innerHTML = icon
  return button
}

function joinState(chat) {
  if (!chat || !(chat.joined || chat.state === 'starting')) return 'off'
  if (chat.leaving) return 'leaving'
  return CHAT_STATES[chat.state] && chat.state !== 'closed' ? chat.state : 'idle'
}

function paintJoin(button, chat) {
  const state = joinState(chat)
  button.className = `row-action join ${state}`
  button.setAttribute('aria-pressed', String(state !== 'off'))
  button.title = state !== 'off' && chat.mode === 'terminal' ? `${JOIN_TITLES[state]}. Messages go to your tmux terminal` : JOIN_TITLES[state]
}

function paintArchive(button, session) {
  button.disabled = Boolean(session.open || session.chat)
  button.title = button.disabled ? 'Close or leave this session before archiving it' : 'Archive'
}

function setRowChat(id, status) {
  const chat = joinState(status) === 'off' ? null : { joined: status.joined, mode: status.mode, state: status.state, leaving: status.leaving }
  const session = sessions.find((s) => s.id === id)
  if (session) session.chat = chat
  const selector = (action) => `button.row-action[data-action="${action}"][data-id="${CSS.escape(id)}"]`
  const join = els.sessions.querySelector(selector('join'))
  if (join) paintJoin(join, chat)
  const archive = els.sessions.querySelector(selector('archive'))
  if (archive && session) paintArchive(archive, session)
  const remove = els.sessions.querySelector(selector('delete'))
  if (remove && session && !remove.classList.contains('armed')) paintDelete(remove, session)
}

function badge(text, className, title) {
  const el = span(`badge ${className}`, text)
  el.title = title
  return el
}

function span(className, text) {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function selectedId() {
  return location.hash.slice(1) || sessions[0]?.id
}

function open(id) {
  if (!id || current?.id === id) return
  current?.source.close()
  collapse()
  setTerminal(false)
  lastChatState = ''
  els.entries.replaceChildren()
  els.context.hidden = true
  els.title.textContent = 'Loading'
  const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`)
  current = { id, source, lastSeq: -1, meta: null, chat: null }
  prompt.reset(localStorage.getItem(DRAFT_STORE + id) ?? '')
  showChat({ joined: false, state: 'closed', leaving: false, draft: '', asks: [], error: '' })
  paintChip()
  renderSessions()
  source.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data)
    current.meta = data.meta
    contextWindow = data.meta.window ?? contextWindow
    updateHeader(data.meta)
    replace(data.entries)
    showContext(data.context)
  })
  source.addEventListener('context', (event) => showContext(JSON.parse(event.data).tokens))
  source.addEventListener('append', (event) => append(JSON.parse(event.data).entries, false))
  source.addEventListener('reset', (event) => replace(JSON.parse(event.data).entries))
  source.addEventListener('remove', (event) => remove(JSON.parse(event.data).ids))
  source.addEventListener('chat', (event) => showChat(JSON.parse(event.data)))
  source.onopen = () => (els.status.textContent = 'live')
  source.onerror = () => (els.status.textContent = 'reconnecting')
}

function updateHeader(meta) {
  if (!meta) return
  current.meta = meta
  els.title.textContent = meta.title
  els.cwd.textContent = meta.cwd
  document.title = meta.title
  els.openBadge.hidden = !meta.open
  els.openBadge.className = `badge open ${meta.open ?? ''}`
  els.openBadge.textContent = meta.open ? `open in terminal, ${meta.open}` : ''
  paintDock()
}

function paintDock() {
  els.dock.hidden = !current || Boolean(current.meta?.archivedAt)
}

function replace(entries) {
  els.entries.replaceChildren()
  current.lastSeq = -1
  append(entries, true)
}

function nearBottom() {
  return els.main.scrollHeight - els.main.scrollTop - els.main.clientHeight < STICK_PX
}

function append(entries, jump) {
  const stick = jump || nearBottom()
  const fragment = document.createDocumentFragment()
  const added = []
  for (const entry of entries) {
    if (entry.seq <= current.lastSeq) continue
    current.lastSeq = entry.seq
    const article = entryElement(entry)
    added.push(article)
    fragment.append(article)
  }
  els.entries.append(fragment)
  markRollable(added)
  if (stick) els.main.scrollTop = els.main.scrollHeight
  repliesChanged()
}

function remove(ids) {
  for (const id of ids) els.entries.querySelector(`article[data-id="${CSS.escape(id)}"]`)?.remove()
  repliesChanged()
}

function repliesChanged() {
  annotator.sync()
  place()
}

function lastReply(id) {
  if (!current || current.id !== id) return null
  const articles = [...els.entries.children]
  let index = articles.findLastIndex((article) => article.classList.contains('reply'))
  if (index < 0) return null
  const parts = []
  for (; index >= 0 && !articles[index].classList.contains('prompt'); index--) {
    if (articles[index].classList.contains('reply')) parts.unshift(articles[index])
  }
  return { key: parts.map((article) => article.dataset.id).join(' '), text: parts.map((article) => sources.get(article) ?? '').join('\n\n') }
}

function entryElement(entry) {
  const article = document.createElement('article')
  article.className = `entry ${entry.kind}`
  article.dataset.id = entry.id
  article.dataset.lines = entry.lines
  if (entry.kind === 'event') return eventElement(article, entry)
  const header = document.createElement('header')
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'copy-entry'
  copy.title = 'Copy as Markdown'
  copy.innerHTML = COPY_ICON
  header.append(span('who', entry.label), span('when', entry.ts ? new Date(entry.ts).toLocaleTimeString() : ''))
  const body = document.createElement('div')
  body.className = 'body'
  body.innerHTML = entry.html
  const footer = document.createElement('footer')
  footer.append(copy)
  article.append(header, body, footer)
  sources.set(article, entry.markdown ?? '')
  return article
}

function eventElement(article, entry) {
  const body = document.createElement('div')
  body.className = 'body'
  body.innerHTML = entry.html
  if (entry.ts) body.append(span('when', new Date(entry.ts).toLocaleTimeString()))
  article.append(body)
  sources.set(article, entry.markdown ?? '')
  return article
}

function markRollable(articles) {
  const big = articles.filter((article) => article.querySelector(':scope > .body').scrollHeight > ROLLABLE_PX)
  for (const article of big) {
    const rolled = !article.classList.contains('reply')
    article.classList.add('rollable')
    article.classList.toggle('rolled', rolled)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'roll'
    button.title = 'Roll or unroll'
    button.setAttribute('aria-expanded', String(!rolled))
    button.innerHTML = CHEVRON
    const header = article.querySelector(':scope > header')
    header.prepend(button)
    header.append(span('size', `${article.dataset.lines} lines`))
  }
}

function toggleRoll(article) {
  const rolled = article.classList.toggle('rolled')
  article.querySelector(':scope > header .roll').setAttribute('aria-expanded', String(!rolled))
  if (rolled) article.scrollIntoView({ block: 'nearest' })
}

function showChat(status) {
  const stick = nearBottom()
  const chatting = isChatting(status)
  const finishing = status.joined && status.leaving
  if (current) {
    current.chat = status
    setRowChat(current.id, status)
  }
  const labels = status.mode === 'terminal' ? TERMINAL_STATES : CHAT_STATES
  paintDock()
  els.compose.classList.toggle('off', !chatting)
  els.compose.classList.toggle('finishing', Boolean(finishing))
  els.compose.title = chatting || finishing ? '' : 'Click to join this chat'
  prompt.setEnabled(chatting)
  els.send.hidden = !chatting
  els.chatState.textContent = finishing ? 'Claude is finishing this turn, then the chat closes' : labels[status.state] ?? status.state
  els.chatState.className = status.state
  els.chatState.title = status.where ?? ''
  els.stop.hidden = status.state !== 'working'
  els.send.disabled = !chatting || sending || status.state === 'waiting'
  els.chatNotice.hidden = !status.notice
  els.chatNotice.textContent = status.notice ?? ''
  els.chatError.hidden = !status.error
  els.chatError.textContent = status.error
  els.chatAttach.hidden = !status.attach
  els.chatAttach.textContent = status.attach ? `Open it in a terminal: ${status.attach}` : ''
  els.draft.hidden = !status.draft
  els.draft.textContent = status.draft
  renderAsks(status.asks)
  paintTerminal(status)
  if (stick) els.main.scrollTop = els.main.scrollHeight
  if (chatting && current?.focusOnJoin) {
    current.focusOnJoin = false
    focusPrompt()
  }
}

// The Terminal button shows for chats in tmux-web. The panel opens by itself when Claude starts waiting for an answer.
function paintTerminal(status) {
  els.terminalToggle.hidden = !status.terminal || status.state === 'starting'
  if (terminalOpen && terminal.name !== status.terminal) setTerminal(Boolean(status.terminal))
  if (status.terminal && status.state === 'waiting' && lastChatState !== 'waiting') {
    setTerminal(true)
    terminal.focus()
  }
  lastChatState = status.state
}

function renderAsks(asks) {
  const ids = asks.map((ask) => ask.id).join(' ')
  if (els.asks.dataset.ids === ids) return
  els.asks.dataset.ids = ids
  els.asks.replaceChildren(...asks.map(askCard))
}

function askCard(ask) {
  const card = document.createElement('div')
  card.className = 'ask'
  card.dataset.id = ask.id
  card.append(span('ask-title', ask.title))
  if (ask.detail) card.append(span('ask-detail', ask.detail))
  if (ask.questions?.length) {
    ask.questions.forEach((question, index) => card.append(questionBlock(question, index)))
  } else if (ask.input) {
    const pre = document.createElement('pre')
    pre.className = 'ask-input'
    pre.textContent = ask.input
    card.append(pre)
  }
  const actions = document.createElement('div')
  actions.className = 'ask-actions'
  const deny = document.createElement('button')
  deny.type = 'button'
  deny.dataset.decision = 'deny'
  deny.textContent = ask.questions?.length ? 'Skip' : 'Deny'
  const allow = document.createElement('button')
  allow.type = 'button'
  allow.className = 'primary'
  allow.dataset.decision = 'allow'
  allow.textContent = ask.questions?.length ? 'Send answers' : 'Allow'
  actions.append(deny, allow)
  card.append(actions)
  return card
}

function questionBlock(question, index) {
  const block = document.createElement('fieldset')
  block.className = 'question'
  block.dataset.question = question.question
  const legend = document.createElement('legend')
  legend.append(span('chip', question.header), span('q', question.question))
  block.append(legend)
  const type = question.multiSelect ? 'checkbox' : 'radio'
  for (const option of question.options) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = type
    input.name = `q${index}`
    input.value = option.label
    label.append(input, span('label', option.label))
    if (option.description) label.append(span('desc', option.description))
    block.append(label)
  }
  const other = document.createElement('input')
  other.type = 'text'
  other.className = 'other'
  other.placeholder = 'Other answer'
  block.append(other)
  return block
}

function collectAnswers(card) {
  const answers = {}
  for (const block of card.querySelectorAll('fieldset.question')) {
    const picked = [...block.querySelectorAll('input:checked')].map((input) => input.value)
    const other = block.querySelector('input.other').value.trim()
    if (other) picked.push(other)
    if (picked.length) answers[block.dataset.question] = picked.join(', ')
  }
  return answers
}

async function decide(button) {
  const card = button.closest('.ask')
  const behavior = button.dataset.decision
  const body = { behavior }
  if (behavior === 'allow' && card.querySelector('fieldset.question')) body.answers = collectAnswers(card)
  for (const control of card.querySelectorAll('button')) control.disabled = true
  const { ok, data } = await api(`/api/sessions/${current.id}/chat/asks/${encodeURIComponent(card.dataset.id)}`, body)
  if (!ok) {
    for (const control of card.querySelectorAll('button')) control.disabled = false
    toast(data.error ?? 'Could not send the decision')
  }
}

function isChatting(status) {
  return Boolean(status && (status.joined || status.state === 'starting') && !status.leaving)
}

async function toggleJoin(button) {
  const id = button.dataset.id
  const status = current?.id === id ? current.chat : sessions.find((s) => s.id === id)?.chat
  const state = joinState(status)
  if (state === 'leaving') return
  const active = state !== 'off'
  if (!active) {
    location.hash = id
    open(id)
    current.focusOnJoin = true
  }
  button.disabled = true
  const { ok, data } = await api(`/api/sessions/${id}/chat/${active ? 'leave' : 'join'}`)
  button.disabled = false
  if (!ok) return toast(data.error ?? 'Could not change the chat mode')
  if (current?.id === id) showChat(data)
  else setRowChat(id, data)
}

async function joinCurrent() {
  if (!current || current.joining || isChatting(current.chat) || joinState(current.chat) === 'leaving') return current?.chat
  const session = current
  session.joining = true
  session.focusOnJoin = true
  const { ok, data } = await api(`/api/sessions/${session.id}/chat/join`)
  session.joining = false
  if (!ok) {
    toast(data.error ?? 'Could not join this session')
    return null
  }
  if (current === session) showChat(data)
  else setRowChat(session.id, data)
  return data
}

function composeMessage() {
  return [annotator.notesText(), prompt.text().trim()].filter(Boolean).join('\n\n---\n\n')
}

async function sendMessage() {
  if (!current || sending) return
  if (annotator.blocked()) return expand()
  const text = composeMessage()
  if (!text) return
  const session = current
  sending = true
  els.send.disabled = true
  const joined = isChatting(session.chat) ? session.chat : await joinCurrent()
  const { ok, data } = isChatting(joined)
    ? await api(`/api/sessions/${session.id}/chat/messages`, { text })
    : { ok: false, data: {} }
  sending = false
  if (current === session) showChat(ok ? data : session.chat)
  if (!ok) return data.error && toast(data.error)
  if (current !== session) return
  annotator.clear()
  prompt.clear()
  collapse()
  focusPrompt()
}

function saveDraft() {
  if (!current) return
  const text = prompt.text()
  if (text.trim()) localStorage.setItem(DRAFT_STORE + current.id, text)
  else localStorage.removeItem(DRAFT_STORE + current.id)
}

function paintChip() {
  const count = current ? annotator.count(current.id) : 0
  els.notesChip.hidden = !count || expanded
  els.notesChip.textContent = `${count} note${count === 1 ? '' : 's'}`
  els.notesChip.title = 'Notes on the last reply. They go out with your message. Click to see them'
}

function paintExpand() {
  els.expand.innerHTML = expanded ? COLLAPSE_ICON : EXPAND_ICON
  els.expand.title = expanded ? 'Back to reading. Ctrl+G or Esc' : 'Take notes on the last reply, where it stands. Ctrl+G'
  els.expand.setAttribute('aria-pressed', String(expanded))
}

function viewport() {
  const main = els.main.getBoundingClientRect()
  const bottom = els.dock.hidden ? main.bottom : Math.min(main.bottom, els.dock.getBoundingClientRect().top)
  return { left: main.left, right: main.right, top: els.header.getBoundingClientRect().bottom, bottom }
}

function shownArticles() {
  const ids = new Set(annotator.shownKey().split(' ').filter(Boolean))
  return [...els.entries.querySelectorAll(':scope > article')].filter((article) => ids.has(article.dataset.id))
}

function place() {
  if (!expanded) return
  const shown = shownArticles()
  for (const article of els.entries.querySelectorAll(':scope > article')) article.classList.toggle('morphed', shown.includes(article))
  if (shown.length) {
    if (annotator.panel.nextElementSibling !== shown[0]) shown[0].before(annotator.panel)
  } else if (annotator.panel.parentElement !== els.entries) {
    els.entries.append(annotator.panel)
  }
  annotator.measure()
}

function atBottom() {
  return els.main.scrollHeight - els.main.scrollTop - els.main.clientHeight < 4
}

function stickToBottom() {
  els.main.scrollTop = els.main.scrollHeight
  pinned = true
}

function unplace() {
  for (const article of els.entries.querySelectorAll(':scope > article.morphed')) article.classList.remove('morphed')
  annotator.panel.remove()
}

function expand() {
  if (!current || expanded || current.meta?.archivedAt) return
  expanded = true
  annotator.open()
  const stick = nearBottom()
  const anchor = shownArticles()[0]
  const before = anchor?.getBoundingClientRect().top
  place()
  if (stick) stickToBottom()
  else if (anchor) els.main.scrollTop += annotator.panel.getBoundingClientRect().top - before
  paintExpand()
  paintChip()
  if (isChatting(current.chat)) focusPrompt()
  else joinCurrent()
}

function collapse() {
  if (!expanded) return
  expanded = false
  const stick = nearBottom()
  const anchor = annotator.panel.isConnected ? annotator.panel.getBoundingClientRect().top : null
  const first = els.entries.querySelector(':scope > article.morphed')
  unplace()
  if (stick) stickToBottom()
  else if (first && anchor !== null) els.main.scrollTop += first.getBoundingClientRect().top - anchor
  paintExpand()
  paintChip()
  focusPrompt()
}

async function rowAction(button) {
  if (button.dataset.action === 'join') return toggleJoin(button)
  if (button.dataset.action === 'delete') return deleteAction(button)
  const id = button.dataset.id
  const session = sessions.find((s) => s.id === id)
  button.disabled = true
  const { ok, data } = await api(`/api/sessions/${id}/${button.dataset.action}`)
  if (!ok) {
    button.disabled = false
    return toast(data.message || data.error || 'That did not work')
  }
  if (button.dataset.action === 'archive') toast(`Archived ${session?.title ?? id}`, 'Undo', () => restore(id))
  else toast(`Unarchived ${session?.title ?? id}`)
  await loadSessions()
}

async function restore(id) {
  const { ok, data } = await api(`/api/sessions/${id}/restore`)
  toast(ok ? 'Unarchived' : data.message || data.error || 'Could not unarchive')
  await loadSessions()
}

function toast(text, actionLabel, action) {
  clearTimeout(toastTimer)
  els.toastText.textContent = text
  els.toastAction.hidden = !actionLabel
  els.toastAction.textContent = actionLabel ?? ''
  els.toastAction.onclick = action
    ? () => {
        els.toast.hidden = true
        action()
      }
    : null
  els.toast.hidden = false
  toastTimer = setTimeout(() => (els.toast.hidden = true), TOAST_MS)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

function flash(button) {
  button.classList.add('done')
  setTimeout(() => button.classList.remove('done'), 1200)
}

document.addEventListener('click', async (event) => {
  const copyEntry = event.target.closest('button.copy-entry')
  if (copyEntry) {
    await copyText(sources.get(copyEntry.closest('article')) ?? '')
    return flash(copyEntry)
  }
  const header = event.target.closest('.entry.rollable > header')
  if (header) return toggleRoll(header.parentElement)
  const preview = event.target.closest('.entry.rolled > .body')
  if (preview && !event.target.closest('a, button') && !getSelection().toString()) return toggleRoll(preview.parentElement)
  const decision = event.target.closest('.ask button[data-decision]')
  if (decision) return decide(decision)
  const rowButton = event.target.closest('button.row-action')
  if (rowButton) return rowAction(rowButton)
  const tab = event.target.closest('button.tab')
  if (tab) {
    view = tab.dataset.view
    for (const other of document.querySelectorAll('button.tab')) other.classList.toggle('active', other === tab)
    return loadSessions()
  }
  const button = event.target.closest('button.copy')
  if (!button) return
  await copyText(button.parentElement.querySelector('code').textContent)
  flash(button)
})

els.stop.addEventListener('click', () => current && api(`/api/sessions/${current.id}/chat/interrupt`))
els.terminalToggle.addEventListener('click', () => {
  setTerminal(!terminalOpen)
  if (terminalOpen) terminal.focus()
})
els.chatAttach.addEventListener('click', async () => {
  if (!current?.chat?.attach) return
  await copyText(current.chat.attach)
  toast('Attach command copied')
})
els.compose.addEventListener('submit', (event) => {
  event.preventDefault()
  sendMessage()
})
els.compose.addEventListener('click', (event) => {
  if (els.compose.classList.contains('off') && !event.target.closest('button')) joinCurrent()
})
els.expand.addEventListener('click', () => (expanded ? collapse() : expand()))
els.notesChip.addEventListener('click', expand)
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'g' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    if (!current) return
    event.preventDefault()
    return expanded ? collapse() : expand()
  }
  if (expanded && event.key.toLowerCase() === 'm' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    event.preventDefault()
    return annotator.toggleLook()
  }
  if (event.key === 'Escape' && expanded && !event.defaultPrevented) collapse()
})
paintExpand()

async function showVersion() {
  const info = await fetch('/api/version')
    .then((response) => response.json())
    .catch(() => null)
  if (!info?.version) return
  const footer = $('version')
  footer.textContent = [`v${info.version}`, info.commit, info.changed ? 'local changes' : ''].filter(Boolean).join(' · ')
  footer.title = `code-web-companion ${info.version}${info.commit ? `, commit ${info.commit} from ${info.date}` : ''}${info.changed ? ', with uncommitted changes' : ''}`
}

new ResizeObserver(() => {
  document.documentElement.style.setProperty('--sticky-top', `${$('session-header').offsetHeight}px`)
}).observe($('session-header'))
els.main.addEventListener('scroll', () => (pinned = atBottom()), { passive: true })
new ResizeObserver(() => expanded && pinned && (els.main.scrollTop = els.main.scrollHeight)).observe(annotator.panel)

els.filter.addEventListener('input', renderSessions)
window.addEventListener('hashchange', () => open(selectedId()))

token = (await (await fetch('/api/token')).json()).token
void showVersion()
await loadSessions()
open(selectedId())
setInterval(loadSessions, REFRESH_MS)
