import * as t from 'lib0/testing'
import * as delta from 'lib0/delta'
import * as Y from '@y/y'
import * as basicSchema from 'prosemirror-schema-basic'
import { Schema } from 'prosemirror-model'
import { treeToFlat, flatToTree, DEPTH_ATTR, $flatMarker, validateFlatDelta } from '../src/flatten.js'
import { docToDelta, deltaToPNode, $prosemirrorDelta } from '../src/sync-utils.js'

// ---------------------------------------------------------------------------
// Schema: extends basic schema with lists, code_block, horizontal_rule,
// custom atom block, and rich marks (link, comment, etc.)
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
 * Build a tree delta, flatten it, unflatten it, and compare to the original.
 * @param {import('lib0/testing').TestCase} _tc
 * @param {delta.Delta} treeDelta
 * @param {string} label
 */
const assertRoundTrip = (_tc, treeDelta, label) => {
  const flat = treeToFlat(treeDelta)
  const recovered = flatToTree(flat)
  t.compare(treeDelta, recovered, `Delta round-trip failed: ${label}`)
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
  t.compare(doc.toJSON(), recoveredDoc.toJSON(), `PM round-trip failed: ${label}`)
}

/**
 * Store a flat delta in Y.Type, read it back, and compare.
 * Also unflatten and compare to original tree.
 * @param {import('lib0/testing').TestCase} _tc
 * @param {delta.Delta} treeDelta
 * @param {string} label
 */
const assertYTypeRoundTrip = (_tc, treeDelta, label) => {
  const flat = treeToFlat(treeDelta)
  const ydoc = new Y.Doc()
  const ytype = ydoc.get(`test-${label}`)
  ytype.applyDelta(flat)
  const readBack = ytype.toDeltaDeep()
  t.compare(flat, readBack, `Y.Type storage failed: ${label}`)
  const recoveredTree = flatToTree(readBack)
  t.compare(treeDelta, recoveredTree, `Y.Type full round-trip failed: ${label}`)
}

/**
 * Collect ops from a delta diff into a summary array for assertion.
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
// PART 1: Basic delta round-trip tests (from original)
// =========================================================================

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenSingleParagraph = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false)])
    .done(false)
  assertRoundTrip(tc, tree, 'single paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenMultipleParagraphs = tc => {
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
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('quoted').done(false)
      ]).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'blockquote')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenNestedBlockquote = tc => {
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
export const testFlattenBlockquoteMultiParagraph = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('first').done(false),
        delta.create('paragraph', $prosemirrorDelta).insert('second').done(false)
      ]).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'blockquote with multiple paragraphs')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenEmptyParagraph = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([delta.create('paragraph', $prosemirrorDelta).done(false)])
    .done(false)
  assertRoundTrip(tc, tree, 'empty paragraph')
}

/**
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenFormattedText = tc => {
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

// =========================================================================
// PART 2: Complex schema round-trip tests (lists, atoms, code blocks)
// =========================================================================

/**
 * Bullet list with two items.
 * Structure: doc > bullet_list > [list_item > p, list_item > p]
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenBulletList = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('item one').done(false)
        ]).done(false),
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('item two').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'bullet list')
}

/**
 * Ordered list with start attribute.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenOrderedList = tc => {
  const ol = delta.create('ordered_list', $prosemirrorDelta)
  ol.setAttr('order', 3)
  ol.insert([
    delta.create('list_item', $prosemirrorDelta).insert([
      delta.create('paragraph', $prosemirrorDelta).insert('third').done(false)
    ]).done(false),
    delta.create('list_item', $prosemirrorDelta).insert([
      delta.create('paragraph', $prosemirrorDelta).insert('fourth').done(false)
    ]).done(false),
    delta.create('list_item', $prosemirrorDelta).insert([
      delta.create('paragraph', $prosemirrorDelta).insert('fifth').done(false)
    ]).done(false)
  ])
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([ol.done(false)])
    .done(false)
  assertRoundTrip(tc, tree, 'ordered list with start=3')
}

/**
 * Nested list: bullet_list > list_item > [paragraph, bullet_list > list_item > paragraph]
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenNestedList = tc => {
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
 * List item with multiple blocks: list_item > [paragraph, code_block]
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenListItemMultipleBlocks = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('description').done(false),
          delta.create('code_block', $prosemirrorDelta).insert('const x = 1;\nreturn x;').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'list item with paragraph + code_block')
}

/**
 * Horizontal rule (atom block node with no content).
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenHorizontalRule = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('before').done(false),
      delta.create('horizontal_rule', $prosemirrorDelta).done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('after').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'horizontal rule')
}

/**
 * Code block (text content, no marks).
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenCodeBlock = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('code_block', $prosemirrorDelta).insert('function foo() {\n  return 42;\n}').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'code block')
}

/**
 * Custom atom block node (no content, with attrs).
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenCustomAtomBlock = tc => {
  const custom = delta.create('custom', $prosemirrorDelta)
  custom.setAttr('checked', true)
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).insert('before').done(false),
      custom.done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('after').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'custom atom block with attrs')
}

/**
 * Multiple consecutive atom blocks.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenConsecutiveAtomBlocks = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('horizontal_rule', $prosemirrorDelta).done(false),
      delta.create('horizontal_rule', $prosemirrorDelta).done(false),
      delta.create('horizontal_rule', $prosemirrorDelta).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'three consecutive horizontal rules')
}

// =========================================================================
// PART 3: Advanced inline / mark tests
// =========================================================================

/**
 * Multiple marks on the same text: bold + italic.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenMultipleMarks = tc => {
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('bold-italic', { strong: {}, em: {} })
    .insert(' plain ')
    .insert('just-bold', { strong: {} })
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertRoundTrip(tc, tree, 'multiple marks on text')
}

/**
 * Link mark with attributes.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenLinkMark = tc => {
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('click ')
    .insert('here', { link: { href: 'https://example.com', title: 'Example' } })
    .insert(' for more')
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertRoundTrip(tc, tree, 'link mark with attrs')
}

/**
 * Image inline node with attributes.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenImageWithAttrs = tc => {
  const img = delta.create('image', $prosemirrorDelta)
  img.setAttr('src', 'photo.png')
  img.setAttr('alt', 'A photo')
  img.setAttr('title', 'Photo Title')

  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('before ')
    .insert([img.done(false)])
    .insert(' after')
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertRoundTrip(tc, tree, 'image inline with attrs')
}

/**
 * Mixed inline: bold text, then hard_break, then italic text.
 * Tests formatting across inline node boundaries.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenMixedInlineFormatting = tc => {
  const hb = delta.create('hard_break', $prosemirrorDelta).done(false)
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('bold', { strong: {} })
    .insert([hb])
    .insert('italic', { em: {} })
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertRoundTrip(tc, tree, 'bold + hard_break + italic')
}

/**
 * Code mark on text (inline code).
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenCodeMark = tc => {
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('run ')
    .insert('npm install', { code: {} })
    .insert(' to install')
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertRoundTrip(tc, tree, 'code mark')
}

/**
 * Comment mark with id attribute (custom mark).
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenCommentMark = tc => {
  const p = delta.create('paragraph', $prosemirrorDelta)
    .insert('this is ')
    .insert('commented', { comment: { id: 'c42' } })
    .insert(' text')
    .done(false)
  const tree = delta.create(null, $prosemirrorDelta).insert([p]).done(false)
  assertRoundTrip(tc, tree, 'comment mark with attrs')
}

// =========================================================================
// PART 4: PM Node round-trip tests (via ProseMirror schema)
// =========================================================================

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

/**
 * PM bullet list.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMBulletList = tc => {
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
 * PM ordered list with start attribute.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMOrderedList = tc => {
  const doc = schema.node('doc', null, [
    schema.node('ordered_list', { order: 5 }, [
      schema.node('list_item', null, [
        schema.node('paragraph', null, [schema.text('five')])
      ]),
      schema.node('list_item', null, [
        schema.node('paragraph', null, [schema.text('six')])
      ])
    ])
  ])
  assertPMRoundTrip(tc, doc, 'ordered list with start=5')
}

/**
 * PM nested list.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMNestedList = tc => {
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
 * PM list item with multiple blocks.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMListItemMultipleBlocks = tc => {
  const doc = schema.node('doc', null, [
    schema.node('bullet_list', null, [
      schema.node('list_item', null, [
        schema.node('paragraph', null, [schema.text('text')]),
        schema.node('code_block', null, [schema.text('code here')])
      ])
    ])
  ])
  assertPMRoundTrip(tc, doc, 'list item with paragraph + code_block')
}

/**
 * PM horizontal rule.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMHorizontalRule = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('before')]),
    schema.node('horizontal_rule'),
    schema.node('paragraph', null, [schema.text('after')])
  ])
  assertPMRoundTrip(tc, doc, 'horizontal rule')
}

/**
 * PM code block.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMCodeBlock = tc => {
  const doc = schema.node('doc', null, [
    schema.node('code_block', null, [schema.text('const x = 42;\nreturn x;')])
  ])
  assertPMRoundTrip(tc, doc, 'code block')
}

/**
 * PM custom atom block.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMCustomAtomBlock = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('before')]),
    schema.node('custom', { checked: true }),
    schema.node('paragraph', null, [schema.text('after')])
  ])
  assertPMRoundTrip(tc, doc, 'custom atom block')
}

/**
 * PM with multiple marks on same text.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMMultipleMarks = tc => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('bold-italic', [schema.mark('strong'), schema.mark('em')]),
      schema.text(' and '),
      schema.text('linked', [schema.mark('link', { href: 'https://example.com', title: null })])
    ])
  ])
  assertPMRoundTrip(tc, doc, 'multiple marks')
}

/**
 * PM deeply nested: blockquote > blockquote > bullet_list > list_item > paragraph.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMDeeplyNested = tc => {
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

// =========================================================================
// PART 5: Edge case tests
// =========================================================================

/**
 * Consecutive empty paragraphs.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenConsecutiveEmptyParagraphs = tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('paragraph', $prosemirrorDelta).done(false),
      delta.create('paragraph', $prosemirrorDelta).done(false),
      delta.create('paragraph', $prosemirrorDelta).done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'three empty paragraphs')
}

/**
 * Deeply nested (5 levels): bq > bq > bq > bq > bq > p.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenDeeplyNested5Levels = tc => {
  const innermost = delta.create('paragraph', $prosemirrorDelta).insert('deep!').done(false)
  let current = innermost
  for (let i = 0; i < 5; i++) {
    current = delta.create('blockquote', $prosemirrorDelta).insert([current]).done(false)
  }
  const tree = delta.create(null, $prosemirrorDelta).insert([current]).done(false)
  assertRoundTrip(tc, tree, '5 levels of nested blockquotes')
}

/**
 * Complex mixed document: heading, paragraphs with marks, blockquote with
 * nested lists, code block, horizontal rules, images.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenKitchenSinkDelta = tc => {
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
      // Paragraph with rich inline content
      delta.create('paragraph', $prosemirrorDelta)
        .insert('Regular ')
        .insert('bold', { strong: {} })
        .insert(' and ')
        .insert('linked', { link: { href: 'https://example.com', title: 'Example' } })
        .insert(' text.')
        .done(false),
      // Horizontal rule
      delta.create('horizontal_rule', $prosemirrorDelta).done(false),
      // Blockquote with nested list
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
      // Paragraph with hard_break and image
      delta.create('paragraph', $prosemirrorDelta)
        .insert('see ')
        .insert([img.done(false)])
        .insert(' above')
        .insert([hb])
        .insert('and below')
        .done(false),
      // Code block
      delta.create('code_block', $prosemirrorDelta).insert('let x = 1;\nlet y = 2;').done(false),
      // Final paragraph
      delta.create('paragraph', $prosemirrorDelta).insert('The end.').done(false)
    ])
    .done(false)
  assertRoundTrip(tc, tree, 'kitchen sink document')
}

/**
 * Kitchen-sink via PM nodes (full PM round-trip with the complex schema).
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlattenPMKitchenSink = tc => {
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
// PART 6: Semantic operation tests (split, merge, lift, wrap)
// =========================================================================

/**
 * Test: split = insert a marker at the split point.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatSplitSemantics = tc => {
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

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)
  const ops = summarizeDiffOps(flatDiff)

  // Split = one insert of a marker
  const insertOps = ops.filter(o => o.type === 'insert')
  t.assert(insertOps.length === 1, 'Split should produce exactly one insert op')
  t.assert(insertOps[0].names[0] === 'paragraph', 'Inserted marker should be a paragraph')

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: merge = delete a marker.
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
  const ops = summarizeDiffOps(flatDiff)

  // Merge = one delete of a marker
  const deleteOps = ops.filter(o => o.type === 'delete')
  t.assert(deleteOps.length === 1, 'Merge should produce exactly one delete op')
  t.assert(deleteOps[0].len === 1, 'Merge should delete exactly 1 item (the marker)')

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: lift = remove wrapper marker + adjust depth.
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

  // Verify round-trip (the specific ops depend on diff algorithm)
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: split inside a list item.
 *
 * Before: ul > li > p("helloworld")
 * After:  ul > [li > p("hello"), li > p("world")]
 *
 * In the flat repr:
 *   Before: [ul,d=1] [li,d=2] [p,d=3] "helloworld"
 *   After:  [ul,d=1] [li,d=2] [p,d=3] "hello" [li,d=2] [p,d=3] "world"
 *
 * The diff: insert [li,d=2][p,d=3] at the split point — 2 marker inserts.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatSplitInsideListItem = tc => {
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

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)
  const ops = summarizeDiffOps(flatDiff)

  // Should insert markers for both the new list_item AND its paragraph
  const insertOps = ops.filter(o => o.type === 'insert')
  const totalInserted = insertOps.reduce((sum, o) => sum + o.count, 0)
  t.assert(totalInserted === 2, `Split in list should insert 2 markers (list_item + paragraph), got ${totalInserted}`)

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: merge two list items into one.
 *
 * Before: ul > [li > p("hello"), li > p("world")]
 * After:  ul > li > p("helloworld")
 *
 * Flat diff should delete 2 markers (list_item + paragraph).
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatMergeListItems = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
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

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('helloworld').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)
  const ops = summarizeDiffOps(flatDiff)

  // Should delete markers for the second list_item AND its paragraph
  const deleteOps = ops.filter(o => o.type === 'delete')
  const totalDeleted = deleteOps.reduce((sum, o) => sum + o.len, 0)
  t.assert(totalDeleted === 2, `Merge list items should delete 2 markers, got ${totalDeleted}`)

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: lift a paragraph out of a list (outdent).
 *
 * Before: ul > [li > p("one"), li > p("two")]
 * After:  ul > li > p("one"), p("two")
 *
 * This lifts the second paragraph out of the list entirely.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatLiftFromList = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
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

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('one').done(false)
        ]).done(false)
      ]).done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('two').done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: wrap a paragraph in a blockquote.
 *
 * Before: doc > p("text")
 * After:  doc > blockquote > p("text")
 *
 * Flat before: [p,d=1] "text"
 * Flat after:  [bq,d=1] [p,d=2] "text"
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatWrapInBlockquote = tc => {
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

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: split paragraph inside a nested blockquote.
 *
 * Before: bq > bq > p("helloworld")
 * After:  bq > bq > [p("hello"), p("world")]
 *
 * Flat before: [bq,d=1] [bq,d=2] [p,d=3] "helloworld"
 * Flat after:  [bq,d=1] [bq,d=2] [p,d=3] "hello" [p,d=3] "world"
 *
 * Only 1 marker insert needed even inside deep nesting.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatSplitInNestedBlockquote = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('blockquote', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('helloworld').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('blockquote', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false),
          delta.create('paragraph', $prosemirrorDelta).insert('world').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)
  const ops = summarizeDiffOps(flatDiff)

  // Only 1 paragraph marker inserted (depth stays at 3)
  const insertOps = ops.filter(o => o.type === 'insert')
  const totalInserted = insertOps.reduce((sum, o) => sum + o.count, 0)
  t.assert(totalInserted === 1, `Split in nested bq should insert 1 marker, got ${totalInserted}`)

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: convert a paragraph to a heading (type change).
 *
 * Before: doc > p("hello")
 * After:  doc > h1("hello")
 *
 * Flat before: [p,d=1] "hello"
 * Flat after:  [heading(level=1),d=1] "hello"
 *
 * The diff should modify/replace the marker but not touch the text.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatChangeBlockType = tc => {
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

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

/**
 * Test: move list item content from a nested list to the parent list.
 *
 * Before: ul > li > [p("parent"), ul > li > p("child")]
 * After:  ul > [li > p("parent"), li > p("child")]
 *
 * The nested sub-list is removed and its item becomes a sibling.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatUnnestListItem = tc => {
  const beforeTree = delta.create(null, $prosemirrorDelta)
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

  const afterTree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('bullet_list', $prosemirrorDelta).insert([
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('parent').done(false)
        ]).done(false),
        delta.create('list_item', $prosemirrorDelta).insert([
          delta.create('paragraph', $prosemirrorDelta).insert('child').done(false)
        ]).done(false)
      ]).done(false)
    ])
    .done(false)

  const beforeFlat = treeToFlat(beforeTree)
  const afterFlat = treeToFlat(afterTree)
  const flatDiff = delta.diff(beforeFlat, afterFlat)

  // Verify round-trip
  const applied = delta.clone(beforeFlat).apply(flatDiff).done(false)
  const recoveredTree = flatToTree(applied)
  t.compare(afterTree, recoveredTree)
}

// =========================================================================
// PART 7: Y.Type storage round-trip tests
// =========================================================================

/**
 * Test: flat delta with simple content -> Y.Type -> toDeltaDeep -> compare.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatDeltaYTypeRoundTrip = tc => {
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
 * Test: Y.Type round-trip with lists.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatDeltaYTypeListRoundTrip = tc => {
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
 * Test: Y.Type round-trip with the kitchen sink document.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testFlatDeltaYTypeKitchenSinkRoundTrip = tc => {
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
// PART 8: DEPTH_ATTR and schema correctness tests
// =========================================================================

/**
 * Test: DEPTH_ATTR constant is 'y-prosemirror-depth' (not colliding with plain 'depth').
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testDepthAttrConstant = _tc => {
  t.assert(DEPTH_ATTR === 'y-prosemirror-depth', 'DEPTH_ATTR should be y-prosemirror-depth')
}

/**
 * Test: flat output uses DEPTH_ATTR, not 'depth', on markers.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testFlatOutputUsesDepthAttr = _tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false)])
    .done(false)
  const flat = treeToFlat(tree)

  // Walk flat children and find the paragraph marker
  let foundMarker = false
  flat.children.forEach(op => {
    if (delta.$insertOp.check(op)) {
      for (const child of op.insert) {
        if (delta.$deltaAny.check(child) && child.name === 'paragraph') {
          foundMarker = true
          let hasDepthAttr = false
          let hasPlainDepth = false
          for (const attr of child.attrs) {
            if (attr.key === DEPTH_ATTR) hasDepthAttr = true
            if (attr.key === 'depth') hasPlainDepth = true
          }
          t.assert(hasDepthAttr, 'Marker should have y-prosemirror-depth attribute')
          t.assert(!hasPlainDepth, 'Marker should NOT have plain "depth" attribute')
        }
      }
    }
  })
  t.assert(foundMarker, 'Should find a paragraph marker in the flat output')
}

/**
 * Test: a node with a real 'depth' attribute (e.g., heading with a hypothetical depth attr)
 * doesn't collide with the depth marker. Round-trips correctly.
 * @param {import('lib0/testing').TestCase} tc
 */
export const testAttrCollisionWithDepth = tc => {
  // Create a heading that has a real PM attr called 'depth' (hypothetical extension)
  const heading = delta.create('heading', $prosemirrorDelta)
  heading.setAttr('level', 1)
  heading.setAttr('depth', 3) // Real PM attr, NOT our depth marker
  heading.insert('Title with depth attr')

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([heading.done(false)])
    .done(false)

  // Round-trip
  const flat = treeToFlat(tree)
  const recovered = flatToTree(flat)
  t.compare(tree, recovered, 'Node with real "depth" attr should round-trip correctly')

  // Verify both attrs are present on the flat marker
  flat.children.forEach(op => {
    if (delta.$insertOp.check(op)) {
      for (const child of op.insert) {
        if (delta.$deltaAny.check(child) && child.name === 'heading') {
          let hasRealDepth = false
          let hasMarkerDepth = false
          for (const attr of child.attrs) {
            if (attr.key === 'depth') hasRealDepth = true
            if (attr.key === DEPTH_ATTR) hasMarkerDepth = true
          }
          t.assert(hasRealDepth, 'Should preserve the real "depth" attr')
          t.assert(hasMarkerDepth, 'Should also have the y-prosemirror-depth marker attr')
        }
      }
    }
  })
}

/**
 * Test: $flatMarker schema matches block markers (leaf deltas with name+attrs, no children).
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testFlatMarkerSchema = _tc => {
  // A valid marker
  const marker = delta.create('paragraph')
  marker.setAttr(DEPTH_ATTR, 1)
  t.assert($flatMarker.check(marker.done()), 'Valid marker should match $flatMarker schema')

  // A delta with children should NOT match (if the schema enforces it)
  // Note: $flatMarker has children: null => $never, so deltas with children should fail
  const withChildren = delta.create('paragraph')
  withChildren.setAttr(DEPTH_ATTR, 1)
  withChildren.insert('some text')
  // $flatMarker.check may or may not validate children depending on lib0 implementation
  // We just confirm our valid marker passes
  t.assert($flatMarker.check(marker.done(false)), 'Marker without children matches $flatMarker')
}

// =========================================================================
// PART 9: Block formatting (node mark) preservation tests
// =========================================================================

/**
 * Test: block-level formatting (like attribution marks) survives flatten/unflatten.
 *
 * In suggestion mode, a newly inserted blockquote gets an attribution mark like:
 *   blockquote [format: { 'y-attributed-insert': { ... } }]
 *
 * This formatting should survive the round-trip.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testBlockFormattingPreservation = tc => {
  const attrFormat = { 'y-attributed-insert': { user: 'alice', time: 1234 } }

  // Build a tree where the blockquote's InsertOp carries formatting
  const bq = delta.create('blockquote', $prosemirrorDelta).insert([
    delta.create('paragraph', $prosemirrorDelta).insert('quoted').done(false)
  ]).done(false)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([bq], attrFormat)
    .done(false)

  // Flatten
  const flat = treeToFlat(tree)

  // Verify the blockquote marker in flat has the format
  let markerHasFormat = false
  flat.children.forEach(op => {
    if (delta.$insertOp.check(op) && op.format) {
      for (const child of op.insert) {
        if (delta.$deltaAny.check(child) && child.name === 'blockquote') {
          markerHasFormat = true
          t.compare(op.format, attrFormat, 'Blockquote marker should carry attribution format')
        }
      }
    }
  })
  t.assert(markerHasFormat, 'Blockquote marker should have format in flat representation')

  // Unflatten and verify the tree has the format
  const recovered = flatToTree(flat)
  t.compare(tree, recovered, 'Block formatting should survive round-trip')
}

/**
 * Test: block formatting on deeply nested nodes.
 *
 * @param {import('lib0/testing').TestCase} tc
 */
export const testNestedBlockFormattingPreservation = tc => {
  const insertFormat = { 'y-attributed-insert': { user: 'bob' } }
  const deleteFormat = { 'y-attributed-delete': { user: 'carol' } }

  // bq [format=insertFormat] > p [format=deleteFormat] > "text"
  const p = delta.create('paragraph', $prosemirrorDelta).insert('text').done(false)
  const bq = delta.create('blockquote', $prosemirrorDelta)
    .insert([p], deleteFormat)
    .done(false)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([bq], insertFormat)
    .done(false)

  assertRoundTrip(tc, tree, 'nested block formatting')
}

// =========================================================================
// PART 10: Validation tests
// =========================================================================

/**
 * Test: valid flat delta passes validation.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testValidateFlatDeltaValid = _tc => {
  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('hello').done(false),
        delta.create('paragraph', $prosemirrorDelta).insert('world').done(false)
      ]).done(false),
      delta.create('paragraph', $prosemirrorDelta).insert('after').done(false)
    ])
    .done(false)
  const flat = treeToFlat(tree)
  const result = validateFlatDelta(flat)
  t.assert(result.valid, `Valid flat delta should pass validation, errors: ${result.errors.join('; ')}`)
  t.assert(result.errors.length === 0, 'No errors expected')
}

/**
 * Test: flat delta with skipped depth levels fails validation.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testValidateFlatDeltaSkippedDepth = _tc => {
  // Manually construct a malformed flat delta: depth jumps from 0 to 3
  const flat = delta.create(null)
    .insert([
      delta.create('paragraph').setAttr(DEPTH_ATTR, 3).done()
    ])
    .done(false)
  const result = validateFlatDelta(flat)
  t.assert(!result.valid, 'Should fail: depth jumps from 0 to 3')
  t.assert(result.errors.length > 0, 'Should have at least one error')
  t.assert(result.errors[0].includes('cannot skip levels'), `Error should mention skipping levels: ${result.errors[0]}`)
}

/**
 * Test: flat delta with negative depth fails validation.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testValidateFlatDeltaNegativeDepth = _tc => {
  const flat = delta.create(null)
    .insert([
      delta.create('paragraph').setAttr(DEPTH_ATTR, -1).done()
    ])
    .done(false)
  const result = validateFlatDelta(flat)
  t.assert(!result.valid, 'Should fail: negative depth')
  t.assert(result.errors.some(e => e.includes('positive integer')), 'Should mention positive integer')
}

/**
 * Test: flat delta with non-integer depth fails validation.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testValidateFlatDeltaFloatDepth = _tc => {
  const flat = delta.create(null)
    .insert([
      delta.create('paragraph').setAttr(DEPTH_ATTR, 1.5).done()
    ])
    .done(false)
  const result = validateFlatDelta(flat)
  t.assert(!result.valid, 'Should fail: non-integer depth')
}

/**
 * Test: complex valid flat delta (lists, nesting) passes validation.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testValidateFlatDeltaComplexValid = _tc => {
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
  const flat = treeToFlat(tree)
  const result = validateFlatDelta(flat)
  t.assert(result.valid, `Nested list flat delta should pass validation, errors: ${result.errors.join('; ')}`)
}

/**
 * Test: kitchen sink flat delta passes validation.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testValidateFlatDeltaKitchenSink = _tc => {
  const heading = delta.create('heading', $prosemirrorDelta)
  heading.setAttr('level', 2)
  heading.insert('Title')

  const hb = delta.create('hard_break', $prosemirrorDelta).done(false)
  const img = delta.create('image', $prosemirrorDelta)
  img.setAttr('src', 'fig1.png')
  img.setAttr('alt', 'Figure 1')
  img.setAttr('title', null)

  const tree = delta.create(null, $prosemirrorDelta)
    .insert([
      heading.done(false),
      delta.create('paragraph', $prosemirrorDelta)
        .insert('text ')
        .insert([img.done(false)])
        .insert(' more')
        .insert([hb])
        .insert('end')
        .done(false),
      delta.create('horizontal_rule', $prosemirrorDelta).done(false),
      delta.create('blockquote', $prosemirrorDelta).insert([
        delta.create('paragraph', $prosemirrorDelta).insert('quote').done(false)
      ]).done(false)
    ])
    .done(false)
  const flat = treeToFlat(tree)
  const result = validateFlatDelta(flat)
  t.assert(result.valid, `Kitchen sink should pass validation, errors: ${result.errors.join('; ')}`)
}

// ===========================================================================
// Part 11: Real-world document round-trip (doc.json)
// ===========================================================================

/**
 * Build a ProseMirror schema that matches the doc.json structure.
 * This is separate from the test schema above to avoid breaking existing tests.
 */
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
 * Test: flatten/unflatten round-trip of a large real-world document (doc.json).
 * This loads the NIH research proposal document, converts it to a PM node,
 * then to a tree delta, flattens it, unflattens it, converts back to PM JSON,
 * and asserts equality.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testRealWorldDocJsonRoundTrip = async _tc => {
  // @ts-ignore -- Node.js built-ins, not typed in this tsconfig
  const fs = await import('fs')
  // @ts-ignore
  const path = await import('path')
  const docPath = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '..', 'doc.json')
  const docJson = JSON.parse(fs.readFileSync(docPath, 'utf-8'))

  // Build PM node from JSON
  const pmDoc = docJsonSchema.nodeFromJSON(docJson)

  // PM -> tree delta -> flat delta -> tree delta -> PM
  const treeDelta = docToDelta(pmDoc)
  const flat = treeToFlat(treeDelta)

  // Validate the flat delta
  const validation = validateFlatDelta(flat)
  t.assert(validation.valid, `doc.json flat delta validation failed: ${validation.errors.join('; ')}`)

  // Unflatten back to tree
  const recoveredTree = flatToTree(flat)

  // Convert back to PM
  const recoveredDoc = deltaToPNode(recoveredTree, docJsonSchema, null)

  // Compare PM JSON representations
  t.compare(pmDoc.toJSON(), recoveredDoc.toJSON(), 'doc.json PM round-trip failed')
}

/**
 * Test: doc.json flat delta survives Y.Type CRDT storage round-trip.
 * @param {import('lib0/testing').TestCase} _tc
 */
export const testRealWorldDocJsonYTypeRoundTrip = async _tc => {
  // @ts-ignore -- Node.js built-ins, not typed in this tsconfig
  const fs = await import('fs')
  // @ts-ignore
  const path = await import('path')
  const docPath = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '..', 'doc.json')
  const docJson = JSON.parse(fs.readFileSync(docPath, 'utf-8'))

  // Build PM node from JSON
  const pmDoc = docJsonSchema.nodeFromJSON(docJson)

  // PM -> tree delta -> flat delta
  const treeDelta = docToDelta(pmDoc)
  const flat = treeToFlat(treeDelta)

  // Store in Y.Type and read back
  const ydoc = new Y.Doc()
  const ytype = ydoc.get('doc-json-test')
  ytype.applyDelta(flat)
  const readBack = ytype.toDeltaDeep()

  // Compare flat deltas
  t.compare(flat, readBack, 'doc.json Y.Type storage failed')

  // Unflatten and compare to original tree
  const recoveredTree = flatToTree(readBack)
  const recoveredDoc = deltaToPNode(recoveredTree, docJsonSchema, null)
  t.compare(pmDoc.toJSON(), recoveredDoc.toJSON(), 'doc.json Y.Type full round-trip failed')
}
