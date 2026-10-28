# Option 1 proof of concept

Run `npm run demo:option-one`, then open
<http://localhost:8080/demo/option-one.html> after Rollup finishes building.

This is a local-only fixture. Reload or use **Reset fixture** to start over.

## Try it

1. **Delete sample word**: the deleted text appears in a widget and in the
   extraction panel, but not in live PM JSON.
2. Type before/after the widget; its CRDT anchor tracks the live gap.
3. **Delete second paragraph**: the subtree is anchored at the root's surviving
   child gap, not inside the deleted paragraph.
4. Select across paragraphs and delete, or delete differently formatted text.
   Multiple records may share a position; widgets retain diff traversal order.
5. **Accept all** removes widgets, including deletion-only changes that do not
   change PM content. **Reject all** restores content and removes widgets.
6. **Insert sample text** or type anywhere: new text is highlighted green with
   inline decorations, not schema marks. **Insert paragraph** highlights the
   whole node with a node decoration (also works for empty paragraphs and atoms).
   Accepting keeps the content and clears the highlight; rejecting removes it.

## Boundaries

- `option-one.js` binds the suggestion document using `renderer: null` and the
  unextended basic PM schema. A separate DiffRenderer handles extraction and
  accept/reject; no changes to the binding or Y implementation.
- `deletion-widgets.js` converts an attributed deep delta into plain PM-shaped
  data without schema validation or PM node construction. Widgets use hand-built
  DOM (including controls not represented in the schema). The POC displays text
  summaries, not a complete rich-content renderer.
- `extractSuggestions` extracts deletion records and insertion ranges in one
  traversal. Insertion endpoints are CRDT relative positions mapped through the
  plain binding. `suggestionDecorations` combines deletion widgets with inline
  text and per-node insertion decorations; inserted subtrees are not redundantly
  highlighted inside their already-highlighted parent.
- Source range endpoints and the display anchor are CRDT relative positions.
  They are not stable change IDs or a per-change accept/reject API.
- Rebuilds are full, coalesced microtasks after synchronous binding work.
  Transaction mapping only bridges the interval until the next full rebuild.
- This does not cover remote collaboration, formatting-change decorations,
  production interaction/accessibility, arbitrary schema repairs, or performance.
  Unresolvable anchors are reported in the panel instead of guessed.

Regression tests: `npm test -- --filter 'deletionWidgets:'`.
