/**
 * INTEGRATION tests for the editable deletion sub-editor (src/editable-deletion.js).
 *
 * The decoration plugin is configured with `editableDeletionMapDiff`, which
 * renders deleted content as a widget decoration hosting its own nested
 * `EditorView` (the ProseMirror footnote pattern). These tests assert that:
 *   - deletions still produce delete-kind decorations (block/inline),
 *   - the widget DOM actually mounts a nested EditorView seeded with the
 *     deleted text,
 *   - typing into the nested view edits the deleted text in isolation without
 *     mutating the host document, and
 *   - the host document stays clean (no deleted text leaks back in).
 */
import * as t from 'lib0/testing'
import * as Y from '@y/y'
import * as YPM from '@y/prosemirror'
import * as delta from 'lib0/delta'
import { EditorState, TextSelection, Selection, Plugin } from 'prosemirror-state'
import { EditorView, DecorationSet } from 'prosemirror-view'
import { Schema, Fragment } from 'prosemirror-model'
import { schema } from './complexSchema.js'
import { setupTwoWaySync } from './cohort.js'

const PM_KEY = 'prosemirror'

/**
 * Create a PM view with sync + the decoration plugin using editable deletions.
 *
 * @param {Y.Type} ytype
 * @param {Y.AbstractAttributionManager} am
 * @returns {EditorView}
 */
const createEditableDeletionView = (ytype, am) => {
  const view = new EditorView(
    { mount: document.createElement('div') },
    {
      state: EditorState.create({
        schema,
        plugins: [
          YPM.syncPlugin(),
          YPM.ySuggestionDecorationPlugin({ mapDiffToDecorations: YPM.editableDeletionMapDiff })
        ]
      })
    }
  )
  YPM.configureYProsemirror({ ytype, attributionManager: am })(view.state, view.dispatch)
  return view
}

/**
 * Two-doc suggestion setup in decoration mode with editable deletions.
 *
 * @param {string[]} paragraphs
 */
const setup = (...paragraphs) => {
  const baseDoc = new Y.Doc({ gc: false, guid: 'base' })
  const suggestionDoc = new Y.Doc({ isSuggestionDoc: true, gc: false, guid: 'suggestions' })
  const suggestionModeDoc = new Y.Doc({ isSuggestionDoc: true, gc: false, guid: 'suggestions-edit' })

  const attrs = new Y.Attributions()
  const am = Y.createAttributionManagerFromDiff(baseDoc, suggestionDoc, { attrs })
  am.suggestionMode = false

  const suggestionModeAM = Y.createAttributionManagerFromDiff(baseDoc, suggestionModeDoc, { attrs })
  suggestionModeAM.suggestionMode = true

  setupTwoWaySync(suggestionDoc, suggestionModeDoc)

  const editor = createEditableDeletionView(suggestionModeDoc.get(PM_KEY), suggestionModeAM)

  const d = delta.create()
  for (const text of paragraphs) {
    d.insert([delta.create('paragraph', {}, text)])
  }
  baseDoc.get(PM_KEY).applyDelta(d.done())

  return { baseDoc, suggestionDoc, suggestionModeDoc, am, suggestionModeAM, editor, attrs }
}

const getDecorations = (/** @type {EditorView} */ view) => {
  const decoSet = YPM.ySuggestionDecorationPluginKey.getState(view.state)
  return decoSet ? decoSet.find() : []
}

/**
 * Find the first mounted deletion sub-editor's nested EditorView.
 * Checks both the decoration spec and the key-based registry (because
 * ProseMirror reuses widget DOM across decoration rebuilds without calling
 * toDOM again, so new specs may have subEditors: undefined).
 *
 * @param {EditorView} view
 * @returns {EditorView | null}
 */
const findSubEditor = (view) => {
  const decos = getDecorations(view)
  for (const deco of decos) {
    const entry = deco.spec?.subEditors ||
      (typeof deco.spec?.key === 'string' ? YPM.subEditorsByKey.get(deco.spec.key) : undefined)
    if (entry?.views?.length) return entry.views[0]
  }
  return null
}

/**
 * A whole-block deletion mounts a nested editor seeded with the deleted text.
 *
 * @param {t.TestCase} _tc
 */
export const testBlockDeletionMountsSubEditor = _tc => {
  const { editor } = setup('keep me', 'delete me')

  const para2Start = editor.state.doc.child(0).nodeSize
  const para2 = editor.state.doc.child(1)
  editor.dispatch(editor.state.tr.delete(para2Start, para2Start + para2.nodeSize))

  // The deletion is still a block-delete widget decoration.
  const deleteDeco = getDecorations(editor).find(d => d.spec?.diff?.type === 'block-delete')
  t.assert(deleteDeco != null, 'found block-delete widget decoration')

  // ...and that widget hosts a nested EditorView seeded with the deleted text.
  const sub = findSubEditor(editor)
  t.assert(sub != null, 'deletion widget mounted a nested EditorView')
  if (sub == null) return
  t.assert(sub.state.doc.textContent === 'delete me', 'sub-editor seeded with deleted text')

  // Host doc stays clean — deleted text is not present.
  t.assert(!editor.state.doc.textContent.includes('delete me'), 'deleted text not in host doc')
}

/**
 * Typing into the sub-editor edits the deleted text in isolation; the host
 * document is unaffected.
 *
 * @param {t.TestCase} _tc
 */
export const testSubEditorEditsAreIsolated = _tc => {
  const { editor } = setup('keep me', 'delete me')

  const para2Start = editor.state.doc.child(0).nodeSize
  const para2 = editor.state.doc.child(1)
  editor.dispatch(editor.state.tr.delete(para2Start, para2Start + para2.nodeSize))

  const sub = findSubEditor(editor)
  t.assert(sub != null, 'nested EditorView present')
  if (sub == null) return

  const hostTextBefore = editor.state.doc.textContent
  // Type into the sub-editor (prepend "X" at position 1, inside the paragraph).
  sub.dispatch(sub.state.tr.insertText('X', 1))

  t.assert(sub.state.doc.textContent === 'Xdelete me', 'sub-editor content edited')
  t.assert(editor.state.doc.textContent === hostTextBefore, 'host doc unchanged by sub-editor edit')
  t.assert(!editor.state.doc.textContent.includes('Xdelete me'), 'sub-editor edit did not leak into host doc')
}

/**
 * An inline deletion also mounts a nested editor seeded with the deleted text.
 *
 * @param {t.TestCase} _tc
 */
export const testInlineDeletionMountsSubEditor = _tc => {
  const { editor } = setup('hello world')

  // Delete "world" (positions 7..12 in "hello world": 1-based PM positions).
  const from = editor.state.doc.content.size - 6
  const to = editor.state.doc.content.size - 1
  editor.dispatch(editor.state.tr.delete(from, to))

  const deleteDeco = getDecorations(editor).find(d => d.spec?.diff?.type === 'inline-delete')
  t.assert(deleteDeco != null, 'found inline-delete widget decoration')

  const sub = findSubEditor(editor)
  t.assert(sub != null, 'inline deletion mounted a nested EditorView')
  if (sub == null) return
  t.assert(sub.state.doc.textContent.length > 0, 'sub-editor seeded with deleted text')
  t.assert(sub.state.doc.textContent === 'worl' || sub.state.doc.textContent === 'world', 'sub-editor holds the deleted run')
}

/**
 * The nested EditorView survives a decoration rebuild (a host edit elsewhere
 * triggers a `y-sync-transaction` recompute) because the widget key is stable.
 *
 * @param {t.TestCase} _tc
 */
export const testSubEditorSurvivesRebuild = _tc => {
  const { editor } = setup('keep me', 'delete me')

  const para2Start = editor.state.doc.child(0).nodeSize
  const para2 = editor.state.doc.child(1)
  editor.dispatch(editor.state.tr.delete(para2Start, para2Start + para2.nodeSize))

  const subBefore = findSubEditor(editor)
  t.assert(subBefore != null, 'nested EditorView present before host edit')

  // Edit the surviving (kept) paragraph in the host doc — this triggers a Y
  // write and a decoration recompute.
  editor.dispatch(editor.state.tr.insertText('!', 1))

  const subAfter = findSubEditor(editor)
  t.assert(subAfter != null, 'nested EditorView still present after rebuild')
  t.assert(subAfter === subBefore, 'same nested EditorView instance reused (stable widget key)')
}

/**
 * Synthesize an arrow keydown and run it through a view's handleKeyDown props
 * (the plugin chain), the same entry point a real keypress uses.
 *
 * @param {EditorView} view
 * @param {'ArrowLeft' | 'ArrowRight'} key
 * @returns {boolean} whether a handler consumed the key
 */
const pressArrow = (view, key) => {
  const event = /** @type {KeyboardEvent} */ (/** @type {any} */ ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false
  }))
  return view.someProp('handleKeyDown', (f) => f(view, event)) === true
}

/**
 * Delete the middle block ("delete me") of three paragraphs and return the
 * widget position plus the mounted sub-editor. This is the "deleted node"
 * case: a whole paragraph node removed, ghosted between two surviving blocks.
 *
 * @param {ReturnType<typeof setup>} ctx
 */
const deleteMiddleBlock = (ctx) => {
  const { editor } = ctx
  const para2Start = editor.state.doc.child(0).nodeSize
  const para2 = editor.state.doc.child(1)
  editor.dispatch(editor.state.tr.delete(para2Start, para2Start + para2.nodeSize))
  const deleteDeco = getDecorations(editor).find(d => d.spec?.diff?.type === 'block-delete')
  t.assert(deleteDeco != null, 'found block-delete widget decoration')
  const sub = findSubEditor(editor)
  t.assert(sub != null, 'deletion widget mounted a nested EditorView')
  const widgetPos = /** @type {Decoration} */ (deleteDeco).from
  const subView = /** @type {EditorView} */ (sub)
  return { widgetPos, sub: subView }
}
/** @typedef {import('prosemirror-view').Decoration} Decoration */

/**
 * ArrowRight at the end of the block before a deleted node enters the
 * sub-editor with the caret at its start.
 *
 * @param {t.TestCase} _tc
 */
export const testArrowRightEntersDeletedBlock = _tc => {
  const ctx = setup('first para', 'delete me', 'third para')
  const { editor } = ctx
  const { widgetPos, sub } = deleteMiddleBlock(ctx)

  // Caret at the end of "first para" — one position before the block boundary
  // the widget sits on.
  editor.dispatch(editor.state.tr.setSelection(
    TextSelection.create(editor.state.doc, widgetPos - 1)
  ))
  const handled = pressArrow(editor, 'ArrowRight')

  t.assert(handled, 'ArrowRight at the boundary was consumed')
  t.assert(sub.state.selection.head === Selection.atStart(sub.state.doc).head,
    'sub-editor caret at start after entering from the left')
}

/**
 * ArrowLeft at the start of the block after a deleted node enters the
 * sub-editor with the caret at its end.
 *
 * @param {t.TestCase} _tc
 */
export const testArrowLeftEntersDeletedBlock = _tc => {
  const ctx = setup('first para', 'delete me', 'third para')
  const { editor } = ctx
  const { widgetPos, sub } = deleteMiddleBlock(ctx)

  // Caret at the start of "third para" — one position after the boundary.
  editor.dispatch(editor.state.tr.setSelection(
    TextSelection.create(editor.state.doc, widgetPos + 1)
  ))
  const handled = pressArrow(editor, 'ArrowLeft')

  t.assert(handled, 'ArrowLeft at the boundary was consumed')
  t.assert(sub.state.selection.head === Selection.atEnd(sub.state.doc).head,
    'sub-editor caret at end after entering from the right')
}

/**
 * Arrowing out of the sub-editor returns the caret to the host editor on the
 * matching side of the widget.
 *
 * @param {t.TestCase} _tc
 */
export const testArrowExitsDeletedBlock = _tc => {
  const ctx = setup('first para', 'delete me', 'third para')
  const { editor } = ctx
  const { widgetPos, sub } = deleteMiddleBlock(ctx)

  // Exit left: inner caret at start, ArrowLeft → host caret at the end of the
  // block before the widget.
  sub.dispatch(sub.state.tr.setSelection(Selection.atStart(sub.state.doc)))
  t.assert(pressArrow(sub, 'ArrowLeft'), 'ArrowLeft at sub-editor start was consumed')
  t.assert(editor.state.selection.head === widgetPos - 1,
    'host caret at end of previous block after exiting left')

  // Exit right: inner caret at end, ArrowRight → host caret at the start of
  // the block after the widget.
  sub.dispatch(sub.state.tr.setSelection(Selection.atEnd(sub.state.doc)))
  t.assert(pressArrow(sub, 'ArrowRight'), 'ArrowRight at sub-editor end was consumed')
  t.assert(editor.state.selection.head === widgetPos + 1,
    'host caret at start of next block after exiting right')
}

/**
 * Arrow keys that are not at the sub-editor's boundary stay inside it (normal
 * cursor motion), they do not exit.
 *
 * @param {t.TestCase} _tc
 */
export const testArrowInsideSubEditorDoesNotExit = _tc => {
  const ctx = setup('first para', 'delete me', 'third para')
  const { sub } = deleteMiddleBlock(ctx)

  // Caret in the middle of the deleted text: neither boundary command fires.
  sub.dispatch(sub.state.tr.setSelection(TextSelection.create(sub.state.doc, 3)))
  t.assert(!pressArrow(sub, 'ArrowLeft'), 'ArrowLeft mid-content not consumed by exit command')
  t.assert(!pressArrow(sub, 'ArrowRight'), 'ArrowRight mid-content not consumed by exit command')
}

/**
 * Inline deletions: ArrowRight just before the ghost enters it; exiting right
 * sets the pass-through flag so the next ArrowRight continues past the ghost
 * instead of re-entering it.
 *
 * @param {t.TestCase} _tc
 */
export const testInlineArrowNavigationRoundTrip = _tc => {
  const ctx = setup('hello world')
  const { editor } = ctx

  // Delete "worl" — leaves an inline ghost mid-text.
  const from = editor.state.doc.content.size - 6
  const to = editor.state.doc.content.size - 2
  editor.dispatch(editor.state.tr.delete(from, to))

  const deleteDeco = getDecorations(editor).find(d => d.spec?.diff?.type === 'inline-delete')
  t.assert(deleteDeco != null, 'found inline-delete widget decoration')
  if (deleteDeco == null) return
  const widgetPos = deleteDeco.from
  const sub = findSubEditor(editor)
  t.assert(sub != null, 'inline deletion mounted a nested EditorView')
  if (sub == null) return

  // Enter from the left: caret right at the ghost's position.
  editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, widgetPos)))
  t.assert(pressArrow(editor, 'ArrowRight'), 'ArrowRight entered the inline ghost')
  t.assert(sub.state.selection.head === Selection.atStart(sub.state.doc).head, 'caret at ghost start')

  // Exit right from the ghost's end.
  sub.dispatch(sub.state.tr.setSelection(Selection.atEnd(sub.state.doc)))
  t.assert(pressArrow(sub, 'ArrowRight'), 'ArrowRight at ghost end exited')
  t.assert(editor.state.selection.head === widgetPos, 'host caret back at the widget position')

  // The very next ArrowRight must NOT re-enter the ghost (pass-through flag).
  t.assert(!pressArrow(editor, 'ArrowRight'), 'next ArrowRight passes the ghost instead of re-entering')

  // ...but a later ArrowRight at the same spot (flag cleared) re-enters.
  t.assert(pressArrow(editor, 'ArrowRight'), 'subsequent ArrowRight re-enters the ghost')
}

/**
 * Entering from the right via ArrowLeft one position after an inline ghost.
 *
 * @param {t.TestCase} _tc
 */
export const testInlineArrowLeftEntersFromRight = _tc => {
  const ctx = setup('hello world')
  const { editor } = ctx

  const from = editor.state.doc.content.size - 6
  const to = editor.state.doc.content.size - 2
  editor.dispatch(editor.state.tr.delete(from, to))

  const deleteDeco = getDecorations(editor).find(d => d.spec?.diff?.type === 'inline-delete')
  t.assert(deleteDeco != null, 'found inline-delete widget decoration')
  if (deleteDeco == null) return
  const widgetPos = deleteDeco.from
  const sub = findSubEditor(editor)
  if (sub == null) return

  // Caret one step right of the ghost (after the character that follows it).
  // The first ArrowLeft steps onto the ghost's right edge (one visual slot
  // per press, like real text), the second enters the ghost at its end.
  editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, widgetPos + 1)))
  t.assert(pressArrow(editor, 'ArrowLeft'), 'first ArrowLeft stepped onto the ghost right edge')
  t.assert(editor.state.selection.head === widgetPos, 'host caret on the widget position')
  t.assert(pressArrow(editor, 'ArrowLeft'), 'second ArrowLeft entered the inline ghost from the right')
  t.assert(sub.state.selection.head === Selection.atEnd(sub.state.doc).head, 'caret at ghost end')
}

/**
 * Simulate typing `text` at the caret through the host plugin chain: run
 * handleTextInput props (which record cursor-side intent), then apply the
 * insertion like the editor would.
 *
 * @param {EditorView} view
 * @param {number} pos
 * @param {string} text
 */
const typeAt = (view, pos, text) => {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
  view.someProp('handleTextInput', (f) => f(view, pos, pos, text, () => view.state.tr))
  view.dispatch(view.state.tr.insertText(text, pos))
}

/**
 * Create an inline ghost mid-paragraph and return its position plus lookup
 * helpers for the rebuilt decorations.
 *
 * @param {ReturnType<typeof setup>} ctx
 */
const makeInlineGhost = (ctx) => {
  const { editor } = ctx
  // "hello world" -> delete "worl", leaving an inline ghost before "d".
  const from = editor.state.doc.content.size - 6
  const to = editor.state.doc.content.size - 2
  editor.dispatch(editor.state.tr.delete(from, to))
  const find = () => {
    const decos = getDecorations(editor)
    return {
      ghost: decos.find(d => d.spec?.diff?.type === 'inline-delete'),
      insert: decos.find(d => d.spec?.diff?.type === 'inline-insert')
    }
  }
  const { ghost } = find()
  t.assert(ghost != null, 'inline ghost created')
  return { widgetPos: /** @type {Decoration} */ (ghost).from, find }
}

/**
 * Typing with the caret on the ghost's LEFT keeps the typed text on the
 * ghost's left: the ghost re-anchors to the right of the insert run.
 *
 * @param {t.TestCase} _tc
 */
export const testTypingLeftOfGhostStaysLeft = _tc => {
  const ctx = setup('hello world')
  const { editor } = ctx
  const { widgetPos, find } = makeInlineGhost(ctx)

  // Caret at the widget position; no side-after flag set -> side is "before".
  typeAt(editor, widgetPos, 'X')

  const { ghost, insert } = find()
  t.assert(insert != null, 'attributed insert run present after typing')
  t.assert(ghost != null, 'ghost still present after typing')
  if (!ghost || !insert) return
  t.assert(insert.from === widgetPos && insert.to === widgetPos + 1, 'insert run covers the typed char')
  t.assert(ghost.from === insert.to, 'ghost re-anchored AFTER the text typed on its left')

  // Continue typing at the new boundary (between typed text and ghost): the
  // ghost keeps sliding right so the text stream stays on its left.
  typeAt(editor, ghost.from, 'Y')
  const after = find()
  if (!after.ghost || !after.insert) return
  t.assert(after.insert.to === widgetPos + 2, 'insert run grew to two chars')
  t.assert(after.ghost.from === after.insert.to, 'ghost still anchored after the typed run')
}

/**
 * Typing with the caret on the ghost's RIGHT (after exiting the sub-editor
 * rightwards) keeps the typed text on the ghost's right: the ghost stays
 * anchored before the insert run.
 *
 * @param {t.TestCase} _tc
 */
export const testTypingRightOfGhostStaysRight = _tc => {
  const ctx = setup('hello world')
  const { editor } = ctx
  const { widgetPos, find } = makeInlineGhost(ctx)

  // Put the caret on the ghost's right side via the arrow path: enter the
  // ghost, move to its end, exit right (sets the side-after placement flag).
  editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, widgetPos)))
  t.assert(pressArrow(editor, 'ArrowRight'), 'entered the ghost')
  const sub = findSubEditor(editor)
  if (sub == null) return
  sub.dispatch(sub.state.tr.setSelection(Selection.atEnd(sub.state.doc)))
  t.assert(pressArrow(sub, 'ArrowRight'), 'exited the ghost rightwards')
  t.assert(editor.state.selection.head === widgetPos, 'caret back on the widget position (right side)')

  typeAt(editor, widgetPos, 'Z')

  const { ghost, insert } = find()
  t.assert(insert != null, 'attributed insert run present after typing')
  t.assert(ghost != null, 'ghost still present after typing')
  if (!ghost || !insert) return
  t.assert(insert.from === widgetPos && insert.to === widgetPos + 1, 'insert run covers the typed char')
  t.assert(ghost.from === insert.from, 'ghost stays anchored BEFORE text typed on its right')
}

/**
 * A deleted table row renders as a *semantic* widget: the sub-editor is
 * mounted directly on a `<tr>` element whose children are real `<td>` cells,
 * so it participates in the table's layout. Shape detection rides on the
 * prosemirror-tables `tableRole` node-spec convention.
 *
 * @param {t.TestCase} _tc
 */
export const testDeletedTableRowRendersAsTr = _tc => {
  const tableSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
      table: { content: 'tableRow+', group: 'block', tableRole: 'table', toDOM: () => ['table', ['tbody', 0]] },
      tableRow: { content: 'tableCell+', tableRole: 'row', toDOM: () => ['tr', 0] },
      tableCell: { content: 'paragraph+', tableRole: 'cell', toDOM: () => ['td', 0] },
      text: { group: 'inline' }
    }
  })
  const n = tableSchema.nodes
  const cell = (/** @type {string} */ text) => n.tableCell.create(null, n.paragraph.create(null, tableSchema.text(text)))
  const doc = n.doc.create(null, n.table.create(null, [
    n.tableRow.create(null, [cell('A1'), cell('B1')])
  ]))

  // A block-delete diff whose content is a deleted row, anchored after the
  // surviving row (inside the table).
  /** @type {import('@y/prosemirror').Diff} */
  const diff = {
    type: 'block-delete',
    from: doc.content.size - 1,
    to: doc.content.size - 1,
    content: Fragment.from(n.tableRow.create(null, [cell('X2'), cell('Y2')])),
    attribution: { type: 'removed', authorIds: ['tester'] }
  }
  const widget = YPM.editableDeletionWidget(diff, tableSchema)
  const view = new EditorView(
    { mount: document.createElement('div') },
    {
      state: EditorState.create({
        schema: tableSchema,
        doc,
        plugins: [new Plugin({
          props: { decorations: (state) => DecorationSet.create(state.doc, [widget]) }
        })]
      })
    }
  )

  const ghostRow = view.dom.querySelector('tr.pm-suggest--editable')
  t.assert(ghostRow != null, 'deleted row widget is a <tr> element')
  if (ghostRow == null) return
  t.assert(ghostRow.parentElement?.tagName === 'TBODY', '<tr> ghost sits inside the tbody')
  const cells = ghostRow.querySelectorAll('td')
  t.assert(cells.length === 2, 'ghost row renders one <td> per deleted cell')
  t.assert(cells[0].textContent === 'X2' && cells[1].textContent === 'Y2', 'cells carry the deleted content')
  // Browsers refuse contenteditable roots on table elements, so each <td>
  // hosts its own editor mounted on an inner <div>.
  const cellEditors = ghostRow.querySelectorAll('td > div.ProseMirror')
  t.assert(cellEditors.length === 2, 'each <td> hosts a nested editor div')
  // Sub-editors are stored in the key-based registry (the decoration was
  // created directly with editableDeletionWidget, not via the suggestion plugin).
  const widgetKey = YPM.deletionKey(diff)
  const rowEntry = YPM.subEditorsByKey.get(widgetKey)
  const inners = rowEntry?.views
  t.assert(inners != null && inners.length === 2, 'one nested EditorView per deleted cell')
  if (!inners) return
  t.assert(inners[0].state.doc.textContent === 'X2', 'first cell editor seeded with its cell content')
  t.assert(inners[1].state.doc.textContent === 'Y2', 'second cell editor seeded with its cell content')
  view.destroy()
}

/**
 * Inline ghosts are a non-editable <span> shell hosting an inline <span>
 * sub-editor — no block-level wrapper elements inside a paragraph.
 *
 * @param {t.TestCase} _tc
 */
export const testInlineGhostMountsOnSpan = _tc => {
  const ctx = setup('hello world')
  makeInlineGhost(ctx)
  const el = ctx.editor.dom.querySelector('.pm-suggest--editable')
  t.assert(el != null, 'inline ghost element present')
  if (el == null) return
  t.assert(el.tagName === 'SPAN', 'inline ghost shell is a <span>')
  const inner = el.querySelector('span.ProseMirror')
  t.assert(inner != null, 'sub-editor mounted on an inline <span> inside the shell')
  t.assert(el.querySelector('div, p') == null, 'no block-level elements inside the inline ghost')
}
