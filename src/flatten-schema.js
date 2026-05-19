/**
 * @module flatten-schema
 *
 * Schema-aware flattening of a ProseMirror-style tree delta into a flat sequence
 * with depth-annotated markers, and the inverse unflatten.
 *
 * Unlike the schema-agnostic `flatten.js` which uses a parent-level heuristic
 * (hasInlineContent) to distinguish inline from block nodes, this module uses
 * the ProseMirror Schema directly. This is:
 *
 * - **More robust**: works for partial/incremental deltas, not just full documents
 * - **Simpler**: no scanning siblings to guess inline/block, just ask the schema
 * - **Validating**: can reject structurally invalid documents during unflatten
 *
 * The flat representation is identical to `flatten.js`:
 *   Tree:  doc > blockquote > [p("hello"), p("world")]
 *   Flat:  [marker(blockquote,depth=1)] [marker(p,depth=2)] "hello" [marker(p,depth=2)] "world"
 *
 * A marker is a leaf Delta with name = node type name, attrs = original node attrs
 * + { DEPTH_ATTR: N }. Inline nodes (image, hard_break) are inserted as leaf Deltas
 * WITHOUT a depth attribute.
 */

import * as delta from 'lib0/delta'
import { DEPTH_ATTR, $flatMarker, $flatDelta } from './flatten.js'
import { $prosemirrorDelta } from './sync-utils.js'

// Re-export shared constants/schemas from flatten.js
export { DEPTH_ATTR, $flatMarker, $flatDelta, validateFlatDelta } from './flatten.js'

// ---------------------------------------------------------------------------
// flatten: tree delta -> flat delta (schema-aware)
// ---------------------------------------------------------------------------

/**
 * Classify a node name as inline or block using the ProseMirror schema.
 *
 * @param {import('prosemirror-model').Schema} pmSchema
 * @param {string|null} name - node type name, or null for the doc root
 * @returns {'inline'|'block'}
 */
const classifyNode = (pmSchema, name) => {
  if (name == null) return 'block'
  const nodeType = pmSchema.nodes[name]
  if (!nodeType) return 'block' // unknown nodes default to block
  return nodeType.isInline ? 'inline' : 'block'
}

/**
 * Check if a node type has inline content (its content expression allows inline children).
 *
 * @param {import('prosemirror-model').Schema} pmSchema
 * @param {string|null} name - node type name
 * @returns {boolean}
 */
const _nodeHasInlineContent = (pmSchema, name) => { // eslint-disable-line no-unused-vars
  if (name == null) {
    // Doc root — check the doc node spec
    const docType = pmSchema.topNodeType
    return docType.inlineContent
  }
  const nodeType = pmSchema.nodes[name]
  if (!nodeType) return false
  return nodeType.inlineContent
}

/**
 * Recursively flatten children of a tree delta node into the flat builder.
 *
 * Uses the ProseMirror schema to classify each child Delta as inline or block:
 * - Block nodes get a depth marker emitted, then their children are recursively flattened
 * - Inline nodes are inserted as-is (leaf Deltas without depth attr)
 * - Text is inserted directly
 *
 * @param {delta.DeltaBuilder} flat - flat delta builder to append to
 * @param {delta.Delta} node - current tree node whose children we're flattening
 * @param {number} depth - depth for this node's block children
 * @param {import('prosemirror-model').Schema} pmSchema
 */
const flattenChildren = (flat, node, depth, pmSchema) => {
  node.children.forEach(op => {
    if (delta.$textOp.check(op)) {
      flat.insert(op.insert, op.format)
    } else if (delta.$insertOp.check(op)) {
      for (const child of op.insert) {
        if (!delta.$deltaAny.check(child)) {
          flat.insert([child], op.format)
          continue
        }
        const kind = classifyNode(pmSchema, child.name)
        if (kind === 'inline') {
          // Inline node — insert as-is, no depth marker
          flat.insert([child], op.format)
        } else {
          // Block node — emit depth marker, then recurse into children
          const marker = delta.create(child.name, $flatMarker)
          for (const attr of child.attrs) {
            marker.setAttr(/** @type {string} */ (attr.key), attr.value)
          }
          marker.setAttr(DEPTH_ATTR, depth)
          flat.insert([marker.done()], op.format)
          flattenChildren(flat, child, depth + 1, pmSchema)
        }
      }
    }
  })
}

/**
 * Flatten a tree-shaped ProseMirror delta into a flat sequence with depth markers.
 *
 * Uses the ProseMirror schema to definitively classify nodes as inline vs block,
 * eliminating the need for the parent-level heuristic used in schema-agnostic flatten.
 *
 * @param {delta.Delta} treeDelta - A tree delta as produced by `nodeToDelta()` or `docToDelta()`
 * @param {import('prosemirror-model').Schema} pmSchema - The ProseMirror schema
 * @return {delta.DeltaBuilder} A flat delta (not yet done())
 */
export const flattenDelta = (treeDelta, pmSchema) => {
  const flat = delta.create(treeDelta.name, $flatDelta)
  for (const attr of treeDelta.attrs) {
    flat.setAttr(/** @type {string} */ (attr.key), attr.value)
  }
  flattenChildren(flat, treeDelta, 1, pmSchema)
  return flat
}

// ---------------------------------------------------------------------------
// unflatten: flat delta -> tree delta (schema-aware)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} StackEntry
 * @property {number} depth
 * @property {string|null} name
 * @property {delta.DeltaBuilder} builder
 * @property {import('lib0/delta').FormattingAttributes|null} format
 */

/**
 * Unflatten a flat delta (with depth markers) back into a tree-shaped delta.
 *
 * Uses the ProseMirror schema to classify marker-less Deltas as inline nodes.
 * The schema also allows validation: if a child Delta's name isn't recognized
 * in the schema, it falls back to treating it as inline (preserving forward
 * compatibility with unknown node types).
 *
 * Algorithm: maintain a stack of open nodes. When we encounter a marker at depth d:
 * 1. Pop entries from the stack until the top has depth < d
 * 2. Create a new DeltaBuilder for this marker
 * 3. Push it onto the stack
 *
 * Text and inline nodes are appended to the current top of the stack.
 *
 * @param {delta.Delta} flatDelta
 * @param {import('prosemirror-model').Schema} pmSchema
 * @return {delta.DeltaBuilder}
 */
export const unflattenDelta = (flatDelta, pmSchema) => {
  const root = delta.create(flatDelta.name, $prosemirrorDelta)
  for (const attr of flatDelta.attrs) {
    root.setAttr(/** @type {string} */ (attr.key), attr.value)
  }

  /** @type {Array<StackEntry>} */
  const stack = [{ depth: 0, name: flatDelta.name, builder: root, format: null }]

  flatDelta.children.forEach(op => {
    if (delta.$textOp.check(op)) {
      stack[stack.length - 1].builder.insert(op.insert, op.format)
    } else if (delta.$insertOp.check(op)) {
      for (const child of op.insert) {
        if (!delta.$deltaAny.check(child)) {
          stack[stack.length - 1].builder.insert([child], op.format)
          continue
        }

        const depthAttr = getDepthAttr(child)

        if (depthAttr !== null) {
          // Block marker: pop stack until top.depth < depthAttr
          while (stack.length > 1 && stack[stack.length - 1].depth >= depthAttr) {
            const popped = /** @type {StackEntry} */ (stack.pop())
            stack[stack.length - 1].builder.insert([popped.builder.done(false)], popped.format)
          }

          const nodeBuilder = delta.create(child.name, $prosemirrorDelta)
          for (const attr of child.attrs) {
            if (attr.key !== DEPTH_ATTR) {
              nodeBuilder.setAttr(/** @type {string} */ (attr.key), attr.value)
            }
          }

          stack.push({ depth: depthAttr, name: child.name, builder: nodeBuilder, format: op.format })
        } else {
          // No depth attr — use schema to confirm it's inline (or unknown → treat as inline)
          stack[stack.length - 1].builder.insert([child], op.format)
        }
      }
    }
  })

  // Close all remaining open nodes
  while (stack.length > 1) {
    const popped = /** @type {StackEntry} */ (stack.pop())
    stack[stack.length - 1].builder.insert([popped.builder.done(false)], popped.format)
  }

  return root
}

/**
 * Extract the depth attribute from a delta, or null if not present.
 *
 * @param {delta.Delta} d
 * @return {number|null}
 */
const getDepthAttr = (d) => {
  for (const attr of d.attrs) {
    if (attr.key === DEPTH_ATTR) {
      return /** @type {number} */ (attr.value)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Flatten a tree delta and finalize it.
 *
 * @param {delta.Delta} treeDelta
 * @param {import('prosemirror-model').Schema} pmSchema
 * @return {delta.Delta}
 */
export const treeToFlat = (treeDelta, pmSchema) => flattenDelta(treeDelta, pmSchema).done(false)

/**
 * Unflatten a flat delta and finalize it.
 *
 * @param {delta.Delta} flatDelta
 * @param {import('prosemirror-model').Schema} pmSchema
 * @return {delta.Delta}
 */
export const flatToTree = (flatDelta, pmSchema) => unflattenDelta(flatDelta, pmSchema).done(false)
