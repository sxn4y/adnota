# Handoff

State of Adnota as of 2026-10-15. Written for whoever picks this up next — including
future me, who will otherwise repeat some of these mistakes.

## What this is

A local-first, offline mindmap app for taking study notes, with first-class LaTeX maths.
Tauri v2 shell, React 19, TypeScript, Vite. Zero-cost stack: every dependency is MIT or
permissive, checked by `pnpm license:check` as a hard gate.

The governing decision is that **the file is the truth**. Documents are Yjs CRDTs stored as
`.adnota`, a deterministic ZIP containing `format.json`, `doc.yjs`, and content-addressed
assets. Offline editing, merging, and collaboration all fall out of that.

## Current state

**All work is uncommitted.** HEAD is `6e02061 Add desktop document and study workflows`;
everything since is staged but not committed (23 files). The user writes their own commit
messages, so do not commit without being asked.

### Test results

| Suite | Result |
| --- | --- |
| Unit (vitest) | **279 pass** |
| Rust (`cargo test`) | **29 pass** |
| Browser (Playwright, 3 engines) | **301 pass** — before the appearance work |
| Appearance spec (chromium) | 11 pass |
| Desktop bundle spec | **10 pass, 1 fail** — see Known issues |

`typecheck`, `lint`, `clippy -D warnings` and `license:check` are all clean.

The 301 figure predates node appearance, which adds 11 chromium tests. The full suite has
**not** been re-run end to end since that work landed.

### Known issues, in priority order

**1. A desktop test fails and the cause is unknown.**
`tests/visual/desktop-entry.spec.ts` → "keeps a node appearance across a real reload of a
real file". After `page.reload()` the page returns completely blank — no `#scene`, no boot
error panel, no DOM at all. It is not a slow boot: it waits 30 seconds and gets nothing.
Every other desktop test passes, so the bundle itself boots correctly; only the reload path
is broken. Not yet diagnosed. Next step: attach a `pageerror` listener and dump console
output across the reload to see whether the module graph fails to load.

**2. The full Playwright suite has not been green since appearance landed.** Run it before
trusting anything above.

**3. Visual snapshots may need regenerating.** `SceneView` now derives `rx`, `fill` and
`stroke` from the document rather than from hardcoded constants. The defaults
(`box`/`neutral`) reproduce the old geometry, so snapshots probably do not move — but this
was reasoned, not observed. Run `render.spec.ts` and inspect any diff before accepting it.

## What was built most recently

### File associations and single-instance (complete, verified end to end)

Double-clicking a `.adnota` opens it in Adnota. If Adnota is already running, the open
window takes the file rather than starting a rival instance that would autosave over it.

- `tauri-plugin-single-instance` registered first in `src-tauri/src/lib.rs`.
- `opened_path()` returns the launch argument, read from `std::env::args`.
- The second launch emits `adnota://open-document`, received by `apps/desktop/src/open-requests.ts`.
- The frontend checks `openedAtLaunch()` once at startup and registers the listener after
  the first document is on screen.

Verified by launching the real `.exe` a second time against a real file, not by unit test:

```
LIBRARY-BEFORE: Untitled.adnota
APP: processes=1 title='Adnota'
SECOND-LAUNCH: exited=True
PROCS-AFTER: 1
LIBRARY-AFTER: Launched From Shell.adnota, Untitled.adnota
```

**The bug worth remembering:** the single-instance callback passes `argv` *without*
argv[0], while `std::env::args` includes it. An implementation that skips the first
argument finds nothing on the second path, and the symptom is silence — the event fires,
carries nothing usable, and the file never opens. `document_path_in` accepts both shapes
and both are pinned by tests.

### SVG export (complete)

`packages/view/src/svgExport.ts`, wired to an "Export .svg" button.

The scene is already SVG, so export copies it rather than redrawing. Two things do not
survive that naively:

- **The pan-and-zoom transform.** Stripped from the content group; the `viewBox` is set
  from `layoutBounds`, so the file is framed on the map rather than the current view.
  `layoutBounds` is given the measurer because node coordinates are centres — without it
  every box is sliced in half.
- **The stylesheet.** Labels are HTML in a `foreignObject` laid out by CSS. The export
  reads the page's own stylesheets and embeds them, rather than keeping a second copy that
  would drift. `@font-face` is deliberately dropped: those URLs resolve to nothing in a
  saved file, so formulas fall back to a substitute font. Documented in the README.

`XMLSerializer` rather than `innerHTML` — the latter applies HTML parsing rules to SVG and
mangles it.

### Node appearance (new, mostly complete)

`packages/scene/src/palette.ts` turns a document's colour *slot* into concrete hex, and
decides box geometry per shape. `SceneView` now reads it. `NodeStyleControl.tsx` puts
colour swatches and shape buttons in the toolbar.

**Why slots resolve to hex:** the SVG export has to be self-contained, and
`fill="var(--accent)"` is not dependable across renderers. The cost is that a future theme
will not recolour existing documents. Stated in the module doc comment; revisit there.

## Things that will bite you

### The browser suite used to test a stale build

`playwright.config.ts` served the harness with `vite preview`, which serves `dist/`. Every
browser test was silently running against the last `pnpm build` — a new toolbar button was
absent from the DOM and four tests failed to find it while everything else passed. The build
is now part of the `webServer` command.

`pnpm dev:web` (dev server) and the Playwright harness server (built + preview) are **not
interchangeable**. If you start the harness yourself, you are looking at different bytes
than the tests are.

### `capabilities/default.json` must not have a UTF-8 BOM

A BOM made Tauri's build script fail with `failed to parse JSON: expected value at line 1
column 1`, which is a genuinely baffling error message for a BOM. Check
`[System.IO.File]::ReadAllBytes(...)` if the Rust build breaks mysteriously.

### PowerShell round-trips corrupt source

`Get-Content -Raw | Set-Content` has silently mangled em dashes and, when reconstructing a
file by substring, dropped entire functions and turned ``` `t ``` into a tab. Prefer the
Edit/Write tools. When appending to a file from PowerShell, use
`New-Object System.Text.UTF8Encoding($false)` — the default adds a BOM.

Em dashes in console output show as `?`. That is a rendering artifact, not file corruption;
verify with `[regex]::Matches($text, "\u2014").Count` before "fixing" it.

### `onCloseRequested` makes the window uncloseable

In this version of Tauri, merely *registering* the handler cancels the close. There is no
close handler. Pending writes flush on a 2-second heartbeat instead, which is weaker in
principle (up to 2s of work can be lost) and far better than an app that cannot close.

### Child order lives on each node's own `Y.Array`

Originally in a shared `Y.Map<Y.Array<NodeId>>` keyed by parent id. Two peers each held a
competing array under that key, Yjs settled it last-writer-wins, and merging discarded one
side's branches — measured at 3 children merging to 2. Fixed; `migrateChildrenLayout()`
converts legacy containers on open.

### The browser harness is in-memory and forgets everything on reload

Do not write "survives a reload" tests in `tests/visual/*` — they will fail by design.
Test document switching instead, and put real persistence in the desktop spec, which has a
real library and real files.

## Commands

```bash
# Harness (source, reflects working tree immediately)
pnpm dev:web

# Desktop
pnpm --filter @adnota/desktop serve        # terminal 1
pnpm --filter @adnota/desktop dev:detached # terminal 2

# Checks
pnpm check            # typecheck + lint + licence + unit
pnpm test:visual      # builds the harness, then runs Playwright
pnpm --filter @adnota/desktop build        # installers

# Rust
cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
```

Playwright `workers` is capped at 4 deliberately: three engines at full parallelism starve
Gecko, which then fails by never finding the scene. Firefox has its own 120s timeout for
the same reason.

## Architecture worth knowing

| Package | Holds |
| --- | --- |
| `packages/core` | Document model, Yjs bindings, `.adnota` container, autosave, Markdown, search |
| `packages/scene` | Layout engine, KaTeX rendering, measurement, palette |
| `packages/editor` | ProseMirror schema with first-class inline and display LaTeX |
| `packages/view` | The whole React app — scene, panels, toolbar, exports |
| `packages/collab` | Sync packets and providers. **Unwired, no tests** |
| `apps/web` | Browser harness. Mounts `@adnota/view` over an in-memory library |
| `apps/desktop` | Tauri shell: real filesystem, dialogs, single-instance |

`packages/view` owns the app, and `apps/desktop/src/main.tsx` is the only desktop-specific
code that mounts it. Anything else appearing there is a fork waiting to drift.

**Maths.** KaTeX output inside an SVG `foreignObject`. Native MathML inside SVG was the
original plan and was measured at `0 x 0`. `packages/editor/src/blockMathView.ts` renders
display maths deterministically. The app ships a "MathML in SVG" toggle that reports what
the engine actually supports rather than hiding it.

## Not built, deliberately

- **PNG export.** Chromium does not rasterise `foreignObject` when an SVG is drawn into a
  `<canvas>`. Every label and formula would come out blank. A faithful raster export needs a
  real layout engine. Shipping a PNG button that silently loses all the text would be worse
  than no button.
- **Selection is captured in exports.** It is drawn with inline attributes, so removing it
  means re-rendering the scene without it. Documented; the student's move is to deselect
  first.
- **Ink, shapes, images.** The document model supports them; there is no renderer or input
  path.
- **Collaboration.** `packages/collab` is written but unwired and untested.
- **Minimap.**
- **Code signing.** Deferred until the app is semi-functional and the repository is
  published.

## Suggested next steps

1. Diagnose the failing desktop reload test. Attach `pageerror` and console listeners
   across the reload; the blank page is the whole mystery.
2. Run the full Playwright suite and confirm it is green with appearance included.
3. Check `render.spec.ts` snapshots for unintended movement from the appearance change.
4. Either commit or split the staged work — 23 files spanning three unrelated features
   (single-instance, SVG export, appearance) is a poor commit boundary if it lands at once.
5. Minimap, if the M2 scope still matters. Otherwise node-level asset support, which would
   exercise the image path the `.adnota` container was designed for.