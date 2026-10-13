# Adnota

A mindmap-first desktop app for taking study notes. Branches and structure first,
with live LaTeX, images, and freehand drawing on the same canvas.

Named for *adnotatio* — the scholarly tradition of writing notes in the margin of a
text.

## What it is

Adnota treats a mindmap as the primary document, not a picture inside a notes app.

- **Mindmap core** — auto-laid-out branches, collapse/expand, a full keyboard model
  (`Tab` child, `Enter` sibling, `Shift+Tab` outdent). Nodes carry a short inline
  label with live math, plus an optional rich notes body.
- **Live LaTeX** — type `$...$` or `$$...$$` for inline and display math. Rendered
  with KaTeX, no compile step.
- **Canvas layer** — pressure-sensitive ink, shapes and connectors, and dropped-in
  images. Ink can be anchored to a node so it stays put through re-layout and export.
- **Local first** — the file on disk is the document. No account, no server, no
  telemetry. Works offline forever.
- **Collaboration** — optional and free. Folder sync, async sync packets, peer-to-peer
  sessions, or an optional self-hosted relay. The app is complete without any of them.

## Design principles

**The file is the truth.** Documents are Yjs CRDTs stored as `.adnota` (a ZIP
containing the binary document state and its assets). That single decision makes
offline editing, merging, and collaboration fall out for free.

**Vector in, vector out.** The scene renders as pure SVG, with math emitted as MathML.
Export to PDF or SVG therefore produces *vector* mathematics rather than screenshots,
and text stays selectable and accessible to screen readers.

**Zero cost.** Adnota builds and distributes at no monetary cost. Everything in the
stack is permissively licensed and free software. The only paid accounts anyone needs
are the Apple and Google developer programs, and neither is required to build.

**No accounts, ever.** There is no login, no sync server we operate, and no telemetry.
Your notes never leave your machine unless you send them somewhere yourself.

## Status

Early development. See [CONTRIBUTING.md](CONTRIBUTING.md) to build it.

## Building

### For contributors who just want to work on the app

You do not need Rust.

```bash
pnpm install
pnpm dev:web
```

This runs the entire frontend in a normal browser against a mock Tauri IPC shim. The
layout engine, editor, math renderer, ink, and collaboration code all work this way.

### For the desktop app

Requires a Rust toolchain and the platform webview development headers.

```bash
pnpm install
pnpm tauri dev
```

On Linux you additionally need `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, and
`librsvg2-dev`.

## Layout

```
packages/core     document model, Yjs bindings, .adnota container
packages/scene    SVG renderer, math rendering, layout engine
packages/collab   sync providers and packet exchange
apps/web          browser development harness with mock IPC
apps/desktop      Tauri desktop shell
```

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Dependency licenses are enforced in CI against a permissive allowlist.
