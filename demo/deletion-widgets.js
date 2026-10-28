import * as Y from '@y/y'
import * as dpos from 'lib0/delta/position'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { relativePositionsToResolvedPositions } from '../src/positions.js'

/**
 * Plain data only: deliberately independent of a ProseMirror Schema.
 * @typedef {{type: string, text?: string, attrs?: Object, marks?: Array<Object>, content?: Array<Content>}} Content
 * @typedef {{content: Array<Content>, attribution: Object, sourceRange: {from: Y.RelativePosition|null, to: Y.RelativePosition|null}, anchor: Y.RelativePosition|null}} Deletion
 * @typedef {{kind: 'text'|'node', attribution: Object, sourceRange: {from: Y.RelativePosition|null, to: Y.RelativePosition|null}}} Insertion
 * @typedef {Insertion & {from: number|null, to: number|null}} ResolvedInsertion
 */

/** @param {Object|null} format */
const marks = format => Object.entries(format ?? {}).map(([type, attrs]) => ({ type, attrs }))

/** @param {import('lib0/delta').Delta<any>} node
 * @return {Content}
 */
const toContent = node => ({
  type: node.name ?? 'doc',
  attrs: Object.fromEntries(Array.from(node.attrs, a => [a.key, a.value])),
  content: Array.from(node.children).flatMap(op => {
    if (!('insert' in op)) return []
    return typeof op.insert === 'string'
      ? [{ type: 'text', text: op.insert, marks: marks(op.format) }]
      : op.insert.map(child => ({ ...toContent(child), marks: marks(op.format) }))
  })
})

/**
 * Walk the diff projection, anchoring a deleted subtree at its parent slot.
 * Do not recurse into deleted subtrees: their interior has no live equivalent.
 * Diff offsets are converted to CRDT identities BEFORE mapping to the plain binding.
 * @param {Y.Node} root
 * @param {Y.DiffRenderer} renderer
 * @return {{deletions: Array<Deletion>, insertions: Array<Insertion>}}
 */
export const extractSuggestions = (root, renderer) => {
  /** @type {Array<Deletion>} */
  const records = []
  /** @type {Array<Insertion>} */
  const insertions = []
  /** @param {Array<number>} path
   * @param {number} offset
   * @param {number} length
   */
  const range = (path, offset, length) => {
    const [from, to] = Y.createRelativePositionsFromDeltaPositions(root, [
      dpos.create([...path, offset], 1),
      dpos.create([...path, offset + length], -1)
    ], { renderer })
    return { from, to }
  }
  /** @param {import('lib0/delta').Delta<any>} node
   * @param {Array<number>} path
   * @param {boolean} [insideInsertion]
   */
  const walk = (node, path, insideInsertion = false) => {
    let offset = 0
    for (const op of node.children) {
      if (!('insert' in op)) continue
      const length = op.insert.length
      if (op.attribution?.delete != null) {
        const sourceRange = range(path, offset, length)
        records.push({
          content: typeof op.insert === 'string'
            ? [{ type: 'text', text: op.insert, marks: marks(op.format) }]
            : op.insert.map(toContent),
          attribution: op.attribution,
          sourceRange,
          // A gap in the surviving container, never inside a deleted child.
          anchor: sourceRange.from
        })
      } else {
        const attribution = op.attribution
        const inserted = attribution?.insert != null
        if (inserted && !insideInsertion) {
          if (typeof op.insert === 'string') {
            insertions.push({ kind: 'text', attribution, sourceRange: range(path, offset, length) })
          } else {
            // Each node needs its own exact before/after boundary pair.
            op.insert.forEach((_, i) => insertions.push({
              kind: 'node', attribution, sourceRange: range(path, offset + i, 1)
            }))
          }
        }
        if (typeof op.insert !== 'string') {
          op.insert.forEach((child, i) => walk(child, [...path, offset + i], insideInsertion || inserted))
        }
      }
      offset += length
    }
  }
  walk(root.toDeltaDeep({ renderer }), [])
  return { deletions: records, insertions }
}

/** @param {Y.Node} root
 * @param {Y.DiffRenderer} renderer
 */
export const extractDeletions = (root, renderer) => extractSuggestions(root, renderer).deletions

/** @param {Array<Content>} content
 * @return {string}
 */
export const deletedText = content => content.map(n => n.text ?? deletedText(n.content ?? [])).join('')

/** @param {Deletion} record */
const widgetDOM = record => {
  const card = document.createElement('span')
  card.className = 'deleted-card'
  card.contentEditable = 'false'
  const label = document.createElement('small')
  label.textContent = 'Deleted: '
  const text = document.createElement('del')
  text.textContent = deletedText(record.content)
  const button = document.createElement('button')
  button.textContent = 'Inspect'
  button.addEventListener('click', () => window.alert(JSON.stringify(record, null, 2)))
  card.append(label, text, button)
  return card
}

/**
 * Demo-only full rebuild after synchronous binding work has settled. Listen to
 * renderer changes too: accepting a deletion need not change the live PM doc.
 * @param {Y.Node} root
 * @param {Y.DiffRenderer} renderer
 * @param {(records: Array<Deletion & {position: number|null}>, view: import('prosemirror-view').EditorView, insertions: Array<ResolvedInsertion>) => void} [onRefresh]
 */
export const suggestionDecorations = (root, renderer, onRefresh = () => {}) => {
  const key = new PluginKey('suggestion-decorations')
  return new Plugin({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, old) => tr.getMeta(key) ?? old.map(tr.mapping, tr.doc)
    },
    props: { decorations: state => key.getState(state) },
    view: view => {
      let queued = false
      let destroyed = false
      const refresh = () => {
        queued = false
        if (destroyed) return
        const { deletions: records, insertions } = extractSuggestions(root, renderer)
        const positions = relativePositionsToResolvedPositions(view, records.map(r => r.anchor))
        const widgets = records.flatMap((r, i) => {
          const position = positions[i]
          if (position == null) return []
          return [Decoration.widget(position.pos, () => widgetDOM(r), {
            side: i + 1,
            marks: [],
            ignoreSelection: true,
            stopEvent: () => true
          })]
        })
        const endpoints = relativePositionsToResolvedPositions(view, insertions.flatMap(r => [r.sourceRange.from, r.sourceRange.to]))
        const resolvedInsertions = insertions.map((r, i) => ({
          ...r, from: endpoints[i * 2]?.pos ?? null, to: endpoints[i * 2 + 1]?.pos ?? null
        }))
        for (const r of resolvedInsertions) {
          if (r.from == null || r.to == null || r.from >= r.to) continue
          if (r.kind === 'text') {
            widgets.push(Decoration.inline(r.from, r.to, { class: 'suggested-insertion' }))
          } else {
            const node = view.state.doc.nodeAt(r.from)
            // Never guess a node boundary if schema repair changed the projection.
            if (node && !node.isText && r.to === r.from + node.nodeSize) {
              widgets.push(Decoration.node(r.from, r.to, { class: 'suggested-insertion suggested-insertion-node' }))
            }
          }
        }
        view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, widgets)).setMeta('addToHistory', false))
        onRefresh(records.map((r, i) => ({ ...r, position: positions[i]?.pos ?? null })), view, resolvedInsertions)
      }
      const schedule = () => {
        if (!queued && !destroyed) {
          queued = true
          queueMicrotask(refresh)
        }
      }
      root.doc?.on('afterTransaction', schedule)
      renderer.on('change', schedule)
      schedule()
      return {
        update: (view, previous) => { if (view.state.doc !== previous.doc) schedule() },
        destroy: () => {
          destroyed = true
          root.doc?.off('afterTransaction', schedule)
          renderer.off('change', schedule)
        }
      }
    }
  })
}
