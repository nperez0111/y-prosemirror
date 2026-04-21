import * as t from 'lib0/testing'
import * as delta from 'lib0/delta'
import * as Y from '@y/y'
import * as basicSchema from 'prosemirror-schema-basic'
import { Schema } from 'prosemirror-model'
import { flattenDelta, unflattenDelta, treeToFlat, flatToTree } from '../src/flatten.js'
import { nodeToDelta, docToDelta, deltaToPNode, $prosemirrorDelta } from '../src/sync-utils.js'

const schema = new Schema({
  nodes: basicSchema.nodes,
  marks: basicSchema.marks
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a tree delta, flatten it, unflatten it, and compare to the original.
 * @param {import('lib0/testing').TestCase} _tc
 * @param {delta.Delta} treeDelta
 * @param {string} label
 */
const assertRoundTrip = (_tc, treeDelta, label) => {
  const flat = treeToFlat(treeDelta)
  const recovered = flatToTree(flat)
  console.log(`\n=== ${label} ===`)
  console.log('original tree:', JSON.stringify(treeDelta.toJSON(), null, 2))
  console.log('flat:', JSON.stringify(flat.toJSON(), null, 2))
  console.log('recovered tree:', JSON.stringify(recovered.toJSON(), null, 2))
  t.compare(treeDelta, recovered)
}

/**
 * Build a PM doc, convert to tree delta, round-trip through flat, convert back to PM,
 * and assert the PM documents are equal.
 * @param {import('lib0/testing').TestCase} _tc
 * @param {import('prosemirror-model').Node} doc
 * @param {string} label
 */
const assertPMRoundTrip = (_tc, doc, label) => {
  const treeDelta = docToDelta(doc)
  const flat = treeToFlat(treeDelta)
  const recovered = flatToTree(flat)
  const recoveredDoc = deltaToPNode(recovered, schema, null)
  console.log(`\n=== PM ${label} ===`)
  console.log('original doc:', JSON.stringify(doc.toJSON(), null, 2))
  console.log('recovered doc:', JSON.stringify(recoveredDoc.toJSON(), null, 2))
  t.compare(doc.toJSON(), recoveredDoc.toJSON())
}

// ---------------------------------------------------------------------------
// Round-trip tests: tree delta -> flat -> tree delta
// ---------------------------------------------------------------------------

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenSingleParagraph = tc => {
  // <doc><p>hello</p></doc>
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false)])
    .done(false)
  assertRoundTrip(tc, tree, 'single paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenMultipleParagraphs = tc => {
  // <doc><p>hello</p><p>world</p></doc>
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('world').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'multiple paragraphs')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenHeadingAndParagraph = tc => {
  // <doc><h1>Title</h1><p>body</p></doc>
  const heading = delta.create('heading', $prosemirrorDelta)
  heading.setAttr('level', 1)
  heading.insert('Title')

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      heading.done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('body').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'heading + paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenBlockquote = tc => {
  // <doc><blockquote><p>quoted</p></blockquote></doc>
  const bq = delta.create('blockquote', $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('quoted').done(false)
    ])
    .done(false)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([bq])
    .done(false)
  assertRoundTrip(tc, tree, 'blockquote')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenNestedBlockquote = tc => {
  // <doc><blockquote><blockquote><p>deep</p></blockquote></blockquote></doc>
  const innerBq = delta.create('blockquote', $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('deep').done(false)
    ])
    .done(false)

  const outerBq = delta.create('blockquote', $prosemirrorDelta)
    .insert([innerBq])
    .done(false)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([outerBq])
    .done(false)
  assertRoundTrip(tc, tree, 'nested blockquote')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenBlockquoteMultiParagraph = tc => {
  // <doc><blockquote><p>first</p><p>second</p></blockquote></doc>
  const bq = delta.create('blockquote', $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('first').done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('second').done(false)
    ])
    .done(false)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([bq])
    .done(false)
  assertRoundTrip(tc, tree, 'blockquote with multiple paragraphs')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenEmptyParagraph = tc => {
  // <doc><p></p></doc>
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([delta.create('paragraph', $prosemirrorDelta).done(false)])
    .done(false)
  assertRoundTrip(tc, tree, 'empty paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenFormattedText = tc => {
  // <doc><p><strong>bold</strong> normal</p></doc>
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('bold', { strong: {} })
    .insert(' normal')
    .done(false)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([p])
    .done(false)
  assertRoundTrip(tc, tree, 'formatted text')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenInlineNode = tc => {
  // <doc><p>before<hard_break/>after</p></doc>
  const hb = delta.create('hard_break', $prosemirrorDelta).done(false)
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('before')
    .insert([hb])
    .insert('after')
    .done(false)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([p])
    .done(false)
  assertRoundTrip(tc, tree, 'inline node (hard_break)')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenComplexDocument = tc => {
  // <doc>
  //   <h1>Title</h1>
  //   <p>intro</p>
  //   <blockquote>
  //     <p>quoted text</p>
  //     <p>more quoted</p>
  //   </blockquote>
  //   <p>conclusion</p>
  // </doc>
  const heading = delta.create('heading', $prosemirrorDelta)
  heading.setAttr('level', 1)
  heading.insert('Title')

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      heading.done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('intro').done(false),
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('quoted text').done(false),
        delta.create('paragraph', $prosemirrorDelta).insert('more quoted').done(false)
      ]).done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('conclusion').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'complex document')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenMixedBlockquoteContent = tc => {
  // <doc>
  //   <blockquote>
  //     <p>before</p>
  //     <blockquote><p>nested</p></blockquote>
  //     <p>after</p>
  //   </blockquote>
  // </doc>
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('before').done(false),
        delta.create('blockquote', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('nested').done(false)
        ]).done(false),
        delta.create('paragraph', $prosemirrorDelta).insert('after').done(false)
      ]).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'mixed blockquote content')
}

// ---------------------------------------------------------------------------
// PM Node round-trip tests
// ---------------------------------------------------------------------------

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMSingleParagraph = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('hello world')])
  ])
  assertPMRoundTrip(tc, doc, 'single paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMMultipleParagraphs = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('first')]),
    schema.node('paragraph', null, [schema.text('second')]),
    schema.node('paragraph', null, [schema.text('third')])
  ])
  assertPMRoundTrip(tc, doc, 'multiple paragraphs')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMBlockquote = tc => {
  const doc = schema.node('doc', null, [
    schema.node('blockquote', null, [
      schema.node('paragraph', null, [schema.text('quoted text')])
    ])
  ])
  assertPMRoundTrip(tc, doc, 'blockquote')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMFormatted = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('bold', [schema.mark('strong')]),
      schema.text(' and '),
      schema.text('italic', [schema.mark('em')])
    ])
  ])
  assertPMRoundTrip(tc, doc, 'formatted text')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMHardBreak = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('line1'),
      schema.node('hard_break'),
      schema.text('line2')
    ])
  ])
  assertPMRoundTrip(tc, doc, 'hard break')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMImage = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('before '),
      schema.node('image', { src: 'test.png', alt: 'test', title: null }),
      schema.text(' after')
    ])
  ])
  assertPMRoundTrip(tc, doc, 'image')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMComplexDoc = tc => {
  const doc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, [schema.text('Title')]),
    schema.node('paragraph', null, [
      schema.text('intro '),
      schema.text('bold', [schema.mark('strong')]),
      schema.text(' text')
    ]),
    schema.node('blockquote', null, [
      schema.node('paragraph', null, [schema.text('quote')])
    ]),
    schema.node('paragraph', null, [schema.text('end')])
  ])
  assertPMRoundTrip(tc, doc, 'complex document')
}

// ---------------------------------------------------------------------------
// Semantic operation tests: demonstrate split/merge/lift on flat representation
// ---------------------------------------------------------------------------

/**
 * Test: split = insert a marker at the split point in the flat representation.
 *
 * Original:  <doc><p>helloworld</p></doc>
 * Split at 5: <doc><p>hello</p><p>world</p></doc>
 *
 * In the flat repr, the original is:
 *   [marker(p,depth=1)] "helloworld"
 *
 * After split:
 *   [marker(p,depth=1)] "hello" [marker(p,depth=1)] "world"
 *
 * This is a single insert of a marker at position 5 in the flat sequence.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatSplitSemantics = tc => {
  // Build the "before" document
  const beforeTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('helloworld').done(false)
    ])
    .done(false)

  // Build the "after" document (what we expect after split)
  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('world').done(false)
    ])
    .done(false)

  // Flatten both
  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)

  // Compute the delta between flat representations
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  console.log('\n=== SPLIT SEMANTICS ===')
  console.log('before flat:', JSON.stringify(beforeFlat.toJSON(), null, 2))
  console.log('after flat:', JSON.stringify(afterFlat.toJSON(), null, 2))
  console.log('flat diff (split):', JSON.stringify(flatDiff.toJSON(), null, 2))

  // The diff should be: retain(6) (marker + "hello"), insert([marker(p,depth=1)]), retain(5) ("world")
  // Verify: retain past the first marker + "hello", then insert a new p marker
  let ops = []
  flatDiff.children.forEach(op => {
    if (delta.$retainOp.check(op)) ops.push({ type: 'retain', len: op.retain })
    else if (delta.$insertOp.check(op)) ops.push({ type: 'insert', count: op.insert.length, name: op.insert[0]?.name })
    else if (delta.$textOp.check(op)) ops.push({ type: 'text', text: op.insert })
    else if (delta.$deleteOp.check(op)) ops.push({ type: 'delete', len: op.delete })
  })
  console.log('diff ops:', JSON.stringify(ops))

  // Verify the split is a single marker insert (the key insight)
  const insertOps = ops.filter(o => o.type === 'insert')
  t.assert(insertOps.length === 1, 'Split should produce exactly one insert op in flat diff')
  t.assert(insertOps[0].name === 'paragraph', 'Inserted marker should be a paragraph')

  // Verify the round-trip: apply diff to beforeFlat, unflatten, compare to afterTree
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: merge = delete a marker in the flat representation.
 *
 * Original:  <doc><p>hello</p><p>world</p></doc>
 * Merge:     <doc><p>helloworld</p></doc>
 *
 * Flat before: [marker(p,depth=1)] "hello" [marker(p,depth=1)] "world"
 * Flat after:  [marker(p,depth=1)] "helloworld"
 *
 * The diff should show: retain(6), delete(1), retain(5) — deleting one marker.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatMergeSemantics = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('world').done(false)
    ])
    .done(false)

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('helloworld').done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  console.log('\n=== MERGE SEMANTICS ===')
  console.log('before flat:', JSON.stringify(beforeFlat.toJSON(), null, 2))
  console.log('after flat:', JSON.stringify(afterFlat.toJSON(), null, 2))
  console.log('flat diff (merge):', JSON.stringify(flatDiff.toJSON(), null, 2))

  let ops = []
  flatDiff.children.forEach(op => {
    if (delta.$retainOp.check(op)) ops.push({ type: 'retain', len: op.retain })
    else if (delta.$insertOp.check(op)) ops.push({ type: 'insert', count: op.insert.length })
    else if (delta.$textOp.check(op)) ops.push({ type: 'text', text: op.insert })
    else if (delta.$deleteOp.check(op)) ops.push({ type: 'delete', len: op.delete })
  })
  console.log('diff ops:', JSON.stringify(ops))

  // Verify the merge is a single delete of 1 (the marker)
  const deleteOps = ops.filter(o => o.type === 'delete')
  t.assert(deleteOps.length === 1, 'Merge should produce exactly one delete op in flat diff')
  t.assert(deleteOps[0].len === 1, 'Merge should delete exactly 1 item (the marker)')

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: lift = change marker depth in the flat representation.
 *
 * Original:  <doc><blockquote><p>text</p></blockquote></doc>
 * Lift p:    <doc><p>text</p></doc>
 *
 * Flat before: [marker(bq,depth=1)] [marker(p,depth=2)] "text"
 * Flat after:  [marker(p,depth=1)] "text"
 *
 * The diff should show: delete marker(bq,depth=1), modify marker(p) depth 2->1 or
 * equivalently delete old marker(bq) + delete old marker(p,depth=2) + insert marker(p,depth=1).
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatLiftSemantics = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('text').done(false)
      ]).done(false)
    ])
    .done(false)

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('text').done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  console.log('\n=== LIFT SEMANTICS ===')
  console.log('before flat:', JSON.stringify(beforeFlat.toJSON(), null, 2))
  console.log('after flat:', JSON.stringify(afterFlat.toJSON(), null, 2))
  console.log('flat diff (lift):', JSON.stringify(flatDiff.toJSON(), null, 2))

  let ops = []
  flatDiff.children.forEach(op => {
    if (delta.$retainOp.check(op)) ops.push({ type: 'retain', len: op.retain })
    else if (delta.$insertOp.check(op)) ops.push({ type: 'insert', count: op.insert.length, names: op.insert.map(i => i?.name) })
    else if (delta.$textOp.check(op)) ops.push({ type: 'text', text: op.insert })
    else if (delta.$deleteOp.check(op)) ops.push({ type: 'delete', len: op.delete })
    else if (delta.$modifyOp.check(op)) ops.push({ type: 'modify', value: op.value?.toJSON() })
  })
  console.log('diff ops:', JSON.stringify(ops))

  // The key insight: the blockquote marker is removed, and the paragraph marker's
  // depth changes from 2 to 1. The exact diff structure depends on the diff algorithm,
  // but we verify the end result is correct.
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)

  // Also verify the text content is preserved
  console.log('Lift: blockquote removed, paragraph lifted from depth 2 to depth 1')
}

// ---------------------------------------------------------------------------
// Y.Type storage round-trip test
// ---------------------------------------------------------------------------

/**
 * Test: flat delta -> Y.Type.applyDelta() -> toDeltaDeep() -> compare
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatDeltaYTypeRoundTrip = tc => {
  // Build a complex tree delta
  const heading = delta.create('heading', $prosemirrorDelta)
  heading.setAttr('level', 1)
  heading.insert('Title')

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      heading.done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('intro').done(false),
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('quoted').done(false)
      ]).done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('end').done(false)
    ])
    .done(false)

  // Flatten
  const flat = treeToFlat(tree)

  // Store in Y.Type
  const ydoc = new Y.Doc()
  const ytype = ydoc.get('test-flat')
  ytype.applyDelta(flat)

  // Read back
  const readBack = ytype.toDeltaDeep()

  console.log('\n=== Y.Type ROUND TRIP ===')
  console.log('flat delta:', JSON.stringify(flat.toJSON(), null, 2))
  console.log('read back:', JSON.stringify(readBack.toJSON(), null, 2))

  // Compare
  t.compare(flat, readBack)

  // Also verify the full round trip: flat -> Y.Type -> flat -> tree -> compare to original tree
  const recoveredTree = flatToTree(readBack)
  t.compare(tree, recoveredTree)

  console.log('Y.Type round trip: flat delta survives Y.Type storage and unflatten recovers original tree')
}
