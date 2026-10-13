# Contributing to Adnota

Thanks for considering it. Adnota is MIT licensed and we mean it literally — you can
read, modify, and redistribute everything here.

## Two ways to work

**Just the app.** Most contributions touch layout, the editor, math rendering, ink, or
collaboration. None of that requires Rust.

```bash
pnpm install
pnpm dev:web
```

The browser harness implements the Tauri IPC surface with an in-memory backend, so
you get the real application with a fake filesystem.

**The desktop shell.** If your change touches the Rust side — filesystem access,
autosave, export, native menus — install a Rust toolchain and the webview development
headers for your platform, then:

```bash
pnpm tauri dev
```

## Before you open a pull request

```bash
pnpm check
```

That runs, in order:

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm lint` | ESLint across all packages |
| `pnpm test` | Vitest unit tests |
| `pnpm test:visual` | Playwright visual regression (requires `pnpm build`) |
| `pnpm licenses` | Fails if a dependency's license drifts off the allowlist |

All of these run in CI. The license check is not advisory — it is a hard gate.

## Dependencies

Adnota holds a zero-cost guarantee. Adding a dependency means taking on a permanent
maintenance and licensing obligation, so:

- **Permissive licenses only.** MIT, ISC, Apache-2.0, BSD. Add anything else to the
  allowlist in `scripts/check-licenses.mjs` only with a clear reason in the pull
  request body.
- **No source-available or "fair use" licenses.** No SSPL, BUSL, or Elastic-style
  source-available terms, ever.
- **No services that cost money**, including in free tiers that expire. A dependency
  on a vendor's free tier is a dependency you will have to break.
- **No telemetry SDKs.** Not even opt-in ones.

If you need a capability and the obvious library is not acceptable under these rules,
raise it in an issue before writing code. We would rather solve it differently than
quietly break a guarantee.

## Commit messages

Conventional Commits, because release notes and changelogs are generated from them:

```
feat(scene): add radial mindmap layout
fix(core): preserve stroke anchor across node reparent
docs(readme): document the dev:web harness
```

## Reporting bugs

Include your platform, Adnota version, and the smallest `.adnota` file that reproduces
the problem. If you can attach that file directly, you have already done most of the
work.

For rendering differences between platforms, include what `adnota --diagnostics`
prints — it reports MathML support and the active math renderer, which is the usual
culprit.
