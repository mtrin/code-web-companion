import {
  Decoration,
  EditorView,
  HighlightStyle,
  StateField,
  WidgetType,
  ensureSyntaxTree,
  syntaxHighlighting,
  syntaxTree,
  tags,
} from '/vendor/codemirror.js'
import { CODE_STYLES } from './prompt.js'

const LIST_EM = 1.7
const QUOTE_PX = 16
const CELL_CAP = 60
const HEADING = /^(?:ATX|Setext)Heading(\d)$/
const LISTS = new Set(['BulletList', 'OrderedList'])

const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.heading, color: '#ececec', fontWeight: '700' },
  { tag: tags.strong, color: '#ececec', fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: '#6ab0f3' },
  ...CODE_STYLES,
])

class Marker extends WidgetType {
  constructor(text, kind) {
    super()
    this.text = text
    this.kind = kind
  }

  eq(other) {
    return other.text === this.text && other.kind === this.kind
  }

  toDOM(view) {
    const marker = view.dom.ownerDocument.createElement('span')
    marker.className = `cm-md-${this.kind}`
    marker.textContent = this.text
    return marker
  }

  ignoreEvent() {
    return false
  }
}

class EmptyCells extends WidgetType {
  constructor(count) {
    super()
    this.count = count
  }

  eq(other) {
    return other.count === this.count
  }

  toDOM(view) {
    const doc = view.dom.ownerDocument
    const group = doc.createElement('span')
    group.className = 'cm-md-cells'
    for (let index = 0; index < this.count; index++) {
      const cell = doc.createElement('span')
      cell.className = 'cm-md-cell'
      group.append(cell)
    }
    return group
  }

  ignoreEvent() {
    return false
  }
}

const CELL = Decoration.mark({ class: 'cm-md-cell', inclusive: true })
const INLINE_CODE = Decoration.mark({ class: 'cm-md-code' })
const LINK = Decoration.mark({ class: 'cm-md-link' })
const LANG = Decoration.mark({ class: 'cm-md-lang' })
const HIDE = Decoration.replace({})
const HIDE_LINE = Decoration.replace({ block: true })

function rowCells(row) {
  const cells = []
  let open = false
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableCell') {
      cells.push({ from: child.from, to: child.to })
      open = false
    } else if (child.name === 'TableDelimiter') {
      if (open) cells.push({ from: child.from, to: child.from, empty: true })
      open = true
    }
  }
  return cells
}

function quoteBars(depth) {
  return Array.from({ length: depth }, (_, index) => `linear-gradient(#4a4a4a, #4a4a4a) ${index * QUOTE_PX}px 0 / 3px 100% no-repeat`).join(', ')
}

function lineStyle(entry) {
  const parts = []
  const indent = []
  if (entry.quote) indent.push(`${entry.quote * QUOTE_PX}px`)
  if (entry.list) indent.push(`${entry.list * LIST_EM}em`)
  if (indent.length) parts.push(`${entry.code ? 'margin-left' : 'padding-left'}: calc(${indent.join(' + ')})`)
  if (entry.hang && !entry.code) parts.push(`text-indent: -${LIST_EM}em`)
  if (entry.quote && !entry.code) parts.push(`background: ${quoteBars(entry.quote)}`)
  if (entry.grid) parts.push(`grid-template-columns: ${entry.grid}`)
  return parts.join('; ')
}

function settle(swaps) {
  const kept = []
  for (const swap of swaps.sort((a, b) => a.from - b.from || b.to - a.to)) {
    const last = kept.at(-1)
    if (last && swap.from < last.to) {
      if (!swap.widget && !swap.block && !last.widget && !last.block) last.to = Math.max(last.to, swap.to)
      continue
    }
    kept.push({ ...swap })
  }
  return kept
}

function build(state) {
  const doc = state.doc
  const tree = ensureSyntaxTree(state, doc.length, 200) ?? syntaxTree(state)
  const lines = new Map()
  const marks = []
  const swaps = []

  const info = (pos) => {
    const line = doc.lineAt(pos)
    let entry = lines.get(line.number)
    if (!entry) lines.set(line.number, (entry = { line, classes: new Set(), quote: 0, list: 0, hang: false, code: false, grid: '' }))
    return entry
  }
  const each = (from, to, apply) => {
    for (let number = doc.lineAt(from).number, last = doc.lineAt(to).number; number <= last; number++) apply(info(doc.line(number).from))
  }
  const swap = (from, to, widget = null, block = false) => swaps.push({ from, to, widget, block })
  const spaces = (pos, max = Infinity) => {
    const end = doc.lineAt(pos).to
    let at = pos
    while (at < end && at - pos < max && doc.sliceString(at, at + 1) === ' ') at++
    return at
  }

  function headerMark(node) {
    if (node.parent?.name.startsWith('Setext')) return swap(node.from, node.to)
    const line = doc.lineAt(node.from)
    if (!doc.sliceString(line.from, node.from).trim()) return swap(line.from, spaces(node.to))
    let start = node.from
    while (start > line.from && doc.sliceString(start - 1, start) === ' ') start--
    swap(start, node.to)
  }

  function link(node) {
    const brackets = node.getChildren('LinkMark')
    if (brackets.length < 2) return
    swap(brackets[0].from, brackets[0].to)
    if (brackets[0].to < brackets[1].from) marks.push(LINK.range(brackets[0].to, brackets[1].from))
    swap(brackets[1].from, node.to)
  }

  function listItem(node) {
    let depth = 0
    for (let parent = node.parent; parent; parent = parent.parent) if (LISTS.has(parent.name)) depth++
    each(node.from, node.to, (entry) => (entry.list = Math.max(entry.list, depth)))
    info(node.from).hang = true
  }

  function listMark(node) {
    const ordered = node.parent?.parent?.name === 'OrderedList'
    const task = node.nextSibling?.name === 'Task'
    const text = ordered ? doc.sliceString(node.from, node.to) : task ? '' : '•'
    swap(node.from, spaces(node.to, 1), new Marker(text, 'bullet'))
  }

  function fenced(node) {
    const first = doc.lineAt(node.from)
    each(node.from, node.to, (entry) => {
      entry.code = true
      entry.classes.add('cm-md-pre')
    })
    info(first.from).classes.add('cm-md-pre-top')
    const open = node.firstChild
    if (open?.name === 'CodeMark') swap(open.from, open.to)
    const lang = node.getChild('CodeInfo')
    if (lang) marks.push(LANG.range(lang.from, lang.to))
    const close = node.lastChild
    if (close?.name === 'CodeMark' && close.from > first.to) {
      info(close.from).classes.add('cm-md-pre-bottom')
      swap(close.from, close.to)
    }
  }

  function table(node) {
    const rows = []
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'TableHeader' || child.name === 'TableRow') rows.push({ node: child, cells: rowCells(child) })
      else if (child.name === 'TableDelimiter') {
        const line = doc.lineAt(child.from)
        swap(line.from, line.to, null, true)
      }
    }
    const widths = []
    for (const row of rows) {
      row.cells.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 3, Math.min(cell.to - cell.from, CELL_CAP))))
    }
    const grid = widths.map((width) => `minmax(0, calc(${Math.ceil(width * 0.85) + 2}ch + 26px))`).join(' ')
    for (const row of rows) tableRow(row, grid, widths.length)
  }

  function tableRow(row, grid, columns) {
    const line = doc.lineAt(row.node.from)
    const entry = info(line.from)
    entry.classes.add(row.node.name === 'TableHeader' ? 'cm-md-th' : 'cm-md-tr')
    entry.grid = grid
    let at = line.from
    let empty = 0
    const gap = (to, extra = 0) => {
      const count = empty + extra
      if (at < to || count) swap(at, to, count ? new EmptyCells(count) : null)
      empty = 0
    }
    for (const cell of row.cells) {
      if (cell.empty) {
        empty++
        continue
      }
      gap(cell.from)
      marks.push(CELL.range(cell.from, cell.to))
      at = cell.to
    }
    gap(line.to, Math.max(0, columns - row.cells.length))
  }

  tree.iterate({
    enter(ref) {
      const node = ref.node
      const heading = HEADING.exec(node.name)
      if (heading) each(node.from, node.to, (entry) => entry.classes.add(`cm-md-h${heading[1]}`))
      switch (node.name) {
        case 'HeaderMark':
          return headerMark(node)
        case 'EmphasisMark':
        case 'StrikethroughMark':
          return swap(node.from, node.to)
        case 'Escape':
          return swap(node.from, node.from + 1)
        case 'InlineCode':
          marks.push(INLINE_CODE.range(node.from, node.to))
          return
        case 'CodeMark':
          if (node.parent?.name === 'InlineCode') swap(node.from, node.to)
          return
        case 'Link':
          return link(node)
        case 'LinkMark':
          if (node.parent?.name === 'Autolink') swap(node.from, node.to)
          return
        case 'URL':
          if (node.parent?.name !== 'Link' && node.parent?.name !== 'Image') marks.push(LINK.range(node.from, node.to))
          return
        case 'QuoteMark': {
          const entry = info(node.from)
          entry.quote++
          entry.classes.add('cm-md-quote')
          return swap(node.from, spaces(node.to, 1))
        }
        case 'ListItem':
          return listItem(node)
        case 'ListMark':
          return listMark(node)
        case 'TaskMarker':
          return swap(node.from, spaces(node.to, 1), new Marker(/x/i.test(doc.sliceString(node.from, node.to)) ? '☑' : '☐', 'task'))
        case 'HorizontalRule':
          info(node.from).classes.add('cm-md-hr')
          return swap(node.from, node.to)
        case 'FencedCode':
          fenced(node)
          return false
        case 'CodeBlock':
          each(node.from, node.to, (entry) => {
            entry.code = true
            entry.classes.add('cm-md-pre')
          })
          return false
        case 'Table':
          return table(node)
      }
    },
  })

  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number)
    const entry = lines.get(number)
    if (entry?.code) continue
    if (!line.text.trim()) info(line.from).classes.add('cm-md-blank')
    else if (entry?.list) {
      const lead = spaces(line.from)
      if (lead > line.from) swap(line.from, lead)
    }
  }

  const ranges = []
  for (const entry of lines.values()) {
    const style = lineStyle(entry)
    if (!entry.classes.size && !style) continue
    ranges.push(Decoration.line({ class: [...entry.classes].join(' '), attributes: style ? { style } : {} }).range(entry.line.from))
  }
  const hidden = settle(swaps)
  for (const item of hidden) {
    const deco = item.block ? HIDE_LINE : item.widget ? Decoration.replace({ widget: item.widget }) : HIDE
    ranges.push(deco.range(item.from, item.to))
  }
  return {
    decorations: Decoration.set(ranges, true),
    outer: Decoration.set(marks, true),
    atomic: Decoration.set(
      hidden.filter((item) => !item.block && item.from < item.to).map((item) => HIDE.range(item.from, item.to)),
      true,
    ),
  }
}

const rendered = StateField.define({
  create: (state) => build(state),
  update: (value, tr) => (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? build(tr.state) : value),
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.outerDecorations.from(field, (value) => value.outer),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
})

export const renderedMarkdown = [rendered, syntaxHighlighting(HIGHLIGHT), EditorView.editorAttributes.of({ class: 'cm-rendered' })]
