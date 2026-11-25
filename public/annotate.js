import {
  Compartment,
  Decoration,
  EditorSelection,
  EditorState,
  EditorView,
  StateEffect,
  StateField,
  WidgetType,
  drawSelection,
  ensureSyntaxTree,
  keymap,
  languages,
  markdown,
  markdownLanguage,
  showTooltip,
  standardKeymap,
  syntaxHighlighting,
  syntaxTree,
  tooltips,
} from '/vendor/codemirror.js'
import { renderedMarkdown } from './preview.js'
import { HIGHLIGHT, createNoteEditor } from './prompt.js'

const COLORS = 5
const DRAG_PX = 4
const ARM_MS = 4000
const STORE = 'code-web-companion:notes:'
const LOOK_STORE = 'code-web-companion:look'
const CODE = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock'])
const HEADING = /^(ATX|Setext)Heading\d$/
const MARKERS = /^\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/
const FENCE = /^\s*(```|~~~)/
const STRAY_CLOSE = /^[*_~]+(?=\s)/
const STRAY_OPEN = /^[*_~]+(?=\s|$)/
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' })
const words = new Intl.Segmenter(undefined, { granularity: 'word' })

export const COLLAPSE_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 6.5l4.5-4.5M6.5 9.5L2 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const THEME = EditorView.theme(
  {
    '&': { color: '#a8a8a8', backgroundColor: 'transparent', fontSize: '13.5px' },
    '&.cm-focused': { outline: 'none' },
    '& > .cm-scroller': { fontFamily: 'var(--an-mono)', lineHeight: '1.7' },
    '& > .cm-scroller > .cm-content': { padding: '8px 0 16px', caretColor: '#9cc8f5' },
    '& > .cm-scroller > .cm-content > .cm-line': { padding: '0' },
    '.cm-cursor': { borderLeftColor: '#9cc8f5' },
    '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: '#2a3a4c' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: '#2f4f73' },
    '.cm-tooltip.note-pop': {
      width: '400px',
      maxWidth: 'calc(100vw - 24px)',
      padding: '8px',
      background: '#252a31',
      border: '1px solid #3b4757',
      borderRadius: '8px',
      boxShadow: '0 10px 28px rgb(0 0 0 / 50%)',
    },
  },
  { dark: true },
)

class Badge extends WidgetType {
  constructor(number, id, color) {
    super()
    this.number = number
    this.id = id
    this.color = color
  }

  eq(other) {
    return other.number === this.number && other.id === this.id && other.color === this.color
  }

  toDOM(view) {
    const badge = view.dom.ownerDocument.createElement('span')
    badge.className = `cm-badge ${this.color}`
    badge.dataset.note = this.id
    badge.title = 'Edit this note'
    badge.textContent = String(this.number)
    return badge
  }
}

function treeOf(state) {
  return ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state)
}

function trimmed(state, from, to) {
  const text = state.sliceDoc(from, to)
  const start = from + (text.length - text.trimStart().length)
  const end = to - (text.length - text.trimEnd().length)
  return start < end ? { from: start, to: end } : null
}

function lineUnit(state, pos) {
  const line = state.doc.lineAt(pos)
  return trimmed(state, line.from + line.text.match(MARKERS)[0].length, line.to)
}

function codeLevels(state, node, pos) {
  const line = state.doc.lineAt(pos)
  const body = node.getChild('CodeText') ?? node
  const block = trimmed(state, body.from, body.to)
  return [FENCE.test(line.text) ? block : trimmed(state, line.from, line.to), wordAt(state, pos), block]
}

function headingUnit(state, node) {
  const line = state.doc.lineAt(node.from)
  const lead = line.text.match(/^\s*#*\s*/)[0].length
  return trimmed(state, line.from + lead, line.from + line.text.replace(/\s+#+\s*$/, '').length)
}

function sentenceUnit(state, from, to, pos) {
  const text = state.sliceDoc(from, to)
  if (!text) return null
  const segment = sentences.segment(text).containing(Math.max(0, Math.min(pos - from, text.length - 1)))
  if (!segment) return null
  const start = from + segment.index
  const end = start + segment.segment.length
  const lead = state.sliceDoc(start, end).match(STRAY_CLOSE)?.[0].length ?? 0
  const tail = state.sliceDoc(end, to).match(STRAY_OPEN)?.[0].length ?? 0
  return trimmed(state, start + lead, end + tail)
}

function levelsAt(state, pos) {
  const tree = treeOf(state)
  for (const side of [1, -1]) {
    for (let node = tree.resolveInner(pos, side); node; node = node.parent) {
      if (CODE.has(node.name)) return codeLevels(state, node, pos)
      if (node.name === 'TableCell') {
        const row = node.parent ?? node
        return [trimmed(state, node.from, node.to), wordAt(state, pos), trimmed(state, row.from, row.to)]
      }
      if (HEADING.test(node.name)) {
        const heading = headingUnit(state, node)
        return [heading, wordAt(state, pos), heading]
      }
      if (node.name === 'Paragraph') {
        return [sentenceUnit(state, node.from, node.to, pos), wordAt(state, pos), trimmed(state, node.from, node.to)]
      }
    }
  }
  const line = lineUnit(state, pos)
  return [line, wordAt(state, pos), line]
}

function wordAt(state, pos) {
  for (let node = treeOf(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name !== 'InlineCode') continue
    const marks = node.getChildren('CodeMark')
    if (marks.length === 2) return trimmed(state, marks[0].to, marks[1].from)
  }
  const line = state.doc.lineAt(pos)
  if (!line.length) return null
  const offset = Math.min(pos - line.from, line.length - 1)
  const segments = words.segment(line.text)
  const segment = [segments.containing(offset), segments.containing(Math.max(0, offset - 1))].find((item) => item?.isWordLike)
  return segment ? { from: line.from + segment.index, to: line.from + segment.index + segment.segment.length } : null
}

function pickUnit(state, pos) {
  const levels = levelsAt(state, pos).filter(Boolean)
  const { from, to, empty } = state.selection.main
  const same = (unit) => unit.from === from && unit.to === to
  const index = !empty && pos >= from && pos <= to ? levels.findIndex(same) : -1
  if (index < 0) return levels[0] ?? null
  for (let step = 1; step < levels.length; step++) {
    const next = levels[(index + step) % levels.length]
    if (!same(next)) return next
  }
  return levels[index]
}

const clickRules = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null
  const start = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
  const unit = pickUnit(view.state, start)
  let dragged = false
  return {
    get(current) {
      dragged ||= Math.abs(current.clientX - event.clientX) + Math.abs(current.clientY - event.clientY) > DRAG_PX
      if (dragged) return EditorSelection.single(start, view.posAtCoords({ x: current.clientX, y: current.clientY }, false))
      return unit ? EditorSelection.single(unit.from, unit.to) : EditorSelection.single(start)
    },
    update: () => false,
  }
})

function element(tag, className, html) {
  const el = document.createElement(tag)
  el.className = className
  if (html) el.innerHTML = html
  return el
}

function restore(id) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE + id) ?? 'null')
    return saved?.notes?.length && typeof saved.text === 'string' ? saved : null
  } catch {
    return null
  }
}

export function createAnnotator(host) {
  const panel = element(
    'section',
    'annotator',
    `<header class="an-bar">
      <span class="an-title">Last reply</span>
      <span class="an-status"></span>
      <button type="button" class="an-newer" data-act="newer" hidden></button>
      <span class="an-look" role="group" aria-label="How the reply is shown">
        <button type="button" data-look="rendered" title="Show the reply formatted. Ctrl+M switches">Rendered</button>
        <button type="button" data-look="source" title="Show the reply as Markdown text. Ctrl+M switches">Markdown</button>
      </span>
      <button type="button" data-act="copy" title="Copy your message and these notes as one Markdown message">Copy</button>
      <button type="button" class="an-icon" data-act="collapse" title="Back to reading. Ctrl+G or Esc">${COLLAPSE_ICON}</button>
    </header>
    <div class="an-editor"></div>
    <ol class="an-notes" hidden></ol>`,
  )
  const pop = element(
    'div',
    'note-body',
    `<div class="note-editor"></div>
    <div class="pop-bar">
      <span class="pop-hint">Ctrl+Enter saves, Esc closes</span>
      <button type="button" data-act="remove">Remove</button>
      <button type="button" class="primary" data-act="save">Save</button>
    </div>`,
  )
  const part = (selector) => panel.querySelector(selector)
  const parts = {
    bar: part('.an-bar'),
    status: part('.an-status'),
    newer: part('.an-newer'),
    editor: part('.an-editor'),
    notes: part('.an-notes'),
  }
  const noteEditor = createNoteEditor(pop.querySelector('.note-editor'), { save: () => save(), cancel: () => cancel() })
  const removeButton = pop.querySelector('[data-act="remove"]')
  const saveButton = pop.querySelector('[data-act="save"]')

  let session = null
  let reply = null
  let view = null
  let newer = null
  let message = null
  let armTimer = 0
  let rendered = localStorage.getItem(LOOK_STORE) !== 'source'

  const look = new Compartment()
  const lookFor = () => (rendered ? renderedMarkdown : syntaxHighlighting(HIGHLIGHT))
  const setNotes = StateEffect.define()
  const setTarget = StateEffect.define()

  const notesField = StateField.define({
    create: () => [],
    update(notes, tr) {
      for (const effect of tr.effects) if (effect.is(setNotes)) notes = effect.value
      return notes
    },
    provide: (field) => EditorView.decorations.from(field, noteMarks),
  })

  const targetField = StateField.define({
    create: () => null,
    update(target, tr) {
      for (const effect of tr.effects) if (effect.is(setTarget)) target = effect.value
      return target
    },
    provide: (field) => [
      showTooltip.from(field, popTooltip),
      EditorView.decorations.from(field, (target) =>
        target ? Decoration.set([Decoration.mark({ class: 'cm-target' }).range(target.from, target.to)]) : Decoration.none,
      ),
    ],
  })

  const extensions = [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    drawSelection(),
    clickRules,
    tooltips({ tooltipSpace: () => visibleArea() }),
    keymap.of([
      { key: 'Enter', run: () => aim() },
      { key: 'Escape', run: () => cancel() || collapse() },
      { key: 'Mod-Enter', run: () => (host.send(), true) },
      ...standardKeymap,
    ]),
    EditorView.domEventHandlers({
      dragstart(event) {
        event.preventDefault()
        return true
      },
    }),
    EditorView.updateListener.of(onUpdate),
    targetField,
    THEME,
  ]

  function noteMarks(notes) {
    const ranges = []
    notes.forEach((note, index) => {
      const color = `c${index % COLORS}`
      ranges.push(Decoration.mark({ class: `cm-note ${color}` }).range(note.from, note.to))
      ranges.push(Decoration.widget({ widget: new Badge(index + 1, note.id, color), side: -1 }).range(note.to))
    })
    return Decoration.set(ranges, true)
  }

  function popTooltip(target) {
    if (!target) return null
    return {
      pos: target.to,
      above: false,
      create: (editor) => {
        const dom = element('div', 'note-pop')
        dom.append(pop)
        const getCoords = (pos) =>
          editor.coordsAtPos(pos, -1) ?? editor.coordsAtPos(pos, 1) ?? editor.coordsAtPos(target.from, 1) ?? { left: 0, right: 0, top: -1e4, bottom: -1e4 }
        return { dom, offset: { x: 0, y: 6 }, resize: false, mount: () => noteEditor.focus(), getCoords }
      },
    }
  }

  function notes() {
    return view?.state.field(notesField) ?? []
  }

  function onUpdate(update) {
    if (update.startState.field(notesField) !== update.state.field(notesField)) {
      message = null
      persist()
      render()
      host.changed()
    }
    if (update.startState.field(targetField) !== update.state.field(targetField)) {
      if (message?.error) say(null)
      paintPop()
    }
  }

  function persist() {
    const list = notes()
    if (list.length) localStorage.setItem(STORE + session, JSON.stringify({ key: reply.key, text: reply.text, notes: list }))
    else localStorage.removeItem(STORE + session)
  }

  function load(id, data, saved = []) {
    session = id
    reply = { key: data.key, text: data.text }
    newer = null
    message = null
    noteEditor.set('')
    const state = EditorState.create({ doc: data.text, extensions: [extensions, look.of(lookFor()), notesField.init(() => saved)] })
    if (view) view.setState(state)
    else view = new EditorView({ state, parent: parts.editor })
    render()
  }

  function prepare() {
    const id = host.currentId()
    if (!id) return null
    const latest = host.lastReply(id)
    if (id !== session) {
      const saved = restore(id)
      if (saved) load(id, saved, saved.notes)
      else load(id, latest ?? { key: '', text: '' })
      if (saved && latest && saved.key !== latest.key) newer = latest
    }
    return latest
  }

  function hasWork() {
    return notes().length > 0 || noteEditor.text().trim() !== ''
  }

  function aim() {
    if (!view) return false
    const range = view.state.selection.main
    if (range.empty) return false
    const target = view.state.field(targetField)
    if (target && target.from === range.from && target.to === range.to) return true
    const existing = notes().find((note) => note.from === range.from && note.to === range.to)
    if (existing) noteEditor.set(existing.text)
    else if (target?.id) noteEditor.set('')
    view.dispatch({ effects: setTarget.of({ from: range.from, to: range.to, id: existing?.id ?? null }) })
    return true
  }

  function edit(id) {
    const note = notes().find((item) => item.id === id)
    if (!note || !view) return
    noteEditor.set(note.text)
    view.dispatch({
      selection: EditorSelection.single(note.from, note.to),
      effects: [setTarget.of({ from: note.from, to: note.to, id }), EditorView.scrollIntoView(note.from, { y: 'center' })],
    })
  }

  function save() {
    const target = view?.state.field(targetField)
    if (!target) return
    const text = noteEditor.text().trim()
    let list = notes()
    if (target.id) list = text ? list.map((note) => (note.id === target.id ? { ...note, text } : note)) : list.filter((note) => note.id !== target.id)
    else if (text) list = [...list, { id: crypto.randomUUID(), from: target.from, to: target.to, text }]
    noteEditor.set('')
    view.dispatch({ effects: [setNotes.of(list), setTarget.of(null)], selection: EditorSelection.cursor(target.to) })
    view.focus()
  }

  function removeNote() {
    const target = view?.state.field(targetField)
    if (!target?.id) return
    noteEditor.set('')
    view.dispatch({ effects: [setNotes.of(notes().filter((note) => note.id !== target.id)), setTarget.of(null)] })
    view.focus()
  }

  function cancel() {
    if (!view?.state.field(targetField)) return false
    noteEditor.set('')
    view.dispatch({ effects: setTarget.of(null) })
    view.focus()
    return true
  }

  function collapse() {
    if (!view || view.state.selection.main.empty) return false
    view.dispatch({ selection: EditorSelection.cursor(view.state.selection.main.head) })
    return true
  }

  function paintPop() {
    const target = view?.state.field(targetField)
    removeButton.hidden = !target?.id
    saveButton.textContent = target?.id ? 'Update' : 'Save'
  }

  function notesText() {
    prepare()
    if (!notes().length) return ''
    const doc = view.state.doc
    const items = notes().map((note, index) => {
      const quote = doc
        .sliceString(note.from, note.to)
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
      quote[quote.length - 1] += ` [${index + 1}]`
      return [quote.join('\n'), note.text.trim()].filter(Boolean).join('\n\n')
    })
    return ['Notes on your last reply. Each one quotes the part it is about.', ...items].join('\n\n')
  }

  function blocked() {
    prepare()
    if (!view?.state.field(targetField) || !noteEditor.text().trim()) return false
    say('Save or close the open note first', true)
    return true
  }

  function clear() {
    if (!view || host.currentId() !== session) return
    noteEditor.set('')
    view.dispatch({ effects: [setNotes.of([]), setTarget.of(null)] })
  }

  function count(id) {
    if (id === session) return notes().length
    return restore(id)?.notes.length ?? 0
  }

  function say(text, error = false) {
    message = text ? { text, error } : null
    paintStatus()
  }

  async function copy() {
    const text = host.compose()
    if (!text) return say('Nothing to copy yet. Write a message or add a note')
    try {
      await navigator.clipboard.writeText(text)
      say('Copied your message and the notes as one Markdown message')
    } catch {
      say('Could not reach the clipboard', true)
    }
  }

  function takeNewer() {
    if (!newer) return
    const total = notes().length
    if (total && !parts.newer.classList.contains('armed')) {
      parts.newer.classList.add('armed')
      parts.newer.textContent = `Drop ${total} note${total === 1 ? '' : 's'}?`
      clearTimeout(armTimer)
      armTimer = setTimeout(() => paintNewer(), ARM_MS)
      return
    }
    localStorage.removeItem(STORE + session)
    load(session, newer)
    host.changed()
  }

  function render() {
    if (!session) return
    panel.classList.toggle('empty', !reply.text)
    paintNewer()
    paintNotes()
    paintStatus()
    paintPop()
  }

  function visibleArea() {
    const area = host.viewport()
    return { ...area, top: Math.max(area.top, parts.bar.getBoundingClientRect().bottom) }
  }

  function lineTop(pos) {
    const { node } = view.domAtPos(pos)
    return (node.nodeType === 1 ? node : node.parentElement)?.closest('.cm-line')?.getBoundingClientRect().top ?? null
  }

  function setLook(next) {
    if (next !== rendered) {
      rendered = next
      localStorage.setItem(LOOK_STORE, rendered ? 'rendered' : 'source')
      if (view) {
        const area = visibleArea()
        const pos = view.lineBlockAtHeight(Math.max(0, (area.top + area.bottom) / 2 - view.documentTop)).from
        const before = lineTop(pos)
        view.dispatch({ effects: look.reconfigure(lookFor()) })
        const after = lineTop(pos)
        if (before !== null && after !== null) host.scroller().scrollTop += after - before
      }
    }
    paintLook()
  }

  function paintLook() {
    for (const button of panel.querySelectorAll('[data-look]')) {
      button.setAttribute('aria-pressed', String((button.dataset.look === 'rendered') === rendered))
    }
  }

  function paintNewer() {
    clearTimeout(armTimer)
    parts.newer.classList.remove('armed')
    parts.newer.hidden = !newer
    parts.newer.textContent = 'Newer reply'
    parts.newer.title = notes().length ? 'Load the newest reply. Two clicks, because it drops these notes' : 'Load the newest reply'
  }

  function paintNotes() {
    const list = notes()
    parts.notes.hidden = !list.length
    parts.notes.replaceChildren(
      ...list.map((note, index) => {
        const item = element('li', `c${index % COLORS}`)
        item.dataset.note = note.id
        item.title = 'Edit this note'
        const quote = view.state.sliceDoc(note.from, note.to).replace(/\s+/g, ' ')
        item.append(element('span', 'n'), element('span', 'q'), element('span', 't'))
        item.children[0].textContent = String(index + 1)
        item.children[1].textContent = quote
        item.children[2].textContent = note.text
        return item
      }),
    )
  }

  function paintStatus() {
    const total = notes().length
    let idle = 'Click for a sentence, again for the word, again for the paragraph, or drag. Then type a note'
    if (!reply?.text) idle = 'No reply from Claude yet'
    else if (total) idle = `${total} note${total === 1 ? '' : 's'}. They go out with your message, each with its quote`
    parts.status.textContent = message?.text ?? idle
    parts.status.classList.toggle('error', Boolean(message?.error))
  }

  function open() {
    const latest = prepare()
    if (!session) return
    if (latest && latest.key !== reply.key && latest.key !== newer?.key) {
      if (hasWork()) newer = latest
      else load(session, latest)
    }
    if (!message?.error) message = null
    render()
    view.requestMeasure()
  }

  function sync() {
    if (!session || !host.expanded() || host.currentId() !== session) return
    const latest = host.lastReply(session)
    if (!latest || latest.key === reply.key || latest.key === newer?.key) return
    if (hasWork()) {
      newer = latest
      paintNewer()
    } else {
      load(session, latest)
    }
  }

  panel.addEventListener('mouseup', (event) => {
    if (event.button !== 0 || !event.target.closest('.an-editor') || event.target.closest('.note-pop, .cm-badge')) return
    setTimeout(aim)
  })

  panel.addEventListener('click', (event) => {
    const note = event.target.closest('.cm-badge, .an-notes li')
    if (note) return edit(note.dataset.note)
    const choice = event.target.closest('button[data-look]')
    if (choice) return setLook(choice.dataset.look === 'rendered')
    const action = event.target.closest('button[data-act]')?.dataset.act
    if (action === 'save') save()
    else if (action === 'remove') removeNote()
    else if (action === 'copy') copy()
    else if (action === 'newer') takeNewer()
    else if (action === 'collapse') host.collapse()
  })

  paintLook()

  return {
    panel,
    open,
    sync,
    notesText,
    blocked,
    clear,
    count,
    toggleLook: () => setLook(!rendered),
    shownKey: () => reply?.key ?? '',
    measure: () => view?.requestMeasure(),
  }
}
