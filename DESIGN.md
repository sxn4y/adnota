# M3 — A picture is a node

## The idea

Adnota is for studying. The thing a student studies from — the Krebs cycle, the
eigenvector diagram, the plate from the back of the chapter — is a picture, and today
there is nowhere to put one. The container has had a content-addressed asset store since
M0. Nothing has ever written to it.

So: **a picture is a node.** Not an inline thumbnail wrapped in a run of text, which is
what the existing `InlineNode.image` is, and not an attachment hanging off the side. A
node whose content is a picture, laid out at the picture's aspect ratio, with a caption
underneath it and a branch attaching to it exactly as it does to every other node. Drop
the plate in, and it joins the map.

## The decision that makes it work

**A node gains a `kind`.** `'text'` (the default, and what every existing document is)
or `'image'`. The image node's `label` stops being a name and becomes its **caption**.

That single field is what lets everything else stay simple. Because `measureNode` is
already the single choke point every downstream consumer takes as a callback —
`layoutTree`, `layoutBounds`, `exportViewBox`, fit-to-window — teaching it about pictures
propagates to the whole app from one function. The layout engine never learns what a
picture is. It only knows a node is a box of a certain size, and a picture is a box of a
certain size.

## The look

A picture node is a **plate**, not a tinted box.

- The palette's rounded rectangle is the wrong geometry for an image; a plate is a thin
  frame with the picture inset by `PADDING_X`/`PADDING_Y` like every other node's text.
- The picture is fitted, never stretched: aspect ratio preserved, letterboxed, capped at
  `IMAGE_MAX_EDGE` on the long side so a 4000px photograph cannot blow a column apart.
- The caption sits below the frame at label size, so an image node reads at the same
  weight as a text node in the outline and in the diagram.
- The frame takes the node's palette stroke, so a red picture node has a red frame and a
  red branch. Colour still means emphasis.
- **Bytes missing**: draw the frame and the alt text. Never an empty rectangle, and never
  a node that silently disappears.

## Palette

Unchanged. `packages/scene/src/palette.ts` already resolves slots to concrete hex, which
is what lets an exported SVG carry colour into a renderer that has never heard of Adnota.
Images do not introduce a colour; they inherit one.

## Motion

None, deliberately. An image appearing should be instantaneous — the student dropped it
there and it is there. A fade would imply something arrived that did not.

## Insertion

**Paste and drop, onto the canvas.** Both are plain DOM events, so both work in the
browser harness *and* inside the Tauri webview with no permissions, no dialog plugin, and
no new Rust. A native file picker is an enhancement on top, not a prerequisite.

The bytes arrive as a `File`, are hashed, sniffed and stored in the document by the same
JavaScript that writes the container — they never cross the Tauri IPC boundary on their
way in.

## What this deliberately does not fix

Tauri serialises command arguments as JSON, so a `Uint8Array` becomes an array of
numbers on its way to Rust — roughly four bytes per byte. A document holding a 2 MB
screenshot therefore costs about 6 MB on the wire every autosave. That is survivable but
it is the reason `MAX_IMAGE_BYTES` is 8 MiB rather than "whatever the clipboard gives
us". Moving assets to Tauri's raw-body channel is the real fix and is recorded on both
halves of the bridge. This is not that work.

## The risk worth naming

`buildDocument` throws when a document references an asset whose bytes were not supplied,
and six production call sites currently pass `new Map()`. The day the first picture is
inserted, autosave, rename and Save As all start failing. The asset provider seam already
exists (`DocumentSession.setAssetProvider`) and has never been wired to anything but a
test. Wiring it is part of this work, not a follow-up, because it is the thing that turns
a working demo into a working file.