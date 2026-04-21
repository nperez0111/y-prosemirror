import * as t from 'lib0/testing'
import * as delta from 'lib0/delta'
import * as Y from '@y/y'
import * as basicSchema from 'prosemirror-schema-basic'
import { Schema } from 'prosemirror-model'
import {
  treeToFlat as treeToFlatSchemaAware,
  flatToTree as flatToTreeSchemaAware,
  validateFlatDelta
} from '../src/flatten-schema.js'
import {
  treeToFlat as treeToFlatAgnostic
} from '../src/flatten.js'
import { docToDelta, deltaToPNode, $prosemirrorDelta } from '../src/sync-utils.js'

// ---------------------------------------------------------------------------
// Schema: same extended schema used in flatten.test.js
// ---------------------------------------------------------------------------

const schema = new Schema({
  nodes: /** @type {any} */ (Object.assign({}, basicSchema.nodes, {
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 } },
      parseDOM: [{ tag: 'ol' }],
      toDOM () { return ['ol', 0] }
    },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
      parseDOM: [{ tag: 'ul' }],
      toDOM () { return ['ul', 0] }
    },
    list_item: {
      content: 'paragraph block*',
      parseDOM: [{ tag: 'li' }],
      toDOM () { return ['li', 0] },
      defining: true
    },
    custom: {
      atom: true,
      group: 'block',
      attrs: { checked: { default: false } },
      parseDOM: [{ tag: 'div' }],
      toDOM () { return ['div'] }
    }
  })),
  marks: Object.assign({}, basicSchema.marks, {
    comment: {
      attrs: { id: { default: null } },
      excludes: '',
      parseDOM: [{ tag: 'comment' }],
      toDOM (/** @type {any} */ node) {
        return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['comment', { comment_id: node.attrs.id }])
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Schema-aware round-trip: tree -> flat -> tree, assert equal.
 * @param {import('lib0/testing').TestCase} _tc
 * @param {delta.Delta} treeDelta
 * @param {string} label
 */
const assertRoundTrip = (_tc, treeDelta, label) => {
  const flat = treeToFlatSchemaAware(treeDelta, schema)
  const recovered = flatToTreeSchemaAware(flat, schema)
  t.compare(treeDelta, recovered, `Schema-aware round-trip failed: ${label}`)
}

/**
 * PM Node round-trip: PM doc -> tree delta -> flat (schema-aware) -> tree -> PM doc, assert equal.
 * @param {import('lib0/testing').TestCase} _tc
 * @param {import('prosemirror-model').Node} doc
 * @param {string} label
 */
const assertPMRoundTrip = (_tc, doc, label) => {
  const treeDelta = docToDelta(doc)
  const flat = treeToFlatSchemaAware(treeDelta, schema)
  const recovered = flatToTreeSchemaAware(flat, schema)
  const recoveredDoc = deltaToPNode(recovered, schema, null)
  t.compare(doc.toJSON(), recoveredDoc.toJSON(), `Schema-aware PM round-trip failed: ${label}`)
}

/**
 * Assert that schema-aware flatten produces identical output to schema-agnostic flatten.
 * @param {import('lib0/testing').TestCase} _tc
 * @param {delta.Delta} treeDelta
 * @param {string} label
 */
const assertMatchesAgnostic = (_tc, treeDelta, label) => {
  const flatSchemaAware = treeToFlatSchemaAware(treeDelta, schema)
  const flatAgnostic = treeToFlatAgnostic(treeDelta)
  t.compare(flatSchemaAware, flatAgnostic, `Schema-aware and agnostic flatten should match: ${label}`)
}

/**
 * Y.Type round-trip: tree -> flat (schema-aware) -> Y.Type -> toDeltaDeep -> compare -> unflatten.
 * @param {import('lib0/testing').TestCase} _tc
 * @param {delta.Delta} treeDelta
 * @param {string} label
 */
const assertYTypeRoundTrip = (_tc, treeDelta, label) => {
  const flat = treeToFlatSchemaAware(treeDelta, schema)
  const ydoc = new Y.Doc()
  const ytype = ydoc.get(`test-schema-${label}`)
  ytype.applyDelta(flat)
  const readBack = ytype.toDeltaDeep()
  t.compare(flat, readBack, `Schema-aware Y.Type storage failed: ${label}`)
  const recoveredTree = flatToTreeSchemaAware(readBack, schema)
  t.compare(treeDelta, recoveredTree, `Schema-aware Y.Type full round-trip failed: ${label}`)
}

/**
 * Collect ops from a delta diff into a summary array.
 * @param {delta.Delta} diffDelta
 */
const summarizeDiffOps = (diffDelta) => {
  /** @type {Array<{type: string, [key: string]: any}>} */
  const ops = []
  diffDelta.children.forEach(op => {
    if (delta.$retainOp.check(op)) ops.push({ type: 'retain', len: op.retain })
    else if (delta.$insertOp.check(op)) ops.push({ type: 'insert', count: op.insert.length, names: op.insert.map((/** @type {any} */ i) => i?.name) })
    else if (delta.$textOp.check(op)) ops.push({ type: 'text', text: op.insert })
    else if (delta.$deleteOp.check(op)) ops.push({ type: 'delete', len: op.delete })
    else if (delta.$modifyOp.check(op)) ops.push({ type: 'modify' })
  })
  return ops
}

// =========================================================================
// PART 1: Equivalence with schema-agnostic flatten
// =========================================================================
// These tests prove the schema-aware flatten produces identical flat deltas
// to the schema-agnostic version for full documents.

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareMatchesSingleParagraph = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false)])
    .done(false)
  assertMatchesAgnostic(tc, tree, 'single paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareMatchesMultipleParagraphs = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('world').done(false)
    ])
    .done(false)
  assertMatchesAgnostic(tc, tree, 'multiple paragraphs')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareMatchesInlineNode = tc => {
  const hb = delta.create('hard_break', $prosemirrorDelta).done(false)
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('before')
    .insert([hb])
    .insert('after')
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertMatchesAgnostic(tc, tree, 'inline node (hard_break)')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareMatchesBlockquote = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('quoted').done(false)
      ]).done(false)
    ])
    .done(false)
  assertMatchesAgnostic(tc, tree, 'blockquote')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareMatchesList = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('one').done(false)
        ]).done(false),
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('two').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)
  assertMatchesAgnostic(tc, tree, 'bullet list')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareMatchesImage = tc => {
  const img = delta.create('image', $prosemirrorDelta)
  img.setAttr('src', 'photo.png')
  img.setAttr('alt', 'A photo')
  img.setAttr('title', null)
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('before ')
    .insert([img.done(false)])
    .insert(' after')
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertMatchesAgnostic(tc, tree, 'image inline')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareMatchesKitchenSink = tc => {
  const heading = delta.create('heading', $prosemirrorDelta)
  heading.setAttr('level', 2)
  heading.insert('Chapter ')
  heading.insert('One', { em: {} })

  const img = delta.create('image', $prosemirrorDelta)
  img.setAttr('src', 'fig1.png')
  img.setAttr('alt', 'Figure 1')
  img.setAttr('title', null)

  const hb = delta.create('hard_break', $prosemirrorDelta).done(false)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      heading.done(false),
      delta.create('paragraph', $prosemirrorDelta)
        .insert('Regular ')
        .insert('bold', { strong: {} })
        .insert(' and ')
        .insert('linked', { link: { href: 'https://example.com', title: 'Example' } })
        .insert(' text.')
        .done(false),
      delta.create('horizontal_rule', $prosemirrorDelta).done(false),
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('Quoted intro').done(false),
        delta.create('bullet_list', $prosemirrorDelta).insert([
          delta.create('list_item', $prosemirrorDelta).insert([
            delta.create('paragraph', $prosemirrorDelta).insert('point one').done(false)
          ]).done(false),
          delta.create('list_item', $prosemirrorDelta).insert([
            delta.create('paragraph', $prosemirrorDelta).insert('point two').done(false),
            delta.create('bullet_list', $prosemirrorDelta).insert([
              delta.create('list_item', $prosemirrorDelta).insert([
                delta.create('paragraph', $prosemirrorDelta).insert('sub-point').done(false)
              ]).done(false)
            ]).done(false)
          ]).done(false)
        ]).done(false)
      ]).done(false),
      delta.create('paragraph', $prosemirrorDelta)
        .insert('see ')
        .insert([img.done(false)])
        .insert(' above')
        .insert([hb])
        .insert('and below')
        .done(false),
      delta.create('code_block', $prosemirrorDelta).insert('let x = 1;\nlet y = 2;').done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('The end.').done(false)
    ])
    .done(false)
  assertMatchesAgnostic(tc, tree, 'kitchen sink')
}

// =========================================================================
// PART 2: Schema-aware delta round-trip tests
// =========================================================================

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripSingleParagraph = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false)])
    .done(false)
  assertRoundTrip(tc, tree, 'single paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripFormattedText = tc => {
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('bold', { strong: {} })
    .insert(' normal')
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertRoundTrip(tc, tree, 'formatted text')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripNestedBlockquote = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('blockquote', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('deep').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'nested blockquote')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripNestedList = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('parent').done(false),
          delta.create('bullet_list', $prosemirrorDelta).insert([
            delta.create('list_item', $prosemirrorDelta).insert([
              delta.create('paragraph', $prosemirrorDelta).insert('child').done(false)
            ]).done(false)
          ]).done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'nested list')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripAtomBlocks = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    // @ts-ignore -- TS2589: excessive type depth from 4-element array of Deltas
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('before').done(false),
      delta.create('horizontal_rule', $prosemirrorDelta).done(false),
      delta.create('custom', $prosemirrorDelta).setAttr('checked', true).done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('after').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'atom blocks: horizontal_rule + custom')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripEmptyParagraph = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([delta.create('paragraph', $prosemirrorDelta).done(false)])
    .done(false)
  assertRoundTrip(tc, tree, 'empty paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripMixedInline = tc => {
  const hb = delta.create('hard_break', $prosemirrorDelta).done(false)
  const img = delta.create('image', $prosemirrorDelta)
  img.setAttr('src', 'test.png')
  img.setAttr('alt', 'test')
  img.setAttr('title', null)

  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('bold', { strong: {} })
    .insert([hb])
    .insert('see ')
    .insert([img.done(false)])
    .insert(' done', { em: {} })
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertRoundTrip(tc, tree, 'mixed inline: bold + hard_break + image + italic')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripCodeBlock = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('code_block', $prosemirrorDelta).insert('function foo() {\n  return 42;\n}').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'code block')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaRoundTripBlockFormatting = tc => {
  const attrFormat = { 'y-attributed-insert': { user: 'alice', time: 1234 } }
  const bq = delta.create('blockquote', $prosemirrorDelta).insert([
    delta.create('paragraph', $prosemirrorDelta).insert('quoted').done(false)
  ]).done(false)
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([bq], attrFormat)
    .done(false)
  assertRoundTrip(tc, tree, 'block formatting preservation')
}

// =========================================================================
// PART 3: PM Node round-trip tests (schema-aware)
// =========================================================================

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwarePMSingleParagraph = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('hello world')])
  ])
  assertPMRoundTrip(tc, doc, 'single paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwarePMFormatted = tc => {
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
export const testSchemaAwarePMHardBreak = tc => {
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
export const testSchemaAwarePMImage = tc => {
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
export const testSchemaAwarePMBulletList = tc => {
  const doc = schema.node('doc', null, [
    schema.node('bullet_list', null, [
      schema.node('list_item', null, [
        schema.node('paragraph', null, [schema.text('item one')])
      ]),
      schema.node('list_item', null, [
        schema.node('paragraph', null, [schema.text('item two')])
      ])
    ])
  ])
  assertPMRoundTrip(tc, doc, 'bullet list')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwarePMNestedList = tc => {
  const doc = schema.node('doc', null, [
    schema.node('bullet_list', null, [
      schema.node('list_item', null, [
        schema.node('paragraph', null, [schema.text('parent')]),
        schema.node('bullet_list', null, [
          schema.node('list_item', null, [
            schema.node('paragraph', null, [schema.text('child one')])
          ]),
          schema.node('list_item', null, [
            schema.node('paragraph', null, [schema.text('child two')])
          ])
        ])
      ]),
      schema.node('list_item', null, [
        schema.node('paragraph', null, [schema.text('sibling')])
      ])
    ])
  ])
  assertPMRoundTrip(tc, doc, 'nested list')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwarePMHorizontalRule = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('before')]),
    schema.node('horizontal_rule'),
    schema.node('paragraph', null, [schema.text('after')])
  ])
  assertPMRoundTrip(tc, doc, 'horizontal rule')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwarePMCustomAtomBlock = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('before')]),
    schema.node('custom', { checked: true }),
    schema.node('paragraph', null, [schema.text('after')])
  ])
  assertPMRoundTrip(tc, doc, 'custom atom block')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwarePMDeeplyNested = tc => {
  const doc = schema.node('doc', null, [
    schema.node('blockquote', null, [
      schema.node('blockquote', null, [
        schema.node('bullet_list', null, [
          schema.node('list_item', null, [
            schema.node('paragraph', null, [schema.text('very deep')])
          ])
        ])
      ])
    ])
  ])
  assertPMRoundTrip(tc, doc, 'deeply nested: bq > bq > list > li > p')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwarePMKitchenSink = tc => {
  const doc = schema.node('doc', null, [
    schema.node('heading', { level: 2 }, [
      schema.text('Chapter '),
      schema.text('One', [schema.mark('em')])
    ]),
    schema.node('paragraph', null, [
      schema.text('Normal '),
      schema.text('bold', [schema.mark('strong')]),
      schema.text(' and '),
      schema.text('linked', [schema.mark('link', { href: 'https://example.com', title: null })]),
      schema.text(' text.')
    ]),
    schema.node('horizontal_rule'),
    schema.node('blockquote', null, [
      schema.node('paragraph', null, [schema.text('Quoted intro')]),
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('point one')])
        ]),
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('point two')]),
          schema.node('bullet_list', null, [
            schema.node('list_item', null, [
              schema.node('paragraph', null, [schema.text('sub-point')])
            ])
          ])
        ])
      ])
    ]),
    schema.node('paragraph', null, [
      schema.text('see '),
      schema.node('image', { src: 'fig1.png', alt: 'Figure 1', title: null }),
      schema.text(' above'),
      schema.node('hard_break'),
      schema.text('and below')
    ]),
    schema.node('code_block', null, [schema.text('let x = 1;\nlet y = 2;')]),
    schema.node('paragraph', null, [schema.text('The end.')])
  ])
  assertPMRoundTrip(tc, doc, 'kitchen sink')
}

// =========================================================================
// PART 4: Semantic operation tests (split, merge, lift, wrap)
// =========================================================================

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareSplitSemantics = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('helloworld').done(false)
    ])
    .done(false)

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('world').done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlatSchemaAware(beforeTree, schema)
  const afterFlat = treeToFlatSchemaAware(afterTree, schema)
  const flatDiff = delta.diff(beforeFlat, afterFlat)
  const ops = summarizeDiffOps(flatDiff)

  const insertOps = ops.filter(o => o.type === 'insert')
  t.assert(insertOps.length === 1, 'Split should produce exactly one insert op')
  t.assert(insertOps[0].names[0] === 'paragraph', 'Inserted marker should be a paragraph')

  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTreeSchemaAware(applied, schema)
  t.compare(afterTree, recoveredTree)
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareMergeSemantics = tc => {
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

  const beforeFlat = treeToFlatSchemaAware(beforeTree, schema)
  const afterFlat = treeToFlatSchemaAware(afterTree, schema)
  const flatDiff = delta.diff(beforeFlat, afterFlat)
  const ops = summarizeDiffOps(flatDiff)

  const deleteOps = ops.filter(o => o.type === 'delete')
  t.assert(deleteOps.length === 1, 'Merge should produce exactly one delete op')
  t.assert(deleteOps[0].len === 1, 'Merge should delete exactly 1 item (the marker)')

  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTreeSchemaAware(applied, schema)
  t.compare(afterTree, recoveredTree)
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareSplitInsideListItem = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('helloworld').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false)
        ]).done(false),
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('world').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlatSchemaAware(beforeTree, schema)
  const afterFlat = treeToFlatSchemaAware(afterTree, schema)
  const flatDiff = delta.diff(beforeFlat, afterFlat)
  const ops = summarizeDiffOps(flatDiff)

  const insertOps = ops.filter(o => o.type === 'insert')
  const totalInserted = insertOps.reduce((sum, o) => sum + o.count, 0)
  t.assert(totalInserted === 2, `Split in list should insert 2 markers (list_item + paragraph), got ${totalInserted}`)

  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTreeSchemaAware(applied, schema)
  t.compare(afterTree, recoveredTree)
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareLiftSemantics = tc => {
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

  const beforeFlat = treeToFlatSchemaAware(beforeTree, schema)
  const afterFlat = treeToFlatSchemaAware(afterTree, schema)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTreeSchemaAware(applied, schema)
  t.compare(afterTree, recoveredTree)
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareWrapInBlockquote = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('text').done(false)
    ])
    .done(false)

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('text').done(false)
      ]).done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlatSchemaAware(beforeTree, schema)
  const afterFlat = treeToFlatSchemaAware(afterTree, schema)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTreeSchemaAware(applied, schema)
  t.compare(afterTree, recoveredTree)
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareChangeBlockType = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false)
    ])
    .done(false)

  const h1 = delta.create('heading', $prosemirrorDelta)
  h1.setAttr('level', 1)
  h1.insert('hello')
  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([h1.done(false)])
    .done(false)

  const beforeFlat = treeToFlatSchemaAware(beforeTree, schema)
  const afterFlat = treeToFlatSchemaAware(afterTree, schema)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTreeSchemaAware(applied, schema)
  t.compare(afterTree, recoveredTree)
}

// =========================================================================
// PART 5: Y.Type storage round-trip tests (schema-aware)
// =========================================================================

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareYTypeBasic = tc => {
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
  assertYTypeRoundTrip(tc, tree, 'basic')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareYTypeLists = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('item one').done(false)
        ]).done(false),
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('item two').done(false),
          delta.create('bullet_list', $prosemirrorDelta).insert([
            delta.create('list_item', $prosemirrorDelta).insert([
              delta.create('paragraph', $prosemirrorDelta).insert('nested').done(false)
            ]).done(false)
          ]).done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)
  assertYTypeRoundTrip(tc, tree, 'lists')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareYTypeKitchenSink = tc => {
  const heading = delta.create('heading', $prosemirrorDelta)
  heading.setAttr('level', 2)
  heading.insert('Title')

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      heading.done(false),
      delta.create('paragraph', $prosemirrorDelta)
        .insert('Normal ')
        .insert('bold', { strong: {} })
        .insert(' text')
        .done(false),
      delta.create('horizontal_rule', $prosemirrorDelta).done(false),
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('quote').done(false),
        delta.create('bullet_list', $prosemirrorDelta).insert([
          delta.create('list_item', $prosemirrorDelta).insert([
            delta.create('paragraph', $prosemirrorDelta).insert('item').done(false)
          ]).done(false)
        ]).done(false)
      ]).done(false),
      delta.create('code_block', $prosemirrorDelta).insert('code();').done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('end').done(false)
    ])
    .done(false)
  assertYTypeRoundTrip(tc, tree, 'kitchen-sink')
}

// =========================================================================
// PART 6: Real-world document round-trip (doc.json, schema-aware)
// =========================================================================

const docJsonSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      attrs: { _hash: { default: null }, textAlign: { default: null } },
      parseDOM: [{ tag: 'p' }],
      toDOM () { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['p', 0]) }
    },
    heading: {
      content: 'inline*',
      group: 'block',
      attrs: { _hash: { default: null }, textAlign: { default: null }, level: { default: 1 } },
      defining: true,
      parseDOM: [
        { tag: 'h1', attrs: { level: 1 } },
        { tag: 'h2', attrs: { level: 2 } },
        { tag: 'h3', attrs: { level: 3 } },
        { tag: 'h4', attrs: { level: 4 } }
      ],
      toDOM (/** @type {any} */ node) { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['h' + node.attrs.level, 0]) }
    },
    bulletList: {
      content: 'listItem+',
      group: 'block',
      attrs: { _hash: { default: null } },
      parseDOM: [{ tag: 'ul' }],
      toDOM () { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['ul', 0]) }
    },
    orderedList: {
      content: 'listItem+',
      group: 'block',
      attrs: { _hash: { default: null }, start: { default: 1 }, type: { default: null } },
      parseDOM: [{ tag: 'ol' }],
      toDOM () { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['ol', 0]) }
    },
    listItem: {
      content: 'paragraph block*',
      attrs: { _hash: { default: null } },
      parseDOM: [{ tag: 'li' }],
      toDOM () { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['li', 0]) },
      defining: true
    },
    hardBreak: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM () { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['br']) }
    },
    horizontalRule: {
      group: 'block',
      attrs: { _hash: { default: null } },
      parseDOM: [{ tag: 'hr' }],
      toDOM () { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['hr']) }
    },
    text: { group: 'inline' }
  },
  marks: {
    bold: {
      attrs: { _hash: { default: null } },
      parseDOM: [{ tag: 'strong' }],
      toDOM () { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['strong', 0]) }
    },
    italic: {
      attrs: { _hash: { default: null } },
      parseDOM: [{ tag: 'em' }],
      toDOM () { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['em', 0]) }
    },
    link: {
      attrs: {
        _hash: { default: null },
        href: { default: null },
        target: { default: null },
        rel: { default: null },
        class: { default: null },
        title: { default: null }
      },
      inclusive: false,
      parseDOM: [{ tag: 'a[href]' }],
      toDOM (/** @type {any} */ node) { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['a', { href: node.attrs.href }, 0]) }
    },
    inlineThread: {
      attrs: {
        _hash: { default: null },
        'data-thread-id': { default: null }
      },
      excludes: '',
      parseDOM: [{ tag: 'span[data-thread-id]' }],
      toDOM (/** @type {any} */ node) { return /** @type {import('prosemirror-model').DOMOutputSpec} */ (['span', { 'data-thread-id': node.attrs['data-thread-id'] }, 0]) }
    }
  }
})

/**
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testSchemaAwareRealWorldDocJsonRoundTrip = async _tc => {
  // @ts-ignore -- Node.js built-ins, not typed in this tsconfig
  const fs = await import('fs')
  // @ts-ignore
  const path = await import('path')
  const docPath = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '..', 'doc.json')
  const docJson = JSON.parse(fs.readFileSync(docPath, 'utf-8'))

  const pmDoc = docJsonSchema.nodeFromJSON(docJson)

  // PM -> tree delta -> flat (schema-aware) -> tree -> PM
  const treeDelta = docToDelta(pmDoc)
  const flat = treeToFlatSchemaAware(treeDelta, docJsonSchema)

  const validation = validateFlatDelta(flat)
  t.assert(validation.valid, `doc.json schema-aware validation failed: ${validation.errors.join('; ')}`)

  const recoveredTree = flatToTreeSchemaAware(flat, docJsonSchema)
  const recoveredDoc = deltaToPNode(recoveredTree, docJsonSchema, null)
  t.compare(pmDoc.toJSON(), recoveredDoc.toJSON(), 'doc.json schema-aware PM round-trip failed')
}

/**
 * Verify that the schema-aware flatten of doc.json produces identical output
 * to the schema-agnostic version.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testSchemaAwareDocJsonMatchesAgnostic = async _tc => {
  // @ts-ignore -- Node.js built-ins, not typed in this tsconfig
  const fs = await import('fs')
  // @ts-ignore
  const path = await import('path')
  const docPath = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '..', 'doc.json')
  const docJson = JSON.parse(fs.readFileSync(docPath, 'utf-8'))

  const pmDoc = docJsonSchema.nodeFromJSON(docJson)
  const treeDelta = docToDelta(pmDoc)

  const flatSchemaAware = treeToFlatSchemaAware(treeDelta, docJsonSchema)
  const flatAgnostic = treeToFlatAgnostic(treeDelta)
  t.compare(flatSchemaAware, flatAgnostic, 'doc.json: schema-aware and agnostic flatten should match')
}

/**
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testSchemaAwareRealWorldDocJsonYTypeRoundTrip = async _tc => {
  // @ts-ignore -- Node.js built-ins, not typed in this tsconfig
  const fs = await import('fs')
  // @ts-ignore
  const path = await import('path')
  const docPath = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '..', 'doc.json')
  const docJson = JSON.parse(fs.readFileSync(docPath, 'utf-8'))

  const pmDoc = docJsonSchema.nodeFromJSON(docJson)
  const treeDelta = docToDelta(pmDoc)
  const flat = treeToFlatSchemaAware(treeDelta, docJsonSchema)

  const ydoc = new Y.Doc()
  const ytype = ydoc.get('schema-doc-json-test')
  ytype.applyDelta(flat)
  const readBack = ytype.toDeltaDeep()

  t.compare(flat, readBack, 'doc.json schema-aware Y.Type storage failed')

  const recoveredTree = flatToTreeSchemaAware(readBack, docJsonSchema)
  const recoveredDoc = deltaToPNode(recoveredTree, docJsonSchema, null)
  t.compare(pmDoc.toJSON(), recoveredDoc.toJSON(), 'doc.json schema-aware Y.Type full round-trip failed')
}

// =========================================================================
// PART 7: Schema-aware advantage tests
// =========================================================================
// These tests demonstrate cases where schema awareness provides advantages
// over the heuristic-based approach.

/**
 * Test: schema-aware correctly classifies an empty paragraph (no children at all)
 * as a block node. The heuristic approach also handles this, but the schema approach
 * is more direct — it doesn't need to scan siblings.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareEmptyParagraphClassification = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, []),
    schema.node('paragraph', null, [schema.text('after')])
  ])
  assertPMRoundTrip(tc, doc, 'empty paragraph followed by non-empty')
}

/**
 * Test: atom block nodes (horizontal_rule, custom) are correctly classified
 * as block nodes by the schema, even though they have zero children and zero text.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareAtomBlockClassification = tc => {
  const doc = schema.node('doc', null, [
    schema.node('horizontal_rule'),
    schema.node('custom', { checked: false }),
    schema.node('horizontal_rule'),
    schema.node('paragraph', null, [schema.text('end')])
  ])
  assertPMRoundTrip(tc, doc, 'consecutive atom blocks')
}

/**
 * Test: inline atom nodes (image, hard_break) are correctly classified
 * as inline by the schema even when they are the ONLY children of a paragraph
 * (no text siblings to trigger the heuristic).
 *
 * This is a case where the schema-agnostic heuristic would fail if we only
 * looked at whether text siblings exist, because a paragraph containing only
 * an image has no TextOps. The agnostic version handles this by checking
 * the parent-level heuristic (paragraph has inline content spec), but the
 * schema-aware version is more direct.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareInlineOnlyChildren = tc => {
  // Paragraph with only a hard_break — no text at all
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.node('hard_break')
    ])
  ])
  assertPMRoundTrip(tc, doc, 'paragraph with only hard_break')
}

/**
 * Test: paragraph with only an image inline node.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testSchemaAwareImageOnlyParagraph = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.node('image', { src: 'test.png', alt: 'test', title: null })
    ])
  ])
  assertPMRoundTrip(tc, doc, 'paragraph with only image')
}
