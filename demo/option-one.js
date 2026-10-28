import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from 'prosemirror-schema-basic'
import { exampleSetup } from 'prosemirror-example-setup'
import { syncPlugin, configureYProsemirror } from '../src/index.js'
import { suggestionDecorations } from './deletion-widgets.js'

const baseDoc = new Y.Doc({ gc: false })
const suggestionDoc = new Y.Doc({ gc: false, isSuggestionDoc: true })
baseDoc.get().applyDelta(delta.create().insert([
  delta.create('paragraph', {}, 'Hello wonderful world. Try deleting a word.'),
  delta.create('paragraph', {}, 'Delete this entire paragraph to test a block widget.'),
  delta.create('paragraph', {}, 'This final paragraph survives.')
]).done())
Y.applyUpdate(suggestionDoc, Y.encodeStateAsUpdate(baseDoc))
const renderer = Y.createDiffRenderer(baseDoc, suggestionDoc)
const root = suggestionDoc.get()

/** @param {string} id */
const element = id => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el
}

const view = new EditorView(element('editor'), {
  state: EditorState.create({
    schema,
    plugins: [
      ...exampleSetup({ schema, history: false }),
      syncPlugin(),
      suggestionDecorations(root, renderer, (records, view, insertions) => {
        element('deletions').textContent = JSON.stringify(records, null, 2)
        element('insertions').textContent = JSON.stringify(insertions, null, 2)
        element('live-json').textContent = JSON.stringify(view.state.doc.toJSON(), null, 2)
        const unresolved = records.filter(r => r.position == null).length + insertions.filter(r => r.from == null || r.to == null).length
        element('status').textContent = `${records.length} deletion(s), ${insertions.length} insertion(s), ${unresolved} unresolved. All suggestion styling is decorations, not PM marks.`
      })
    ]
  })
})
configureYProsemirror({ ytype: root, renderer: null })(view.state, view.dispatch)
element('accept').onclick = () => renderer.acceptAllChanges()
element('reject').onclick = () => renderer.rejectAllChanges()
element('reset').onclick = () => window.location.reload()
element('insert-text').onclick = () => view.dispatch(view.state.tr.insertText('Suggested ', 1))
element('insert-block').onclick = () => view.dispatch(view.state.tr.insert(
  view.state.doc.content.size, schema.nodes.paragraph.create(null, schema.text('A newly suggested paragraph.'))
))
element('delete-word').onclick = () => {
  const text = view.state.doc.firstChild?.textContent ?? ''
  const index = text.indexOf('wonderful ')
  if (index >= 0) view.dispatch(view.state.tr.delete(index + 1, index + 11))
}
element('delete-block').onclick = () => {
  const first = view.state.doc.firstChild
  const second = view.state.doc.childCount > 1 ? view.state.doc.child(1) : null
  if (first && second) view.dispatch(view.state.tr.delete(first.nodeSize, first.nodeSize + second.nodeSize))
}

// Local-only inspection; no provider or changes to the root's default renderer.
// @ts-ignore
window.optionOne = { baseDoc, suggestionDoc, renderer, root, view }
window.addEventListener('pagehide', () => {
  view.destroy()
  renderer.destroy()
  suggestionDoc.destroy()
  baseDoc.destroy()
}, { once: true })
