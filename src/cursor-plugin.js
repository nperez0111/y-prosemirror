import * as Y from '@y/y'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { Plugin } from 'prosemirror-state'
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition
} from './positions.js'
import { yCursorPluginKey, ySyncPluginKey } from './keys.js'

import * as math from 'lib0/math'

/**
 * @typedef {Object} User
 * @property {string} [name] The label to display for the user
 * @property {string} [color] The color to display for the user
 */

/**
 * @callback AwarenessFilter
 * @param {number} currentClientId
 * @param {number} userClientId
 * @param {Record<string, any>} awarenessState
 * @returns {boolean} true if the cursor should be rendered for the given client
 */

/**
 * Default generator for a cursor element
 *
 * @param {User} user user data
 * @return {HTMLElement}
 */
export const defaultCursorBuilder = (user) => {
  const cursor = document.createElement('span')
  cursor.classList.add('ProseMirror-yjs-cursor')
  if (user.color) {
    cursor.style.setProperty('--user-color', user.color)
  }
  const userDiv = document.createElement('div')
  if (user.color) {
    userDiv.style.setProperty('--user-color', user.color)
  }
  userDiv.insertBefore(document.createTextNode(user.name || ''), null)
  const nonbreakingSpace1 = document.createTextNode('\u2060')
  const nonbreakingSpace2 = document.createTextNode('\u2060')
  cursor.insertBefore(nonbreakingSpace1, null)
  cursor.insertBefore(userDiv, null)
  cursor.insertBefore(nonbreakingSpace2, null)
  return cursor
}

/**
 * Default generator for the selection attributes
 *
 * @param {User} user user data
 * @return {import('prosemirror-view').DecorationAttrs}
 */
export const defaultSelectionBuilder = (user) => {
  return {
    style: `--user-color: ${user.color}`,
    class: 'ProseMirror-yjs-selection'
  }
}

/**
 * @param {import('prosemirror-state').EditorState} state
 * @param {import('@y/protocols/awareness').Awareness} awareness
 * @param {AwarenessFilter} awarenessFilter
 * @param {(user: User, clientId: number) => Element} createCursor
 * @param {(user: User, clientId: number) => import('prosemirror-view').DecorationAttrs} createSelection
 * @param {string} cursorStateField
 * @return {DecorationSet}
 */
export const createDecorations = (
  state,
  awareness,
  awarenessFilter,
  createCursor,
  createSelection,
  cursorStateField
) => {
  const ystate = ySyncPluginKey.getState(state)
  const type = ystate?.ytype
  const doc = type?.doc
  if (!type || !doc) {
    // do not render cursors while snapshot is active
    return DecorationSet.empty
  }
  const maxsize = math.max(state.doc.content.size - 1, 0)
  /**
   * @type {Decoration[]}
   */
  const decorations = []
  awareness.getStates().forEach((aw, clientId) => {
    const cursor = aw[cursorStateField]

    if (cursor == null || !awarenessFilter(awareness.clientID, clientId, aw)) {
      return
    }

    const user = aw.user || {}
    if (user.color == null) {
      user.color = '#ffa500'
    }
    if (user.name == null) {
      user.name = `User: ${clientId}`
    }
    let anchor = relativePositionToAbsolutePosition(
      Y.createRelativePositionFromJSON(cursor.anchor),
      type,
      state.doc,
      ystate.attributionManager
    )
    let head = relativePositionToAbsolutePosition(
      Y.createRelativePositionFromJSON(cursor.head),
      type,
      state.doc,
      ystate.attributionManager
    )
    if (anchor !== null && head !== null) {
      anchor = math.min(anchor, maxsize)
      head = math.min(head, maxsize)
      decorations.push(
        Decoration.widget(head, () => createCursor(user, clientId), {
          key: clientId + '',
          side: 10
        })
      )
      decorations.push(
        Decoration.inline(math.min(anchor, head), math.max(anchor, head), createSelection(user, clientId), {
          inclusiveEnd: true,
          inclusiveStart: false
        })
      )
    }
  })
  return DecorationSet.create(state.doc, decorations)
}

/**
 * @callback ComputeCursorCallback
 * @param {object} ctx - The context object
 * @param {import('prosemirror-view').EditorView} ctx.view - The editor view
 * @param {{anchor: Y.RelativePosition, head: Y.RelativePosition} | null} ctx.prevCursor - The previous awareness cursor for this client (decoded to Y.RelativePosition), or null if not set
 * @param {{anchor: Y.RelativePosition, head: Y.RelativePosition} | null} ctx.nextCursor - The freshly computed cursor for the local selection, or null if no Y type is bound
 * @param {boolean} ctx.isOwnCursor - Whether `prevCursor` resolves inside this editor binding's bound type
 * @param {'update' | 'focus' | 'blur'} ctx.reason - What triggered this invocation: 'update' (PM view.update tick), 'focus' (focusin on view.dom; only fires when no `setSelection` transaction is pending — see `selectionUpdateIsPending` in cursor-plugin.js), or 'blur' (focusout on view.dom)
 * @returns {{anchor: Y.RelativePosition, head: Y.RelativePosition} | null} The next cursor state to be set in the awareness, or null to clear the cursor
 */

/**
 * A prosemirror plugin that listens to awareness information on Yjs.
 * This requires that a `prosemirrorPlugin` is also bound to the prosemirror.
 *
 * @public
 * @param {import('@y/protocols/awareness').Awareness} awareness
 * @param {object} opts
 * @param {AwarenessFilter} [opts.awarenessStateFilter] A function that filters the awareness states to be rendered
 * @param {(user: User, clientId: number) => HTMLElement} [opts.cursorBuilder] A function that creates a cursor element
 * @param {(user: User, clientId: number) => import('prosemirror-view').DecorationAttrs} [opts.selectionBuilder] A function that creates a selection decoration
 * @param {ComputeCursorCallback} [opts.computeCursor] A function that computes the cursor state from the previous and next cursor states
 * @param {string} [opts.cursorStateField = 'cursor'] By default all editor bindings use the awareness 'cursor' field to propagate cursor information, this allows you to use a different field name
 * @return {Plugin<DecorationSet>}
 */
export const yCursorPlugin = (
  awareness,
  {
    awarenessStateFilter = (currentClientId, userClientId) => currentClientId !== userClientId,
    cursorBuilder = defaultCursorBuilder,
    selectionBuilder = defaultSelectionBuilder,
    cursorStateField = 'cursor',
    computeCursor = (ctx) => {
      if (ctx.view.hasFocus()) {
        return ctx.nextCursor
      }
      // delete the cursor if it is owned by this editor binding
      // otherwise, keep the previous cursor
      return ctx.isOwnCursor ? null : ctx.prevCursor
    }
  } = {}
) =>
  new Plugin({
    key: yCursorPluginKey,
    state: {
      init (_, state) {
        return createDecorations(
          state,
          awareness,
          awarenessStateFilter,
          cursorBuilder,
          selectionBuilder,
          cursorStateField
        )
      },
      apply (tr, prevState, _oldState, newState) {
        const ySyncMeta = tr.getMeta(ySyncPluginKey)
        const ySyncTransaction = tr.getMeta('y-sync-transaction')
        const yCursorMeta = tr.getMeta(yCursorPluginKey)

        if (ySyncMeta || ySyncTransaction || yCursorMeta?.awarenessUpdated) {
          // rebuild all decorations
          return createDecorations(
            newState,
            awareness,
            awarenessStateFilter,
            cursorBuilder,
            selectionBuilder,
            cursorStateField
          )
        }
        // remap decorations
        return prevState.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations: (state) => yCursorPluginKey.getState(state)
    },
    view: (view) => {
      const awarenessListener = () => {
        if (view.isDestroyed) {
          return
        }
        view.dispatch(view.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }))
      }

      /**
       * @param {'update' | 'focus' | 'blur'} reason
       */
      const runComputeCursor = (reason) => {
        if (view.isDestroyed) {
          return
        }
        const ystate = ySyncPluginKey.getState(view.state)
        const rawCursor = (awareness.getLocalState() || {})[cursorStateField]
        /**
         * @type {{anchor: Y.RelativePosition, head: Y.RelativePosition} | null}
         */
        const prevCursor = rawCursor != null
          ? {
              anchor: Y.createRelativePositionFromJSON(rawCursor.anchor),
              head: Y.createRelativePositionFromJSON(rawCursor.head)
            }
          : null

        const nextCursor = ystate?.ytype
          ? {
              anchor: absolutePositionToRelativePosition(
                view.state.selection.$anchor,
                ystate.ytype,
                ystate.attributionManager
              ),
              head: absolutePositionToRelativePosition(
                view.state.selection.$head,
                ystate.ytype,
                ystate.attributionManager
              )
            }
          : null
        const nextCursorState = computeCursor({
          view,
          prevCursor,
          nextCursor,
          reason,
          get isOwnCursor () {
            return prevCursor != null && ystate?.ytype != null && relativePositionToAbsolutePosition(
              prevCursor.anchor,
              ystate.ytype,
              view.state.doc,
              ystate.attributionManager
            ) !== null
          }
        })

        // compute whether the cursor has changed
        const cursorChanged = (prevCursor == null) !== (nextCursorState == null) || (
          prevCursor != null && nextCursorState != null && (
            !Y.compareRelativePositions(prevCursor.anchor, nextCursorState.anchor) ||
            !Y.compareRelativePositions(prevCursor.head, nextCursorState.head)
          )
        )

        if (cursorChanged) {
          awareness.setLocalStateField(cursorStateField, nextCursorState)
        }
      }

      const onFocusIn = () => {
        if (view.isDestroyed) return
        // This fixes an issue where focusin is called before the selection is updated
        // This allows us to bail out if the selection will change immediately after focusin
        // This allows us to skip a flicker of setting the cursor, just to change it to the correct position
        /** @type {Selection | null} */
        const sel = (/** @type {any} */ (view.root)).getSelection()
        if (sel && sel.rangeCount > 0 && sel.anchorNode) {
          try {
            if (view.posAtDOM(sel.anchorNode, sel.anchorOffset, -1) !== view.state.selection.anchor) {
              return
            }
          } catch { /* posAtDOM failed; re-evaluate the cursor */ }
        }
        runComputeCursor('focus')
      }
      const onFocusOut = () => runComputeCursor('blur')

      awareness.on('change', awarenessListener)
      view.dom.addEventListener('focusin', onFocusIn)
      view.dom.addEventListener('focusout', onFocusOut)

      return {
        update: () => runComputeCursor('update'),
        destroy: () => {
          awareness.off('change', awarenessListener)
          view.dom.removeEventListener('focusin', onFocusIn)
          view.dom.removeEventListener('focusout', onFocusOut)
        }
      }
    }
  })
