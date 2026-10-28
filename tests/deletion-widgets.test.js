import * as Y from '@y/y'
import * as delta from 'lib0/delta'
import * as t from 'lib0/testing'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from 'prosemirror-schema-basic'
import { syncPlugin, configureYProsemirror, relativePositionsToResolvedPositions } from '../src/index.js'
import { extractDeletions, extractSuggestions, deletedText, suggestionDecorations } from '../demo/deletion-widgets.js'

const setup = () => {
  const base = new Y.Doc({ gc: false })
  const suggestion = new Y.Doc({ gc: false, isSuggestionDoc: true })
  base.get().applyDelta(delta.create().insert([
    delta.create('paragraph', {}, 'hello world'),
    delta.create('paragraph', {}, 'middle'),
    delta.create('paragraph', {}, 'last')
  ]).done())
  Y.applyUpdate(suggestion, Y.encodeStateAsUpdate(base))
  const renderer = Y.createDiffRenderer(base, suggestion)
  const root = suggestion.get()
  let refreshes = 0
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({ schema, plugins: [syncPlugin(), suggestionDecorations(root, renderer, () => { refreshes++ })] })
  })
  configureYProsemirror({ ytype: root, renderer: null })(view.state, view.dispatch)
  const records = () => extractDeletions(root, renderer)
  const positions = () => relativePositionsToResolvedPositions(view, records().map(r => r.anchor)).map(p => p?.pos)
  return {
    base,
    suggestion,
    renderer,
    root,
    view,
    records,
    positions,
    refreshes: () => refreshes,
    destroy: () => { view.destroy(); renderer.destroy(); suggestion.destroy(); base.destroy() }
  }
}

/** @param {t.TestCase} _tc */
export const testInlineDeletionOutsideSchema = async _tc => {
  const s = setup()
  try {
    s.view.dispatch(s.view.state.tr.delete(7, 12))
    await Promise.resolve()
    t.compare(s.view.state.doc.firstChild?.textContent, 'hello ')
    t.compare(s.records().map(r => deletedText(r.content)), ['world'])
    t.compare(s.positions(), [7])
    t.assert(s.records()[0].sourceRange.from?.item != null)
    t.assert(s.view.dom.querySelector('.deleted-card button') != null, 'custom DOM outside schema')
    t.assert(!JSON.stringify(s.view.state.doc.toJSON()).includes('world'))
    // A captured CRDT anchor follows editing before the deletion.
    const anchor = s.records()[0].anchor
    s.view.dispatch(s.view.state.tr.insertText('X', 1))
    await Promise.resolve()
    t.compare(relativePositionsToResolvedPositions(s.view, [anchor])[0]?.pos, 8)
    t.compare(s.positions(), [8])
    const before = s.refreshes()
    const live = s.view.state.doc.toJSON()
    s.renderer.acceptAllChanges()
    await Promise.resolve()
    t.assert(s.refreshes() > before, 'attribution-only changes refresh widgets')
    t.compare(s.records(), [])
    t.compare(s.view.state.doc.toJSON(), live)
    t.assert(s.view.dom.querySelector('.deleted-card') == null)
  } finally { s.destroy() }
}

/** @param {t.TestCase} _tc */
export const testDeletedSubtreeAnchorsAtParentGap = async _tc => {
  const s = setup()
  try {
    s.view.dispatch(s.view.state.tr.delete(13, 21))
    await Promise.resolve()
    t.compare(s.records().map(r => r.content[0].type), ['paragraph'])
    t.compare(s.records().map(r => deletedText(r.content)), ['middle'])
    t.compare(s.positions(), [13])
    t.compare(s.view.state.doc.childCount, 2)
    t.assert(s.view.dom.querySelector('.deleted-card') != null)
    s.renderer.rejectAllChanges()
    await Promise.resolve()
    t.compare(s.records(), [])
    t.compare(s.view.state.doc.child(1).textContent, 'middle')
    t.assert(s.view.dom.querySelector('.deleted-card') == null)
  } finally { s.destroy() }
}

/** @param {t.TestCase} _tc */
export const testCrossParagraphDeletion = async _tc => {
  const s = setup()
  try {
    s.view.dispatch(s.view.state.tr.delete(7, 25))
    await Promise.resolve()
    t.assert(s.records().length > 0)
    t.assert(s.positions().every(p => p != null), 'every deletion has a live anchor')
    t.compare(s.view.state.doc.textContent, 'hello t')
    s.renderer.rejectAllChanges()
    await Promise.resolve()
    t.compare(s.records(), [])
    t.compare(s.view.state.doc.textContent, 'hello worldmiddlelast')
  } finally { s.destroy() }
}

/** @param {t.TestCase} _tc */
export const testDistinctDeletionsAtSameGap = async _tc => {
  const s = setup()
  try {
    s.view.dispatch(s.view.state.tr.addMark(7, 10, schema.marks.strong.create()))
    s.renderer.acceptAllChanges()
    s.view.dispatch(s.view.state.tr.delete(7, 12))
    await Promise.resolve()
    t.compare(s.records().map(r => deletedText(r.content)), ['wor', 'ld'])
    t.compare(s.positions(), [7, 7])
    t.compare(JSON.parse(JSON.stringify(s.records()[0].content[0].marks)), [{ type: 'strong', attrs: {} }])
    t.compare(Array.from(s.view.dom.querySelectorAll('.deleted-card del'), el => el.textContent), ['wor', 'ld'])
    t.assert(!JSON.stringify(s.view.state.doc.toJSON()).includes('world'))
  } finally { s.destroy() }
}

/** @param {t.TestCase} _tc */
export const testInsertionDecorationsWithoutMarks = async _tc => {
  const s = setup()
  try {
    s.view.dispatch(s.view.state.tr.insertText('new ', 7))
    await Promise.resolve()
    t.compare(Array.from(s.view.dom.querySelectorAll('.suggested-insertion'), el => el.textContent), ['new '])
    t.compare(s.view.state.doc.firstChild?.textContent, 'hello new world')
    t.assert(!JSON.stringify(s.view.state.doc.toJSON()).includes('marks'), 'no attribution marks in PM JSON')
    const insertion = extractSuggestions(s.root, s.renderer).insertions[0]
    t.compare(relativePositionsToResolvedPositions(s.view, [insertion.sourceRange.from, insertion.sourceRange.to]).map(p => p?.pos), [7, 11])
    // A base edit before the suggestion shifts it, but must not be highlighted.
    s.base.get().get(0).applyDelta(delta.create().insert('base ').done())
    await Promise.resolve()
    t.compare(Array.from(s.view.dom.querySelectorAll('.suggested-insertion'), el => el.textContent), ['new '])
    t.compare(relativePositionsToResolvedPositions(s.view, [insertion.sourceRange.from, insertion.sourceRange.to]).map(p => p?.pos), [12, 16])
    const live = s.view.state.doc.toJSON()
    const before = s.refreshes()
    s.renderer.acceptAllChanges()
    await Promise.resolve()
    t.assert(s.refreshes() > before)
    t.compare(s.view.state.doc.toJSON(), live)
    t.compare(extractSuggestions(s.root, s.renderer).insertions, [])
    t.assert(s.view.dom.querySelector('.suggested-insertion') == null)
  } finally { s.destroy() }
}

/** @param {t.TestCase} _tc */
export const testInsertedNodeDecorations = async _tc => {
  const s = setup()
  try {
    s.view.dispatch(s.view.state.tr.insert(13, [
      schema.nodes.paragraph.create(null, schema.text('new paragraph')),
      schema.nodes.paragraph.create(),
      schema.nodes.horizontal_rule.create()
    ]))
    await Promise.resolve()
    const inserted = Array.from(s.view.dom.querySelectorAll('.suggested-insertion'))
    t.compare(inserted.map(el => el.nodeName), ['P', 'P', 'HR'])
    t.compare(inserted.map(el => el.textContent), ['new paragraph', '', ''])
    t.compare(extractSuggestions(s.root, s.renderer).insertions.map(r => r.kind), ['node', 'node', 'node'])
    t.assert(s.view.dom.querySelector('.suggested-insertion .suggested-insertion') == null, 'no redundant highlighting inside inserted subtree')
    s.renderer.rejectAllChanges()
    await Promise.resolve()
    t.compare(s.view.state.doc.childCount, 3)
    t.compare(extractSuggestions(s.root, s.renderer).insertions, [])
    t.assert(s.view.dom.querySelector('.suggested-insertion') == null)
  } finally { s.destroy() }
}

/** @param {t.TestCase} _tc */
export const testReplacementInsertionUsesLiveCoordinates = async _tc => {
  const s = setup()
  try {
    s.view.dispatch(s.view.state.tr.insertText('XYZ', 7, 12))
    await Promise.resolve()
    t.compare(s.records().map(r => deletedText(r.content)), ['world'])
    t.compare(Array.from(s.view.dom.querySelectorAll('.suggested-insertion'), el => el.textContent), ['XYZ'])
    t.compare(s.view.state.doc.firstChild?.textContent, 'hello XYZ')
    s.renderer.rejectAllChanges()
    await Promise.resolve()
    t.compare(s.view.state.doc.firstChild?.textContent, 'hello world')
    t.assert(s.view.dom.querySelector('.suggested-insertion, .deleted-card') == null)
  } finally { s.destroy() }
}

/** @param {t.TestCase} _tc */
export const testDeletingPendingInsertionRemovesHighlight = async _tc => {
  const s = setup()
  try {
    s.view.dispatch(s.view.state.tr.insertText('new ', 7))
    await Promise.resolve()
    s.view.dispatch(s.view.state.tr.delete(7, 11))
    await Promise.resolve()
    t.compare(extractSuggestions(s.root, s.renderer), { deletions: [], insertions: [] })
    t.assert(s.view.dom.querySelector('.suggested-insertion, .deleted-card') == null)
    t.compare(s.view.state.doc.firstChild?.textContent, 'hello world')
  } finally { s.destroy() }
}
