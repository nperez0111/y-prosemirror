import { useCreateBlockNote } from '@blocknote/react'
import { createExtension } from '@blocknote/core'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import { syncPlugin, yCursorPlugin, ySuggestionDecorationPlugin, editableDeletionMapDiff } from '@y/prosemirror'
import { useEffect } from 'react'
import { yhub } from './yhub.js'

const YSyncExtension = createExtension(() => ({
  key: 'ySync',
  prosemirrorPlugins: [syncPlugin()]
}))

const YSuggestionDecorationExtension = createExtension(() => ({
  key: 'ySuggestionDecoration',
  // Render deleted content as editable sub-editors (footnote pattern) so a
  // user can click into a deletion and edit the removed text.
  prosemirrorPlugins: [ySuggestionDecorationPlugin({ mapDiffToDecorations: editableDeletionMapDiff })]
}))

const YCursorExtension = createExtension(() => ({
  key: 'yCursor',
  prosemirrorPlugins: [yCursorPlugin(yhub.provider.awareness)]
}))

export default function Editor () {
  const editor = useCreateBlockNote({
    extensions: [
      YSyncExtension(),
      YSuggestionDecorationExtension(),
      YCursorExtension()
    ]
  })

  useEffect(() => {
    const view = editor?._tiptapEditor?.view
    if (view) {
      yhub.attachView(view)
    }
    return () => yhub.detachView()
  }, [editor])

  return <BlockNoteView editor={editor} theme='light' />
}
