/**
 * @module flatten
 *
 * Proof-of-concept: schema-agnostic flattening of a ProseMirror-style tree delta
 * into a flat sequence with depth-annotated markers, and the inverse unflatten.
 *
 * Flat representation:
 *   Tree:  doc > blockquote > [p("hello"), p("world")]
 *   Flat:  [marker(blockquote,depth=1)] [marker(p,depth=2)] "hello" [marker(p,depth=2)] "world"
 *
 * A marker is a leaf Delta with name = node type name, attrs = original node attrs + { 'y-prosemirror-depth': N }.
 * Text is inlined at the top level. Inline nodes (image, hard_break) are also inlined
 * as leaf Deltas but WITHOUT a depth attribute, so they are distinguishable from block markers.
 *
 * Formatting (marks) on text and inline nodes are preserved as delta formatting attributes.
 *
 * ## Inline vs block detection
 *
 * The core challenge is distinguishing inline nodes (image, hard_break) from block nodes
 * (paragraph, blockquote) without access to the ProseMirror schema. Both can be leaf Deltas
 * with zero children — an empty paragraph and a hard_break look identical structurally.
 *
 * We use a parent-level heuristic that exploits a ProseMirror invariant: a node's content
 * is either ALL inline (text + inline nodes) or ALL block (other block nodes), never mixed.
 * In the tree delta produced by `nodeToDelta()`, inline content appears as TextOps, while
 * block content appears as InsertOps containing Deltas with no TextOps alongside them.
 *
 * Therefore: if a parent node has ANY TextOps among its children, ALL its Delta children
 * are inline nodes. If it has NO TextOps, all Delta children are block nodes.
 */

import * as delta from 'lib0/delta'
import * as s from 'lib0/schema'
import { $prosemirrorDelta } from './sync-utils.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Reserved attribute key for depth annotations on block markers.
 * Uses a namespaced name to avoid collision with real ProseMirror node attributes.
 */
export const DEPTH_ATTR = 'y-prosemirror-depth'

// ---------------------------------------------------------------------------
// Schema for flat deltas
// ---------------------------------------------------------------------------

/**
 * Schema for a flat block marker — a leaf delta with a name, attributes,
 * but NO children and NO text. Markers represent the "opening" of a block node
 * in the flat sequence.
 */
export const $flatMarker = delta.$delta({
  name: s.$string,
  attrs: s.$record(s.$string, s.$any)
  // text: false (default), children: null (default) => no text, no children
})

/**
 * Schema for a flat prosemirror delta. The top-level delta has no name (like docToDelta),
 * and its children are a mix of:
 * - TextOps (inline text with optional formatting)
 * - InsertOps containing leaf Deltas (block markers matching $flatMarker, or inline nodes)
 *
 * Uses `children: delta.$deltaAny` instead of `recursiveChildren: true` so that
 * child deltas are accepted but cannot themselves be flat deltas with nested children
 * (enforcing true flatness at the schema level).
 */
export const $flatDelta = delta.$delta({
  name: s.$string,
  attrs: s.$record(s.$string, s.$any),
  text: true,
  children: delta.$deltaAny
})

// ---------------------------------------------------------------------------
// flatten: tree delta -> flat delta
// ---------------------------------------------------------------------------

/**
 * Check if a tree delta node contains inline content (has text ops among its children).
 *
 * This exploits a ProseMirror invariant: a node's content is either ALL inline
 * (text + inline nodes like image, hard_break) or ALL block (paragraph, blockquote, etc.),
 * never mixed. In the tree delta produced by `nodeToDelta()`, inline content appears as
 * TextOps, while block content appears as InsertOps containing Deltas with no TextOps
 * alongside them.
 *
 * **Soundness:** This heuristic is sound for full-document flatten/unflatten because
 * `nodeToDelta()` always produces tree deltas that respect PM's inline-or-block invariant.
 * It would NOT be sound for partial/incremental change deltas where parent context may be
 * absent — that use case would need the ProseMirror schema for classification.
 *
 * @param {delta.Delta} node
 * @return {boolean}
 */
const hasInlineContent = (node) => {
  let hasText = false
  node.children.forEach(op => {
    if (delta.$textOp.check(op)) {
      hasText = true
    }
  })
  return hasText
}

/**
 * Recursively flatten children of a node delta into the flat builder.
 *
 * Uses parent-level detection to distinguish inline nodes from block nodes:
 * if the parent has any TextOps, all its Delta children are inline (inserted as-is
 * without a depth marker). Otherwise, they are block nodes (emitted as depth markers).
 *
 * Block marker formatting (e.g., attribution marks on block nodes) is preserved by
 * passing `op.format` through to the marker's InsertOp.
 *
 * @param {delta.DeltaBuilder} flat - The flat delta builder to append to
 * @param {delta.Delta} node - The current tree node whose children we're flattening
 * @param {number} depth - The depth of `node`'s children (node itself is at depth-1)
 */
const flattenChildren = (flat, node, depth) => {
  const parentHasInlineContent = hasInlineContent(node)

  node.children.forEach(op => {
    if (delta.$textOp.check(op)) {
      flat.insert(op.insert, op.format)
    } else if (delta.$insertOp.check(op)) {
      for (const child of op.insert) {
        if (!delta.$deltaAny.check(child)) {
          flat.insert([child], op.format)
          continue
        }
        if (parentHasInlineContent) {
          // Parent has text content -> this Delta child is an inline node
          flat.insert([child], op.format)
        } else {
          // Parent has no text content -> this is a block node
          const marker = delta.create(child.name, $flatMarker)
          for (const attr of child.attrs) {
            marker.setAttr(/** @type {string} */ (attr.key), attr.value)
          }
          marker.setAttr(DEPTH_ATTR, depth)
          // Preserve formatting (e.g., attribution marks on block nodes)
          flat.insert([marker.done()], op.format)
          flattenChildren(flat, child, depth + 1)
        }
      }
    }
  })
}

/**
 * Flatten a tree-shaped ProseMirror delta into a flat sequence with depth markers.
 *
 * @param {delta.Delta} treeDelta - A tree delta as produced by `nodeToDelta()` or `docToDelta()`
 * @return {delta.DeltaBuilder} A flat delta (not yet done())
 */
export const flattenDelta = (treeDelta) => {
  const flat = delta.create(treeDelta.name, $flatDelta)
  for (const attr of treeDelta.attrs) {
    flat.setAttr(/** @type {string} */ (attr.key), attr.value)
  }
  flattenChildren(flat, treeDelta, 1)
  return flat
}

// ---------------------------------------------------------------------------
// unflatten: flat delta -> tree delta
// ---------------------------------------------------------------------------

/**
 * @typedef {object} StackEntry
 * @property {number} depth
 * @property {string|null} name
 * @property {delta.DeltaBuilder} builder
 * @property {import('lib0/delta').FormattingAttributes|null} format - formatting from the marker's InsertOp
 */

/**
 * Unflatten a flat delta (with depth markers) back into a tree-shaped delta.
 *
 * Algorithm: maintain a stack of open nodes. When we encounter a marker at depth d:
 * 1. Pop entries from the stack until the top has depth < d
 * 2. Create a new DeltaBuilder for this marker
 * 3. Push it onto the stack as a child of the current top
 *
 * Text and inline nodes are appended to the current top of the stack.
 *
 * Block marker formatting (e.g., attribution marks on block nodes) is preserved
 * by storing `op.format` on each stack entry and applying it when the entry is
 * popped and inserted as a child of its parent.
 *
 * @param {delta.Delta} flatDelta
 * @return {delta.DeltaBuilder}
 */
export const unflattenDelta = (flatDelta) => {
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

          // Create a new builder for this block node
          const nodeBuilder = delta.create(child.name, $prosemirrorDelta)
          for (const attr of child.attrs) {
            if (attr.key !== DEPTH_ATTR) {
              nodeBuilder.setAttr(/** @type {string} */ (attr.key), attr.value)
            }
          }

          stack.push({ depth: depthAttr, name: child.name, builder: nodeBuilder, format: op.format })
        } else {
          // Inline node (no depth attr) -> append to current top with formatting
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
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate structural invariants of a flat delta.
 *
 * Checks:
 * 1. Block markers (deltas with DEPTH_ATTR) must have zero children (leaf-only).
 * 2. Depth values must form valid nesting: each marker's depth must be <= previous depth + 1
 *    (i.e., you can't jump from depth 1 to depth 3 without going through depth 2).
 * 3. All depth values must be positive integers.
 * 4. No nested deltas with children (flat structure must be truly flat — block markers
 *    must not contain their own child ops).
 *
 * @param {delta.Delta} flatDelta
 * @return {{ valid: boolean, errors: string[] }}
 */
export const validateFlatDelta = (flatDelta) => {
  /** @type {string[]} */
  const errors = []
  let prevDepth = 0
  let markerIndex = 0

  flatDelta.children.forEach(op => {
    if (delta.$insertOp.check(op)) {
      for (const child of op.insert) {
        if (!delta.$deltaAny.check(child)) continue

        const depthAttr = getDepthAttr(child)
        if (depthAttr !== null) {
          // This is a block marker
          markerIndex++

          // Check: marker must have zero children
          if (child.childCnt > 0) {
            errors.push(`Marker #${markerIndex} (${child.name}, depth=${depthAttr}) has ${child.childCnt} children — markers must be leaf-only`)
          }

          // Check: depth must be a positive integer
          if (!Number.isInteger(depthAttr) || depthAttr < 1) {
            errors.push(`Marker #${markerIndex} (${child.name}) has invalid depth: ${depthAttr} — must be a positive integer`)
          }

          // Check: valid nesting (can't skip levels)
          if (depthAttr > prevDepth + 1) {
            errors.push(`Marker #${markerIndex} (${child.name}) has depth ${depthAttr} but previous depth was ${prevDepth} — cannot skip levels`)
          }

          prevDepth = depthAttr
        } else {
          // Inline node — check it has no children (should be a leaf)
          if (child.childCnt > 0) {
            errors.push(`Inline node (${child.name}) has ${child.childCnt} children — inline nodes in flat deltas must be leaf-only`)
          }
        }
      }
    }
  })

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Flatten a tree delta and finalize it.
 *
 * @param {delta.Delta} treeDelta - result of nodeToDelta(node) or docToDelta(doc)
 * @return {delta.Delta}
 */
export const treeToFlat = (treeDelta) => flattenDelta(treeDelta).done(false)

/**
 * Unflatten a flat delta and finalize it.
 *
 * @param {delta.Delta} flatDelta
 * @return {delta.Delta}
 */
export const flatToTree = (flatDelta) => unflattenDelta(flatDelta).done(false)
