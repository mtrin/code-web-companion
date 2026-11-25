import {
  Compartment,
  EditorState,
  EditorView,
  HighlightStyle,
  Prec,
  defaultKeymap,
  drawSelection,
  history,
  historyKeymap,
  keymap,
  languages,
  markdown,
  markdownLanguage,
  placeholder,
  syntaxHighlighting,
  tags,
} from '/vendor/codemirror.js'

const READY = 'Message Claude. Ctrl+Enter sends, Enter adds a line, Ctrl+G opens the last reply for notes'
const IDLE = 'Click to join this chat'
const NOTE = 'Your note, in Markdown. Enter adds a line'

export const CODE_STYLES = [
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: '#c792ea' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a5c97f' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#e5a36b' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#6b7a6b', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#82aaff' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#e5c07b' },
  { tag: [tags.propertyName, tags.attributeName], color: '#9cdcfe' },
  { tag: [tags.operator, tags.punctuation], color: '#9a9a9a' },
]

export const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.heading, color: '#e8e8e8', fontWeight: '700' },
  { tag: tags.strong, color: '#e0e0e0', fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, color: '#cdb37e' },
  { tag: [tags.link, tags.url], color: '#6ea6dc' },
  { tag: tags.quote, color: '#8c8c8c', fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: '#626262' },
  ...CODE_STYLES,
])

const THEME = EditorView.theme(
  {
    '&': { color: 'var(--text)', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6' },
    '.cm-content': { padding: '2px 0', caretColor: '#9cc8f5' },
    '.cm-line': { padding: '0 2px' },
    '.cm-cursor': { borderLeftColor: '#9cc8f5' },
    '.cm-placeholder': { color: 'var(--muted)' },
  },
  { dark: true },
)

function markdownEditing(label) {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(HIGHLIGHT),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': label }),
    THEME,
  ]
}

export function createPrompt(parent, host) {
  const mode = new Compartment()
  let enabled = false

  const modeFor = (on) => [EditorView.editable.of(on), placeholder(on ? READY : IDLE)]

  const extensions = () => [
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (host.send(), true) }])),
    markdownEditing('Message to Claude'),
    EditorView.updateListener.of((update) => update.docChanged && host.changed()),
    mode.of(modeFor(enabled)),
  ]

  const view = new EditorView({ parent, state: EditorState.create({ extensions: extensions() }) })

  return {
    view,
    text: () => view.state.doc.toString(),
    reset(text) {
      view.setState(EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: extensions() }))
    },
    clear() {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    },
    setEnabled(on) {
      if (on === enabled) return
      enabled = on
      view.dispatch({ effects: mode.reconfigure(modeFor(on)) })
    },
    focus() {
      if (enabled) view.focus()
    },
  }
}

export function createNoteEditor(parent, host) {
  const extensions = () => [
    Prec.highest(
      keymap.of([
        { key: 'Mod-Enter', run: () => (host.save(), true) },
        { key: 'Escape', run: () => (host.cancel(), true) },
      ]),
    ),
    markdownEditing('Note on the selected text'),
    drawSelection(),
    placeholder(NOTE),
  ]

  const view = new EditorView({ parent, state: EditorState.create({ extensions: extensions() }) })

  return {
    view,
    text: () => view.state.doc.toString(),
    set(text) {
      if (text === view.state.doc.toString()) return
      view.setState(EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: extensions() }))
    },
    focus() {
      view.requestMeasure()
      view.focus()
    },
  }
}
