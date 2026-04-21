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
 * A marker is a leaf Delta with name = node type name, attrs = original node attrs + { depth: N }.
 * Text is inlined at the top level. Inline nodes (image, hard_break) are also inlined
 * as leaf Deltas but WITHOUT a depth attribute, so they are distinguishable from block markers.
 *
 * Formatting (marks) on text and inline nodes are preserved as delta formatting attributes.
 */

import * as delta from 'lib0/delta'
import * as s from 'lib0/schema'

// ---------------------------------------------------------------------------
// Schema for flat deltas
// ---------------------------------------------------------------------------

/**
 * Schema for a flat prosemirror delta. The top-level delta has no name (like docToDelta),
 * and its children are a mix of:
 * - TextOps (inline text with optional formatting)
 * - InsertOps containing leaf Deltas (markers for block nodes, or inline nodes)
 */
export const $flatDelta = delta.$delta({
  name: s.$string,
  attrs: s.$record(s.$string, s.$any),
  text: true,
  recursiveChildren: true
})

// ---------------------------------------------------------------------------
// flatten: tree delta -> flat delta
// ---------------------------------------------------------------------------

/**
 * Flatten a tree-shaped ProseMirror delta into a flat sequence with depth markers.
 *
 * @param {delta.Delta} treeDelta - A tree delta as produced by `nodeToDelta()` or `docToDelta()`
 * @return {delta.DeltaBuilder} A flat delta (not yet done())
 */
export const flatten = (treeDelta) => {
  const flat = delta.create(treeDelta.name, $flatDelta)
  // Copy top-level attrs (doc attrs)
  for (const attr of treeDelta.attrs) {
    flat.setAttr(attr.key, attr.value)
  }
  flattenChildren(flat, treeDelta, 1)
  return flat
}

/**
 * Recursively flatten children of a node delta into the flat builder.
 *
 * @param {delta.DeltaBuilder} flat - The flat delta builder to append to
 * @param {delta.Delta} node - The current tree node whose children we're flattening
 * @param {number} depth - The depth of `node`'s children (node itself is at depth-1)
 */
const flattenChildren = (flat, node, depth) => {
  node.children.forEach(op => {
    if (delta.$textOp.check(op)) {
      // Inline text -> copy directly with formatting
      flat.insert(op.insert, op.format)
    } else if (delta.$insertOp.check(op)) {
      for (const child of op.insert) {
        if (!delta.$deltaAny.check(child)) {
          // Non-delta content (shouldn't happen in well-formed PM deltas)
          flat.insert([child], op.format)
          continue
        }
        if (isInlineNode(child)) {
          // Inline node (image, hard_break, etc.) -> insert as-is, no depth
          flat.insert([child], op.format)
        } else {
          // Block node -> emit marker + recurse
          const marker = delta.create(child.name, $flatDelta)
          // Copy the node's own attrs
          for (const attr of child.attrs) {
            marker.setAttr(attr.key, attr.value)
          }
          marker.setAttr('depth', depth)
          flat.insert([marker.done()])
          // Recurse into this node's children at depth+1
          flattenChildren(flat, child, depth + 1)
        }
      }
    }
    // RetainOp, DeleteOp, ModifyOp should not appear in a "final" document delta
  })
}

/**
 * Determine whether a delta represents an inline node (no block children, no depth).
 * In ProseMirror, inline nodes (image, hard_break) are leaf nodes that sit inside
 * a text-containing block. Block nodes contain other block nodes or text.
 *
 * Heuristic: a node is inline if it has no children at all (childCnt === 0)
 * AND its name is not a known wrapper-only node. Since we want to be schema-agnostic,
 * we check: if the node has any child that is itself a Delta (block child), it's a block.
 * Otherwise, if it has only text children or no children, we need the caller to tell us.
 *
 * For this POC, we use a simple rule: a node is inline if it has zero children
 * (leaf inline nodes like image, hard_break). Block nodes with zero children
 * (empty paragraph) still get markers because they ARE blocks.
 *
 * The challenge: an empty paragraph (block, 0 children) vs hard_break (inline, 0 children)
 * are indistinguishable by structure alone. We need schema info OR a convention.
 *
 * Convention for flatten(): All children of an InsertOp that are Deltas are treated as
 * block nodes UNLESS the parent already has text siblings. But this is fragile.
 *
 * Better approach: flatten() receives the tree delta which was created from a PM node.
 * In PM, the content expression determines whether children are inline or block.
 * In the tree delta from nodeToDelta(), block children are InsertOps containing Deltas,
 * while text children are TextOps. A block node that contains inline content will have
 * TextOps and inline-node InsertOps as direct children. A block node that contains
 * block content will have InsertOps containing only Delta children.
 *
 * So the rule is: if a Delta child appears alongside TextOps in the same parent,
 * it's an inline node. If it appears in a parent that has NO TextOps, it's a block node.
 *
 * Actually, the simplest correct approach: check if the parent has ANY text ops.
 * If yes, all Delta children of that parent are inline nodes.
 * If no, all Delta children are block nodes.
 *
 * But we need to know this per-parent, not per-child. Let's check the parent node.
 *
 * @param {delta.Delta} child
 * @return {boolean}
 */
const isInlineNode = (child) => {
  // Inline nodes in ProseMirror are always leaf (0 children) and have no text content.
  // But empty paragraphs also have 0 children.
  // The real discriminator: this function is only called from flattenChildren,
  // which already knows the parent context. We'll refactor to pass that context.
  // For now, return false -- we'll use parent-level detection instead.
  return false
}

/**
 * Check if a tree delta node contains inline content (has text ops among its children).
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

// Override flattenChildren to use parent-level inline detection
/**
 * Recursively flatten children of a node delta into the flat builder.
 * Uses parent-level detection to distinguish inline nodes from block nodes.
 *
 * @param {delta.DeltaBuilder} flat
 * @param {delta.Delta} node
 * @param {number} depth
 */
const flattenChildrenImpl = (flat, node, depth) => {
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
          // Insert as-is without depth marker
          flat.insert([child], op.format)
        } else {
          // Parent has no text content -> this is a block node
          const marker = delta.create(child.name, $flatDelta)
          for (const attr of child.attrs) {
            marker.setAttr(attr.key, attr.value)
          }
          marker.setAttr('depth', depth)
          flat.insert([marker.done()])
          flattenChildrenImpl(flat, child, depth + 1)
        }
      }
    }
  })
}

// Re-export the correct implementation
/**
 * Flatten a tree-shaped ProseMirror delta into a flat sequence with depth markers.
 *
 * @param {delta.Delta} treeDelta - A tree delta as produced by `nodeToDelta()` or `docToDelta()`
 * @return {delta.DeltaBuilder} A flat delta (not yet done())
 */
export const flattenDelta = (treeDelta) => {
  const flat = delta.create(treeDelta.name, $flatDelta)
  for (const attr of treeDelta.attrs) {
    flat.setAttr(attr.key, attr.value)
  }
  flattenChildrenImpl(flat, treeDelta, 1)
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
 * @param {delta.Delta} flatDelta
 * @return {delta.DeltaBuilder}
 */
export const unflattenDelta = (flatDelta) => {
  // The root builder represents the doc node
  const root = delta.create(flatDelta.name, $flatDelta)
  for (const attr of flatDelta.attrs) {
    root.setAttr(attr.key, attr.value)
  }

  /** @type {Array<StackEntry>} */
  const stack = [{ depth: 0, name: flatDelta.name, builder: root }]

  flatDelta.children.forEach(op => {
    if (delta.$textOp.check(op)) {
      // Text content -> append to the top of the stack (innermost open node)
      stack[stack.length - 1].builder.insert(op.insert, op.format)
    } else if (delta.$insertOp.check(op)) {
      for (const child of op.insert) {
        if (!delta.$deltaAny.check(child)) {
          // Non-delta content -> append to current top
          stack[stack.length - 1].builder.insert([child], op.format)
          continue
        }

        // Check if this is a block marker (has depth attr) or an inline node
        const depthAttr = getDepthAttr(child)

        if (depthAttr !== null) {
          // Block marker: pop stack until top.depth < depthAttr
          while (stack.length > 1 && stack[stack.length - 1].depth >= depthAttr) {
            const popped = stack.pop()
            // Close the popped node and add it as a child of the new top
            stack[stack.length - 1].builder.insert([popped.builder.done(false)])
          }

          // Create a new builder for this block node
          const nodeBuilder = delta.create(child.name, $flatDelta)
          // Copy attrs from the marker EXCEPT depth
          for (const attr of child.attrs) {
            if (attr.key !== 'depth') {
              nodeBuilder.setAttr(attr.key, attr.value)
            }
          }

          stack.push({ depth: depthAttr, name: child.name, builder: nodeBuilder })
        } else {
          // Inline node (no depth) -> append to current top with formatting
          stack[stack.length - 1].builder.insert([child], op.format)
        }
      }
    }
  })

  // Close all remaining open nodes
  while (stack.length > 1) {
    const popped = stack.pop()
    stack[stack.length - 1].builder.insert([popped.builder.done(false)])
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
    if (attr.key === 'depth') {
      return /** @type {number} */ (attr.value)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Convenience: PM Node round-trip via flat delta
// ---------------------------------------------------------------------------

/**
 * Convert a ProseMirror Node to a flat delta.
 * Requires nodeToDelta from sync-utils (passed to avoid circular deps).
 *
 * @param {delta.Delta} treeDelta - result of nodeToDelta(node) or docToDelta(doc)
 * @return {delta.Delta}
 */
export const treeToFlat = (treeDelta) => flattenDelta(treeDelta).done(false)

/**
 * Convert a flat delta back to a tree delta.
 *
 * @param {delta.Delta} flatDelta
 * @return {delta.Delta}
 */
export const flatToTree = (flatDelta) => unflattenDelta(flatDelta).done(false)
