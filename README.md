# Adnota

A mindmap-first desktop app for taking study notes. Branches and structure first, with
live LaTeX on the same canvas.

Named for *adnotatio* — the scholarly tradition of writing notes in the margin of a
text.

## Status

**Early development.** The features listed below under "What works today" are the ones
that are built, exercised by tests, and usable now. A "Planned" section records what is
designed but not yet implemented, because the difference matters when you are deciding
whether to trust a file format.

## What works today

- **Mindmap core** — auto-laid-out branches in three layouts (two-sided, radial, left),
  collapse/expand, and a full keyboard model: `Tab` child, `Enter` sibling, `Shift+Tab`
  outdent, arrows to walk the tree, `Space` to fold a branch. Nodes carry a short inline
  label with live maths, plus a rich notes body.
- **Live LaTeX** — type `$...$` or `$$...$$` for inline and display maths, rendered with
  KaTeX. No compile step.
- **Outline view** — the same document as an indented list, which is how you revise from
  it. Click a row to select, use the carets to fold.
- **Search** — `Ctrl+K`. Searches labels, notes, and formula source; results are ranked so
  a title match beats a passing mention.
- **Notes** — a block editor per node: headings, lists, quotes, code, inline and display
  maths.
- **Documents** — create, open, rename and delete `.adnota` files. One folder, flat, in
   your Documents directory. Double-clicking a `.adnota` in your file manager opens it here,
   and if Adnota is already running the open window takes it rather than starting a rival
   instance that would autosave over your work.
 - **Open and Save As** — reach documents outside the library folder. Opening one copies it
   in, so Adnota owns the file it edits rather than sharing it with another program.
- **Markdown export** — nested bullets with the maths intact as LaTeX, so the file opens
  in Obsidian, a text editor, or a repository and stays searchable.
- **SVG export** — a standalone vector copy of the map, framed on the content rather than
  the current view, with its stylesheet embedded so labels and maths keep their layout. Two
  caveats: `@font-face` rules are dropped, so a formula opened away from the app falls back
  to a substitute font; and the export is a faithful capture of the view, so a node that is
  selected when you export is outlined in the file too.
- **Local first** — the file on disk is the document. No account, no server, no
  telemetry. Works offline.

### Keyboard

| Key | Action |
| --- | --- |
| Click / double-click | Select / edit a node |
| `Tab` · `Enter` · `Shift+Tab` | Child · sibling · outdent |
| `↑` `↓` | Walk the tree in reading order |
| `←` `→` | Walk up and down a branch |
| `Space` | Collapse or expand |
| `Backspace` | Delete, only if the node is empty |
| `Escape` | Leave editing · clear selection |
| `Ctrl+K` | Search |
| `+` `−` `0` | Zoom in · out · fit |

## Planned

Designed, not yet built. None of this is in the shipped file format in a way you can rely
on today.

- **Images** — the container codec and asset storage are built and tested, but there is no
  picker, no insertion, and byte transfer still needs to move off Tauri's JSON IPC path.
- **Freehand ink and shapes** — the document model supports them; there is no renderer or
  input path.
- **Collaboration** — `packages/collab` implements sync packets and providers but is
  unwired and has no tests.
- **PNG export** — SVG works; PNG does not, and the reason is structural rather than an
  oversight. Labels are HTML inside a `foreignObject`, and Chromium does not rasterise
  `foreignObject` content when an SVG is drawn into a `<canvas>`. Every label and formula
  would come out blank in a PNG, which is worse than no PNG at all. A faithful raster
  export needs a real layout engine, so it is not a small job.
- **Node colour and shape** — the model supports it; the renderer does not read it yet.

## Design principles

**The file is the truth.** Documents are Yjs CRDTs stored as `.adnota` (a ZIP containing
the binary document state and its assets). That single decision makes offline editing,
merging, and collaboration fall out for free.

**Vector in, vector out.** The scene renders as SVG, so export can produce vector output
rather than screenshots, and text stays selectable and accessible to screen readers.

**Maths is rendered, not typeset twice.** Formulas are KaTeX output inside an SVG
`foreignObject`. Native MathML inside SVG was the original plan and was measured at a
`0 × 0` bounding box — it does not render. This is recorded in `packages/scene` so it is
not re-attempted.

**Saving is paranoid.** Writes stage to a temporary file, rotate the previous file to a
`.bak`, then promote. A crash leaves either the old file or the new one, never a blend.

**Zero cost.** Everything in the stack is permissively licensed and free software,
enforced in CI against an allowlist. The only paid accounts anyone needs are the Apple
and Google developer programs, and neither is required to build.

**No accounts, ever.** There is no login, no sync server we operate, and no telemetry.

## Building

### Working on the app

You do not need Rust.

```bash
pnpm install
pnpm dev:web
```

This runs the real frontend in a browser against an in-memory document library. Layout,
editing, maths, search, notes, outline and export all work this way.

### The desktop app

Requires a Rust toolchain and the platform webview development headers.

```bash
pnpm install
pnpm --filter @adnota/desktop dev
```

That starts Vite and the window together. Closing the window stops both. To keep the
dev server running across restarts, start them separately:

```bash
pnpm --filter @adnota/desktop serve        # terminal 1: the dev server
pnpm --filter @adnota/desktop dev:detached # terminal 2: the window
```

Build installers:

```bash
pnpm --filter @adnota/desktop build
```

Outputs an MSI and an NSIS installer under
`apps/desktop/src-tauri/target/release/bundle/`. They are unsigned, so Windows
SmartScreen will warn on first install.

On Linux you additionally need `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, and
`librsvg2-dev`.

## Checks

```bash
pnpm typecheck      # includes apps/desktop
pnpm lint
pnpm test           # unit tests
pnpm license:check
pnpm test:visual    # browser tests; not part of `pnpm check`
```

## Layout

```
packages/core      document model, Yjs bindings, .adnota container, autosave
packages/scene     SVG renderer, maths, layout engine
packages/editor    ProseMirror schemas and node views
packages/view      the shared React application
packages/collab    sync packets and providers (unwired)
apps/web           browser harness, mounts @adnota/view
apps/desktop       Tauri shell: storage bridge, documents library
tests/visual       browser tests, including one that loads the desktop bundle
```

The harness and the desktop window mount the *same* `@adnota/view` application. Anything
that differs between them is a prop, not a fork.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Dependency licenses are enforced in CI against a permissive allowlist.