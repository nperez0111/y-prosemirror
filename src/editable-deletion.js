/**
 * Editable deleted content via nested sub-editors (the ProseMirror footnote
 * pattern: https://prosemirror.net/examples/footnote/).
 *
 * The decoration overlay normally renders deleted content as a *read-only*
 * ghost (see `renderDeletedContent` in diff-decorations.js). This module
 * renders it instead as a widget decoration whose DOM hosts its own small
 * `EditorView` — a self-contained "sub-editor" — so the user can click into a
 * deletion and edit the removed text directly.
 *
 * This is a proof of concept. Scope intentionally excluded:
 *   - syncing sub-editor edits back into Yjs (the sub-editor is isolated)
 *   - undo/redo integration with the host editor's history
 *   - rich block structure inside the sub-editor (everything becomes paragraphs)
 *
 * How it works (mirroring the footnote example):
 *   - A widget decoration's DOM is the mount point for a nested `EditorView`.
 *   - `stopEvent: () => true` tells the *outer* view to ignore every event that
 *     originates inside the widget, so the nested view handles its own input.
 *   - `ignoreSelection: true` keeps the outer view from trying to read or place
 *     a selection inside the sub-editor.
 *   - A stable `key` (derived from the deleted content, not the array index)
 *     lets ProseMirror reuse the existing widget DOM across decoration
 *     rebuilds, so the nested view — and its focus/selection/edit state —
 *     survives the periodic `y-sync-transaction` recompute.
 *   - `destroy` tears the nested view down when the deletion finally goes away
 *     (e.g. the change is accepted or rejected).
 *
 * Arrow-key navigation across the widget boundary:
 *   - The host editor (via `handleEditableDeletionArrow`, wired into
 *     `ySuggestionDecorationPlugin`'s `handleKeyDown`) intercepts ArrowRight
 *     when the caret sits immediately left of a deletion widget and ArrowLeft
 *     when it sits immediately right of one, and moves focus *into* the
 *     sub-editor (at its start / end respectively) — so the ghost behaves like
 *     ordinary text instead of being invisible to cursor motion.
 *   - The sub-editor's own keymap does the reverse: ArrowLeft at its start /
 *     ArrowRight at its end exits back into the host editor at the position
 *     just before / after the widget.
 *   - Inline ghosts are zero-width: both visual sides map to the same doc
 *     position. The widget is created with `relaxedSide: true` so a DOM
 *     selection placed on its right side sticks, and the handlers track the
 *     caret's *visual* side (live DOM selection, with a placement flag as
 *     fallback for non-layout environments) to decide whether an arrow press
 *     enters the ghost or moves past it. Crossing the ghost is one visual
 *     slot per press, like real text.
 *
 * Typing at the widget boundary (cursor-side-aware insertion):
 *   - The attributed delta orders a deletion *before* an insertion recorded at
 *     the same position, so by default text typed at a ghost's position
 *     renders to its right — even when the caret was on its left. Both
 *     orderings produce the same documents, so the anchor choice belongs to
 *     the rendering layer.
 *   - `handleEditableDeletionTextInput` (wired into the suggestion plugin's
 *     `handleTextInput`) records the caret's visual side when text is typed
 *     at a ghost's position, accumulating an *anchor offset* per ghost: how
 *     many characters of the adjacent attributed insert run belong to the
 *     ghost's left. `applyGhostAnchorOffsets` re-applies that preference on
 *     every decoration rebuild, so text typed with the caret left of the
 *     ghost stays on its left and text typed on its right stays on its right.
 */
import { Decoration, EditorView } from 'prosemirror-view'
import { EditorState, Selection } from 'prosemirror-state'
import { Schema, Fragment } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { defaultMapDiffToDecorations } from './diff-decorations.js'
import { ySuggestionDecorationPluginKey, ySyncPluginKey, suggestionDiffPluginKey } from './keys.js'

/**
 * @typedef {import('./y-attribution-to-diffset.js').Diff} Diff
 * @typedef {import('./diff-decorations.js').MapDiffArgs} MapDiffArgs
 */

/**
 * The structural shape of a deletion, deciding which element the sub-editor
 * mounts on and which minimal inner schema it uses, so the widget DOM stays
 * *valid* in its surrounding context (a `<tr>` between table rows, a `<td>`
 * between cells, a true inline `<span>` mid-text).
 *
 * @typedef {'inline' | 'block' | 'row' | 'cell'} DeletionShape
 */

/**
 * Detect the shape of a deleted fragment. Table detection rides on the
 * prosemirror-tables `tableRole` node-spec convention (used by BlockNote and
 * most table schemas), so no schema-specific node names are required.
 *
 * @param {Fragment} fragment
 * @returns {DeletionShape}
 */
const detectShape = (fragment) => {
  const first = fragment.firstChild
  if (!first || !first.isBlock) return 'inline'
  const role = first.type.spec.tableRole
  if (role === 'row') return 'row'
  if (role === 'cell' || role === 'header_cell') return 'cell'
  return 'block'
}

/** @type {Record<DeletionShape, string>} */
const shapeTag = { inline: 'span', block: 'div', row: 'tr', cell: 'td' }

/**
 * Cache of derived inner schemas, keyed by host schema. The sub-editor uses
 * deliberately tiny schemas so it never has to satisfy the host's (possibly
 * deeply nested) content model — only the host's *marks* are reused, so
 * bold/italic/etc. in deleted text survive by name.
 *
 * Two variants exist per host schema: an inline one (doc holds inline
 * content directly, mounted on a `<span>`) and a block one (doc >
 * paragraph+) shared by block ghosts, cell ghosts and the per-cell editors
 * of row ghosts.
 *
 * @type {WeakMap<import('prosemirror-model').Schema, Map<string, import('prosemirror-model').Schema>>}
 */
const innerSchemaCache = new WeakMap()

/**
 * Build (or fetch a cached) minimal schema for the sub-editor.
 *
 * @param {import('prosemirror-model').Schema} hostSchema
 * @param {DeletionShape} shape
 * @returns {import('prosemirror-model').Schema}
 */
const getInnerSchema = (hostSchema, shape) => {
  let byShape = innerSchemaCache.get(hostSchema)
  if (!byShape) {
    byShape = new Map()
    innerSchemaCache.set(hostSchema, byShape)
  }
  const bucket = shape === 'inline' ? 'inline' : 'block'
  const cached = byShape.get(bucket)
  if (cached) return cached

  /** @type {Object<string, import('prosemirror-model').NodeSpec>} */
  const nodes = shape === 'inline'
    ? {
        doc: { content: 'inline*' },
        text: { group: 'inline' }
      }
    // 'block', 'cell' and each cell-editor of a 'row' share doc > paragraph+.
    : {
        doc: { content: 'block+' },
        paragraph: {
          content: 'inline*',
          group: 'block',
          parseDOM: [{ tag: 'p' }],
          toDOM: () => ['p', 0]
        },
        text: { group: 'inline' }
      }
  let schema
  try {
    // Reuse the host marks so deleted text keeps its formatting (the mark
    // *names* match, which is all the rebuild below relies on).
    schema = new Schema({ nodes, marks: hostSchema.spec.marks })
  } catch {
    // Some host mark specs may not survive being re-homed; fall back to plain
    // text, which is always editable.
    schema = new Schema({ nodes })
  }
  byShape.set(bucket, schema)
  return schema
}

/**
 * Re-create a fragment's inline content using the inner schema, mapping marks
 * by name (dropping any the inner schema doesn't define).
 *
 * @param {Fragment} fragment - inline content (may contain nested blocks)
 * @param {import('prosemirror-model').Schema} innerSchema
 * @returns {import('prosemirror-model').Node[]}
 */
const inlineToInner = (fragment, innerSchema) => {
  /** @type {import('prosemirror-model').Node[]} */
  const out = []
  fragment.descendants((node) => {
    if (node.isText && node.text) {
      const marks = node.marks
        .map((m) => innerSchema.marks[m.type.name]?.create(m.attrs))
        .filter(Boolean)
      out.push(innerSchema.text(node.text, marks.length ? marks : undefined))
      return false
    }
    return true
  })
  return out
}

/**
 * Convert a block node's content into inner paragraphs (one per nested
 * textblock, flattened).
 *
 * @param {import('prosemirror-model').Node} block
 * @param {import('prosemirror-model').Schema} innerSchema
 * @returns {import('prosemirror-model').Node[]}
 */
const blockToParagraphs = (block, innerSchema) => {
  const paragraph = innerSchema.nodes.paragraph
  /** @type {import('prosemirror-model').Node[]} */
  const out = []
  if (block.isTextblock) {
    out.push(paragraph.create(null, inlineToInner(block.content, innerSchema)))
  } else {
    block.forEach((child) => out.push(...blockToParagraphs(child, innerSchema)))
  }
  if (out.length === 0) {
    out.push(/** @type {import('prosemirror-model').Node} */ (paragraph.createAndFill()))
  }
  return out
}

/**
 * Convert a deleted fragment into a valid document for a single sub-editor:
 *   - inline: the doc holds the inline content directly
 *   - block / cell: every (possibly nested) textblock becomes a paragraph
 *
 * @param {Fragment} fragment
 * @param {import('prosemirror-model').Schema} innerSchema
 * @param {DeletionShape} shape
 * @returns {import('prosemirror-model').Node}
 */
const fragmentToInnerDoc = (fragment, innerSchema, shape) => {
  const doc = innerSchema.nodes.doc
  if (shape === 'inline') {
    return doc.create(null, inlineToInner(fragment, innerSchema))
  }
  /** @type {import('prosemirror-model').Node[]} */
  const paragraphs = []
  const first = fragment.firstChild
  if (first && first.isBlock) {
    fragment.forEach((block) => paragraphs.push(...blockToParagraphs(block, innerSchema)))
  } else {
    const paragraph = innerSchema.nodes.paragraph
    const inline = inlineToInner(fragment, innerSchema)
    paragraphs.push(inline.length
      ? paragraph.create(null, inline)
      : /** @type {import('prosemirror-model').Node} */ (paragraph.createAndFill()))
  }
  if (paragraphs.length === 0) {
    paragraphs.push(/** @type {import('prosemirror-model').Node} */ (innerSchema.nodes.paragraph.createAndFill()))
  }
  return doc.create(null, paragraphs)
}

/**
 * One inner document per deleted table cell, in row order. Fragment children
 * are tableRow nodes (usually one); their cells are flattened into a single
 * sequence so a deleted row renders as one `<tr>` of per-cell editors.
 *
 * @param {Fragment} fragment
 * @param {import('prosemirror-model').Schema} innerSchema
 * @returns {import('prosemirror-model').Node[]}
 */
const rowCellDocs = (fragment, innerSchema) => {
  /** @type {import('prosemirror-model').Node[]} */
  const docs = []
  fragment.forEach((row) => {
    row.forEach((cell) => {
      docs.push(innerSchema.nodes.doc.create(null, blockToParagraphs(cell, innerSchema)))
    })
  })
  if (docs.length === 0) {
    docs.push(/** @type {import('prosemirror-model').Node} */ (innerSchema.nodes.doc.createAndFill()))
  }
  return docs
}

/**
 * @param {Fragment | undefined} fragment
 * @returns {string}
 */
const fragmentText = (fragment) =>
  fragment && fragment.size ? fragment.textBetween(0, fragment.size, '\n') : ''

/**
 * A stable widget key for a deletion. Tied to the deleted content and author
 * (not the diff's array index), so the widget DOM — and the nested EditorView
 * inside it — is reused across decoration rebuilds instead of being torn down
 * and re-created on every `y-sync-transaction`.
 *
 * @param {Diff} diff
 * @returns {string}
 */
export const deletionKey = (diff) =>
  `editable-del-${diff.type}-${diff.attribution.authorIds.join(',')}-${fragmentText(diff.content)}`

/**
 * Global registry of sub-editor entries keyed by the widget's stable key.
 * Because ProseMirror reuses the DOM (and old WidgetViewDesc) across decoration
 * rebuilds when keys match, the NEW decoration's spec.subEditors stays undefined.
 * This map provides a reliable lookup path for handlers and tests that only have
 * access to the new (current) decoration objects from the DecorationSet.
 *
 * Entries are added by `createDeletionDOM` and removed by the widget's `destroy`.
 *
 * @type {Map<string, SubEditorEntry>}
 */
export const subEditorsByKey = new Map()

/**
 * Sub-editor entry stored on the widget decoration's `spec.subEditors`.
 * The arrow/text-input handlers read it directly from the spec instead of
 * using a module-level registry, so external consumers (e.g. BlockNote) can
 * mount their own sub-editors and have the keyboard navigation work
 * automatically — just set `spec.subEditors` on the widget decoration.
 *
 * @typedef {{ views: EditorView[], container: HTMLElement }} SubEditorEntry
 */

/**
 * Which visual side of an inline ghost the caret is on when it sits exactly
 * at the widget's position. Both sides of a zero-width widget are the same
 * doc position; the *rendered* side decides whether an arrow key should enter
 * the ghost or move past it. The DOM selection is the source of truth
 * (`caretIsAfterWidget`); this flag records the side whenever *we* place the
 * caret, as a fallback for environments where the DOM selection is not
 * readable (jsdom tests).
 *
 * Maps host view -> widget position whose right side the caret was placed on.
 *
 * @type {WeakMap<EditorView, number>}
 */
const caretAfterFlags = new WeakMap()

/**
 * Read which side of the widget the live DOM selection is on. Returns null
 * when it cannot be determined (no selection API, selection elsewhere, or
 * inside the widget itself).
 *
 * @param {EditorView} view
 * @param {HTMLElement} container
 * @returns {boolean | null} true = caret renders after (right of) the widget
 */
const caretIsAfterWidget = (view, container) => {
  try {
    // Chrome implements getSelection on ShadowRoot too; TS's lib.dom doesn't.
    const root = /** @type {any} */ (view.root)
    const sel = /** @type {globalThis.Selection | null} */ (root.getSelection ? root.getSelection() : document.getSelection())
    const node = sel?.focusNode
    if (!node || typeof sel.focusOffset !== 'number') return null
    if (node === container.parentNode) {
      const idx = Array.prototype.indexOf.call(node.childNodes, container)
      return sel.focusOffset > idx
    }
    const cmp = container.compareDocumentPosition(/** @type {Node} */ (node))
    if (cmp & 16 /* CONTAINED_BY */) return null
    if (cmp & 4 /* FOLLOWING */) return true
    if (cmp & 2 /* PRECEDING */) return false
    return null
  } catch {
    return null
  }
}

/**
 * Move the DOM caret to just after the widget container, so the caret
 * *renders* on the right side of the ghost. Requires `relaxedSide: true` on
 * the widget, otherwise ProseMirror snaps the DOM selection back to the side
 * implied by `side`. Returns false where the selection API is unavailable
 * (jsdom) — callers fall back to `caretAfterFlags`.
 *
 * @param {EditorView} view
 * @param {HTMLElement} container
 * @returns {boolean}
 */
const placeCaretAfterWidget = (view, container) => {
  try {
    // Chrome implements getSelection on ShadowRoot too; TS's lib.dom doesn't.
    const root = /** @type {any} */ (view.root)
    const sel = /** @type {globalThis.Selection | null} */ (root.getSelection ? root.getSelection() : document.getSelection())
    const doc = container.ownerDocument
    if (!sel || !doc || typeof sel.removeAllRanges !== 'function') return false
    const range = doc.createRange()
    range.setStartAfter(container)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the caret's visual side relative to an inline ghost, preferring the
 * live DOM selection and falling back to the placement flag.
 *
 * @param {EditorView} view
 * @param {HTMLElement} container
 * @param {number} widgetPos
 * @returns {boolean} true = caret renders after (right of) the widget
 */
const caretRendersAfter = (view, container, widgetPos) => {
  const domSide = caretIsAfterWidget(view, container)
  if (domSide !== null) return domSide
  return caretAfterFlags.get(view) === widgetPos
}

/**
 * Move the caret into a sub-editor at its start (side > 0) or end (side < 0).
 *
 * @param {EditorView} view
 * @param {number} side
 * @returns {true}
 */
const focusSubEditor = (view, side) => {
  const sel = side > 0 ? Selection.atStart(view.state.doc) : Selection.atEnd(view.state.doc)
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
  view.focus()
  return true
}

/**
 * Build the widget DOM for a deletion. The outermost element is a
 * *non-editable shell* matching the deletion's structural shape
 * (`span` / `div` / `tr` / `td`) so the widget stays valid HTML in its
 * surrounding context — a real `<tr>` of `<td>`s between table rows keeps
 * the table's layout and CSS intact.
 *
 * The sub-editor mounts on an element *inside* the shell: the
 * `contenteditable=false` shell is what makes the nested editor separately
 * focusable at all (without that boundary the browser merges it into the
 * host editor's editing context), and browsers additionally refuse
 * `contenteditable` roots directly on table elements.
 *   - inline: an editable `<span>` inside the `<span>` shell
 *   - block:  an editable `<div>` inside the `<div>` shell
 *   - cell:   an editable `<div>` inside the `<td>` shell
 *   - row:    one editable `<div>` inside each `<td>` of the `<tr>` shell,
 *     with ArrowLeft/Right at a cell's edge hopping to the neighbouring
 *     cell before exiting the widget at the outer edges.
 *
 * @param {Diff} diff
 * @param {import('prosemirror-model').Schema} innerSchema
 * @param {DeletionShape} shape
 * @param {{ color?: string, title?: string }} opts
 * @param {string} key - the widget's stable decoration key
 * @param {EditorView} outerView
 * @param {() => number | undefined} getPos
 * @param {Record<string, any>} spec - the widget decoration's spec object
 * @returns {HTMLElement}
 */
const createDeletionDOM = (diff, innerSchema, shape, opts, key, outerView, getPos, spec) => {
  const container = document.createElement(shapeTag[shape])
  container.className = 'pm-suggest pm-suggest--delete pm-suggest--editable'
  container.setAttribute('data-diff-type', diff.type)
  const authorIds = diff.attribution.authorIds
  if (authorIds.length) container.setAttribute('data-diff-user-id', authorIds.join(','))
  if (opts.color) container.style.setProperty('--author-color', opts.color)
  if (opts.title) container.setAttribute('title', opts.title)

  /**
   * Exit the whole widget into the host editor.
   *
   * @param {number} bias - -1 exits before the widget, 1 after it
   */
  const exit = (bias) => {
    const pos = getPos()
    if (pos == null) return false
    const sel = Selection.near(outerView.state.doc.resolve(pos), bias)
    outerView.dispatch(outerView.state.tr.setSelection(sel).scrollIntoView())
    outerView.focus()
    if (bias > 0 && shape === 'inline') {
      // Exiting right from an inline ghost lands on the widget's own position
      // (there is no separate doc position to its right). Render the caret on
      // the right side so the exit is visible, and remember the side for the
      // next arrow press.
      placeCaretAfterWidget(outerView, container)
      caretAfterFlags.set(outerView, pos)
    } else {
      caretAfterFlags.delete(outerView)
    }
    return true
  }

  /** @type {EditorView[]} */
  const views = []
  /**
   * Arrow commands for the view at `index`: at the doc edge, move to the
   * neighbouring cell view, or exit the widget at the outer edges.
   *
   * @param {number} index
   */
  const edgeBindings = (index) => {
    /** @type {import('prosemirror-state').Command} */
    const left = (state) =>
      state.selection.empty && state.selection.head <= Selection.atStart(state.doc).head &&
      (index > 0 ? focusSubEditor(views[index - 1], -1) : exit(-1))
    /** @type {import('prosemirror-state').Command} */
    const right = (state) =>
      state.selection.empty && state.selection.head >= Selection.atEnd(state.doc).head &&
      (index < views.length - 1 ? focusSubEditor(views[index + 1], 1) : exit(1))
    return { ArrowLeft: left, ArrowRight: right, ArrowUp: left, ArrowDown: right }
  }

  /**
   * @param {HTMLElement} mount
   * @param {import('prosemirror-model').Node} innerDoc
   * @param {number} index
   */
  const addView = (mount, innerDoc, index) => {
    views.push(new EditorView({ mount }, {
      state: EditorState.create({
        doc: innerDoc,
        plugins: [keymap(edgeBindings(index)), keymap(baseKeymap)]
      }),
      attributes: { class: 'pm-suggest__sub-editor' }
    }))
  }

  // The shell is the non-editable island boundary; the editor(s) inside it
  // are separately focusable because of it.
  container.contentEditable = 'false'
  if (shape === 'row') {
    rowCellDocs(diff.content ?? Fragment.empty, innerSchema).forEach((cellDoc, i) => {
      const td = document.createElement('td')
      container.appendChild(td)
      const mount = document.createElement('div')
      td.appendChild(mount)
      addView(mount, cellDoc, i)
    })
  } else {
    const mount = document.createElement(shape === 'inline' ? 'span' : 'div')
    container.appendChild(mount)
    addView(mount, fragmentToInnerDoc(diff.content ?? Fragment.empty, innerSchema, shape), 0)
  }

  const entry = { views, container }
  spec.subEditors = entry
  subEditorsByKey.set(key, entry)
  return container
}

/**
 * Build a widget decoration that renders a deletion as an editable sub-editor.
 *
 * @param {Diff} diff
 * @param {import('prosemirror-model').Schema} schema
 * @param {{ color?: string, title?: string }} [opts]
 * @returns {Decoration}
 */
export const editableDeletionWidget = (diff, schema, opts = {}) => {
  const shape = detectShape(diff.content ?? Fragment.empty)
  const innerSchema = getInnerSchema(schema, shape)
  const key = deletionKey(diff)
  /** @type {Record<string, any>} */
  const spec = {
    side: 1,
    key,
    ignoreSelection: true,
    // Let a client-set DOM selection stay on the right side of the ghost
    // (used when exiting right / stepping onto the ghost's right edge).
    relaxedSide: true,
    stopEvent: () => true,
    destroy: () => {
      spec.subEditors?.views?.forEach((/** @type {EditorView} */ v) => v.destroy())
      spec.subEditors = undefined
      subEditorsByKey.delete(key)
    },
    diff,
    // Populated by createDeletionDOM when the widget is first rendered.
    /** @type {SubEditorEntry | undefined} */
    subEditors: undefined
  }
  return Decoration.widget(
    diff.from,
    (view, getPos) => createDeletionDOM(diff, innerSchema, shape, opts, key, view, getPos, spec),
    spec
  )
}

/**
 * Find an editable-deletion widget decoration sitting exactly at `pos`.
 *
 * @param {import('prosemirror-view').DecorationSet} decoSet
 * @param {number} pos
 * @returns {import('prosemirror-view').Decoration | undefined}
 */
const findDeletionWidgetAt = (decoSet, pos) =>
  decoSet.find(pos, pos).find((deco) => {
    const type = deco.spec?.diff?.type
    return deco.from === pos && deco.to === pos &&
      (type === 'inline-delete' || type === 'block-delete') &&
      typeof deco.spec?.key === 'string'
  })

/**
 * Host-editor keydown handler that moves the caret *into* a deletion
 * sub-editor when an arrow key crosses the widget boundary:
 *
 *   - ArrowRight with the caret immediately left of a widget (same position
 *     for inline ghosts; end of the previous textblock for block ghosts)
 *     enters the sub-editor at its start.
 *   - ArrowLeft with the caret immediately right of a widget enters the
 *     sub-editor at its end.
 *
 * Wired into `ySuggestionDecorationPlugin` as its `handleKeyDown` prop; it is
 * a no-op (returns false) unless editable-deletion widgets are mounted.
 *
 * @param {EditorView} view
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export const handleEditableDeletionArrow = (view, event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  const sel = view.state.selection
  if (!sel.empty) return false
  // Works with either decoration plugin: the live Y-backed overlay or the
  // static `suggestionDiffPlugin`.
  const decoSet = ySuggestionDecorationPluginKey.getState(view.state) ||
    suggestionDiffPluginKey.getState(view.state)
  if (!decoSet) return false

  /** @param {import('prosemirror-view').Decoration} widget */
  const entryFor = (widget) => /** @type {SubEditorEntry | undefined} */ (widget.spec.subEditors) ||
    (typeof widget.spec.key === 'string' ? subEditorsByKey.get(widget.spec.key) : undefined)
  /**
   * @param {import('prosemirror-view').Decoration} widget
   * @param {1 | -1} side - 1 enters at the ghost's start, -1 at its end
   */
  const enter = (widget, side) => {
    const entry = entryFor(widget)
    if (!entry || entry.views.length === 0) return false
    caretAfterFlags.delete(view)
    // Entering from the left lands in the first sub-editor, from the right
    // in the last (row ghosts hold one editor per deleted cell).
    const innerView = side > 0 ? entry.views[0] : entry.views[entry.views.length - 1]
    return focusSubEditor(innerView, side)
  }

  const $head = sel.$head
  const head = $head.pos

  if (event.key === 'ArrowRight') {
    const widget = findDeletionWidgetAt(decoSet, head)
    if (widget && widget.spec.diff.type === 'inline-delete') {
      const entry = entryFor(widget)
      if (!entry) return false
      if (caretRendersAfter(view, entry.container, widget.from)) {
        // Caret already renders right of the ghost — let the default motion
        // continue past it.
        caretAfterFlags.delete(view)
        return false
      }
      return enter(widget, 1)
    }
    if (widget) return enter(widget, 1)
    // Block ghost past the end of the current textblock. The widget may sit
    // several closing tokens away when the boundary crosses nested nodes
    // (e.g. paragraph -> cell -> row in a table), so walk up the depth chain
    // as long as only closing tokens separate the caret from the boundary...
    let boundary = -1
    for (let d = $head.depth; d >= 1; d--) {
      const after = $head.after(d)
      if (after !== head + ($head.depth - d + 1)) break
      const blockWidget = findDeletionWidgetAt(decoSet, after)
      if (blockWidget) return enter(blockWidget, 1)
      boundary = after
    }
    // ...and then descend into the *following* node's leading edge (e.g. a
    // deleted first row sits inside the table, just past its opening token).
    if (boundary >= 0) {
      let q = boundary
      let next = view.state.doc.resolve(q).nodeAfter
      while (next && next.isBlock && !next.isTextblock) {
        q += 1
        const blockWidget = findDeletionWidgetAt(decoSet, q)
        if (blockWidget) return enter(blockWidget, 1)
        next = view.state.doc.resolve(q).nodeAfter
      }
    }
    return false
  }

  // ArrowLeft.
  const widgetHere = findDeletionWidgetAt(decoSet, head)
  if (widgetHere && widgetHere.spec.diff.type === 'inline-delete') {
    const entry = entryFor(widgetHere)
    if (entry && caretRendersAfter(view, entry.container, widgetHere.from)) {
      // Caret renders right of the ghost — step into it at its end.
      return enter(widgetHere, -1)
    }
    // Caret renders left of the ghost — default motion continues leftwards.
  }
  const widget = findDeletionWidgetAt(decoSet, head - 1)
  if (widget && widget.spec.diff.type === 'inline-delete') {
    // Step onto the ghost's right edge first (one visual slot per press,
    // like real text); the next ArrowLeft enters the ghost at its end.
    const entry = entryFor(widget)
    if (!entry) return false
    const target = Selection.near(view.state.doc.resolve(widget.from), -1)
    view.dispatch(view.state.tr.setSelection(target).scrollIntoView())
    placeCaretAfterWidget(view, entry.container)
    caretAfterFlags.set(view, widget.from)
    return true
  }
  // Block ghost at the boundary before this textblock — possibly several
  // opening tokens back when the boundary crosses nested nodes (tables)...
  let boundary = -1
  for (let d = $head.depth; d >= 1; d--) {
    const before = $head.before(d)
    if (before !== head - ($head.depth - d + 1)) break
    const blockWidget = findDeletionWidgetAt(decoSet, before)
    if (blockWidget) return enter(blockWidget, -1)
    boundary = before
  }
  // ...and then descend into the *preceding* node's trailing edge (e.g. a
  // deleted last row sits inside the table, just before its closing token).
  if (boundary >= 0) {
    let q = boundary
    let prev = view.state.doc.resolve(q).nodeBefore
    while (prev && prev.isBlock && !prev.isTextblock) {
      q -= 1
      const blockWidget = findDeletionWidgetAt(decoSet, q)
      if (blockWidget) return enter(blockWidget, -1)
      prev = view.state.doc.resolve(q).nodeBefore
    }
  }
  return false
}

/**
 * A `mapDiffToDecorations` implementation that renders deletions as editable
 * sub-editors and defers everything else to the default mapping. Pass it to
 * `ySuggestionDecorationPlugin({ mapDiffToDecorations: editableDeletionMapDiff })`.
 *
 * @type {import('./diff-decorations.js').MapDiffToDecorations}
 */
export const editableDeletionMapDiff = (args) => {
  const { diff, schema, color } = args
  if (diff.type === 'inline-delete' || diff.type === 'block-delete') {
    return editableDeletionWidget(diff, schema, { color })
  }
  return defaultMapDiffToDecorations(args)
}

/**
 * Per-ytype anchor offsets for inline ghosts, keyed by the ghost's stable
 * widget key. The offset counts how many characters of the attributed insert
 * run adjacent to the ghost belong to the ghost's *left* — i.e. text the user
 * typed with the caret on the ghost's left side. Default (no entry) is 0:
 * the ghost renders before the whole insert run.
 *
 * @type {WeakMap<object, Map<string, number>>}
 */
const ghostAnchorOffsets = new WeakMap()

/**
 * Host-editor text-input handler that makes typing at a ghost boundary
 * cursor-side aware. When text is typed exactly at an inline ghost's
 * position with the caret rendering on the ghost's *left*, the typed length
 * is added to the ghost's anchor offset so the rebuild keeps the ghost to the
 * right of that text. Typing on the ghost's right needs no record — the
 * default delta order already renders the ghost before the insert run.
 *
 * Never consumes the event (always returns false); it only records intent.
 *
 * @param {EditorView} view
 * @param {number} from
 * @param {number} to
 * @param {string} text
 * @returns {boolean}
 */
export const handleEditableDeletionTextInput = (view, from, to, text) => {
  if (!text || from !== to) return false
  // Works with either decoration plugin: the live Y-backed overlay or the
  // static `suggestionDiffPlugin`.
  const decoSet = ySuggestionDecorationPluginKey.getState(view.state) ||
    suggestionDiffPluginKey.getState(view.state)
  if (!decoSet) return false
  const widget = findDeletionWidgetAt(decoSet, from)
  if (!widget || widget.spec.diff.type !== 'inline-delete') return false
  const entry = /** @type {SubEditorEntry | undefined} */ (widget.spec.subEditors) ||
    (typeof widget.spec.key === 'string' ? subEditorsByKey.get(widget.spec.key) : undefined)
  if (!entry) return false
  if (caretRendersAfter(view, entry.container, widget.from)) return false
  const ytype = ySyncPluginKey.getState(view.state)?.ytype
  if (!ytype) return false
  let offsets = ghostAnchorOffsets.get(ytype)
  if (!offsets) {
    offsets = new Map()
    ghostAnchorOffsets.set(ytype, offsets)
  }
  const key = /** @type {string} */ (widget.spec.key)
  offsets.set(key, (offsets.get(key) ?? 0) + text.length)
  return false
}

/**
 * Re-anchor inline delete diffs according to recorded anchor offsets. Called
 * by the suggestion decoration plugin after `ydeltaToDiffSet` on every
 * rebuild. For a delete diff with a recorded offset, the ghost moves that
 * many characters into the attributed insert run that starts at its position
 * (clamped to the run's length), so text typed with the caret left of the
 * ghost renders on its left.
 *
 * @param {object | null} ytype
 * @param {Diff[]} diffs
 * @returns {Diff[]}
 */
export const applyGhostAnchorOffsets = (ytype, diffs) => {
  const offsets = ytype && ghostAnchorOffsets.get(ytype)
  if (!offsets || offsets.size === 0) return diffs
  return diffs.map((diff) => {
    if (diff.type !== 'inline-delete') return diff
    const offset = offsets.get(deletionKey(diff))
    if (!offset) return diff
    // The adjacent attributed insert run beginning at the ghost's position.
    const run = diffs.find((d) =>
      d.type === 'inline-insert' && d.from <= diff.from && diff.from < d.to
    ) ?? diffs.find((d) => d.type === 'inline-insert' && d.from === diff.from)
    if (!run) return diff
    const anchored = Math.min(run.from + offset, run.to)
    if (anchored === diff.from) return diff
    return { ...diff, from: anchored, to: anchored }
  })
}
