/**
 * Editor state construction.
 *
 * Kept separate from the React layer so that editor behaviour is testable without a
 * DOM, and so the browser harness and the desktop app mount an identical editor.
 */

import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
  toggleMark,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { EditorView } from 'prosemirror-view';
import {
  EditorState,
  NodeSelection,
  Plugin,
  TextSelection,
  type Command,
  type Transaction,
} from 'prosemirror-state';
import {
  insertMathCmd,
  mathBackspaceCmd,
  mathPlugin,
  makeBlockMathInputRule,
  makeInlineMathInputRule,
  REGEX_BLOCK_MATH_DOLLARS,
  REGEX_INLINE_MATH_DOLLARS,
} from '@benrbray/prosemirror-math';
import type { BlockDoc, InlineDoc } from '@adnota/core';
import { blockDocFromEditor, blockDocToPm, inlineDocFromEditor, inlineDocToPm } from './convert.ts';
import { blockMathNodeView } from './blockMathView.ts';
import { blockSchema, inlineSchema, markNames, nodeNames } from './schema.ts';

/**
 * Origin stamped on every transaction this module creates.
 *
 * The autosave layer marks the document dirty only for local origins, so this
 * symbol is what separates a student's typing from a collaborator's update.
 */
export const LOCAL_ORIGIN = 'adnota.local';

/**
 * Origin for transactions carrying a collaborator's changes.
 *
 * ## Why nothing is filtered
 *
 * An earlier version of this gated edits with `filterTransaction`, rejecting anything
 * without the local origin. That was wrong twice over:
 *
 *   - `filterTransaction` is a `PluginSpec` option in prosemirror-state, not an
 *     `EditorState` config field. Passing it in the config silently did nothing, so the
 *     guard that looked protective was not present at all.
 *   - Even as a plugin, rejecting foreign transactions would break the maths plugin,
 *     which dispatches its own document-changing transactions without our origin.
 *
 * The requirement is narrower and is about history, not acceptance: a collaborator's
 * edit must not be undone by the local user's Ctrl+Z. So remote transactions are
 * applied normally and merely excluded from undo via `addToHistory: false`.
 */
export const REMOTE_ORIGIN = 'adnota.remote';

/** Transaction meta key understood by `prosemirror-history`. */
export const ADD_TO_HISTORY = 'addToHistory';

/**
 * Prepare a transaction carrying a collaborator's changes.
 *
 * Applied to the transaction rather than performed here, because rebasing a remote
 * diff is the collaboration layer's job and needs the original update's structure.
 */
export function markRemote<T extends { setMeta: (key: unknown, value: unknown) => T }>(
  transaction: T,
): T {
  return transaction.setMeta(REMOTE_ORIGIN, true).setMeta(ADD_TO_HISTORY, false) as T;
}

/**
 * Move the caret off a selected maths node.
 *
 * A `math_display` node renders as an editable source box while it holds a
 * `NodeSelection`, and only renders typeset output once the selection moves off it.
 * Clicking elsewhere in the panel changes focus but not the selection, so a formula
 * entered into the notes body stayed as raw LaTeX with no obvious way out.
 *
 * Returns `null` when the current selection is not a selected maths node, so the
 * caller can let the key fall through to the ordinary `Escape` behaviour.
 *
 * This lives here rather than in the view package so that `prosemirror-state` stays a
 * dependency of this package alone. The view is meant to know about documents, not
 * about ProseMirror's selection types.
 */
export function leaveMathSelection(state: EditorState): Transaction | null {
  const { selection, doc } = state;
  if (!(selection instanceof NodeSelection)) return null;
  if (!selection.node.type.name.startsWith('math')) return null;

  // One position past the node, clamped to the end of the document. `TextSelection.near`
  // rather than `create` so the caret lands on a valid text position even when the
  // maths node is the last thing in the document.
  const target = Math.min(selection.to + 1, doc.content.size);

  return state.tr
    .setSelection(TextSelection.near(doc.resolve(target)))
    // Not part of history: undoing a caret move is surprising, and this transaction
    // changes no document content.
    .setMeta(ADD_TO_HISTORY, false);
}

/**
 * Move the caret past whichever maths node contains a DOM element.
 *
 * Preferred over `leaveMathSelection` when the caret is inside a maths node's own
 * editable box, because at that point the view's selection is often a plain
 * `TextSelection` rather than a `NodeSelection` and the selection-only check declines.
 * Resolving the position from the DOM works regardless of what the selection happens to
 * be, which is what makes the behaviour reliable rather than incidental.
 *
 * Returns `null` when the element is not inside a maths node.
 */
export function leaveMathAt(view: EditorView, element: HTMLElement): Transaction | null {
  const pos = view.posAtDOM(element, 0);
  if (typeof pos !== 'number' || pos < 0) return null;

  const { doc } = view.state;
  const $pos = doc.resolve(pos);

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (!node.type.name.startsWith('math')) continue;

    const after = $pos.after(depth);
    return view.state.tr
      .setSelection(TextSelection.near(doc.resolve(Math.min(after, doc.content.size))))
      .setMeta(ADD_TO_HISTORY, false);
  }

  return null;
}

export interface EditorOptions {
  /** Initial content. */
  readonly doc: InlineDoc;
  /** Called after every local change, with the model's shape. */
  readonly onChange?: (doc: InlineDoc) => void;
  /** Called when the editor requests a node structural change, e.g. via Enter. */
  readonly onSplit?: () => void;
  /** Called when the editor wants to surrender focus, e.g. via Escape. */
  readonly onExit?: () => void;
  readonly readOnly?: boolean;
}

/**
 * Report document changes to the owner.
 *
 * Previously `EditorOptions.onChange` was accepted and documented but never wired to
 * anything, so the notes panel silently lost everything typed into it: the editor
 * looked correct, the caret behaved, and on reopening the panel the text was gone.
 *
 * A plugin view rather than `appendTransaction` because the callback is a side effect
 * that must not be smuggled out of a transaction: `appendTransaction` is expected to
 * return a transaction or nothing, and doing work in it means the work runs again on
 * undo and redo. Comparing documents in `update` fires exactly once per settled change.
 */
function onChangePlugin<T>(
  read: (state: EditorState) => T,
  onChange?: (value: T) => void,
): Plugin | null {
  if (!onChange) return null;

  return new Plugin({
    view() {
      return {
        update(view, previousState) {
          if (previousState.doc.eq(view.state.doc)) return;
          onChange(read(view.state));
        },
      };
    },
  });
}

export function createEditorState(options: EditorOptions): EditorState {
  const schema = inlineSchema;

  const plugins: Plugin[] = [
    mathPlugin,
    buildInputRules(schema),
    ...pluginsFrom(onChangePlugin((state) => inlineDocFromEditor(state.doc), options.onChange)),
    keymap(buildKeymap(options)),
    keymap(baseKeymap),
    history(),
  ];

  return EditorState.create({
    doc: inlineDocToPm(options.doc, schema),
    schema,
    plugins,
  });
}

/** Plugin lists are fixed-length, so an absent callback is filtered rather than spread. */
function pluginsFrom(...plugins: (Plugin | null)[]): Plugin[] {
  return plugins.filter((plugin): plugin is Plugin => plugin !== null);
}

export interface BlockEditorOptions {
  /** Initial content. */
  readonly doc: BlockDoc;
  /** Called after every local change, with the model's shape. */
  readonly onChange?: (doc: BlockDoc) => void;
  /** Called when the editor wants to surrender focus, e.g. via Escape. */
  readonly onExit?: () => void;
  /**
   * Move the caret off a selected maths node when Escape is pressed.
   *
   * On by default. A `math_display` node renders typeset only while it is *not* selected,
   * and clicking elsewhere in a notes panel moves focus without moving the selection —
   * so without this a formula stayed as raw LaTeX with no obvious way to leave it.
   *
   * Turned off only where Escape has a different meaning, such as the single-line
   * label editor.
   */
  readonly exitMathOnEscape?: boolean;
  readonly readOnly?: boolean;
}

/**
 * Editor state for a node's notes body.
 *
 * Deliberately separate from `createEditorState` rather than a schema flag on it:
 *
 *   - the two schemas have different valid children, so `doc: content` cannot be
 *     shared between them without casting through the schema;
 *   - the keymaps differ in intent, not just in bindings. `Enter` splits a *node* in
 *     the label editor and creates a *paragraph* in the notes editor. Binding one from
 *     the other would make Enter either useless or destructive depending on which
 *     panel had focus;
 *   - the notes editor must not accept the inline maths input rule, which matches on a
 *     bare `$...$` and would turn a currency amount in a paragraph into a formula.
 */
export function createBlockEditorState(options: BlockEditorOptions): EditorState {
  const schema = blockSchema;

  const plugins: Plugin[] = [
    // Ahead of `mathPlugin` deliberately. ProseMirror takes the first plugin that
    // defines a prop, so putting this after the maths plugin would leave the library's
    // node view in place and this one unused — which looks exactly like "the fix did
    // nothing".
    blockNodeViewsPlugin(),
    mathPlugin,
    buildBlockInputRules(schema),
    ...pluginsFrom(onChangePlugin((state) => blockDocFromEditor(state.doc), options.onChange)),
    ...pluginsFrom(exitMathPlugin(options.exitMathOnEscape ?? true)),
    keymap(buildBlockKeymap(options)),
    keymap(baseKeymap),
    history(),
  ];

  return EditorState.create({
    doc: blockDocToPm(options.doc, schema),
    schema,
    plugins,
  });
}

/**
 * Escape leaves a selected maths node.
 *
 * A plugin rather than `editorProps` on the view: ProseMirror's view constructor takes
 * only `DirectEditorProps`, so anything custom has to arrive through the plugin list.
 * Doing it here also keeps `prosemirror-state` out of the view package entirely, which
 * is the boundary the packages are meant to maintain.
 */
/**
 * Node views the notes body installs, overriding the maths library's own.
 *
 * Supplied through `EditorProps.nodeViews`, not the `nodeViews` field on the `EditorView`
 * constructor: the view has to be constructed before the plugins exist, and the plugin
 * route also means the view package never has to import `prosemirror-view`.
 */
function blockNodeViewsPlugin(): Plugin {
  return new Plugin({ props: { nodeViews: { [nodeNames.mathDisplay]: blockMathNodeView } } });
}

function exitMathPlugin(enabled: boolean): Plugin | null {
  if (!enabled) return null;

  return new Plugin({
    props: {
      handleKeyDown: (view, event) => {
        if (event.key !== 'Escape') return false;

        const transaction = leaveMathSelection(view.state);
        if (!transaction) return false;

        view.dispatch(transaction);
        return true;
      },
    },
  });
}

/**
 * Input rules for the notes body.
 *
 * Both patterns are registered, block first. Display maths is what a student writes
 * for a worked derivation and inline maths is what they write inside a sentence, so
 * the notes panel needs both — a student who can write `$x$` in a label and not in the
 * notes underneath it would reasonably read that as the app being broken.
 *
 * The order matters: the inline pattern would otherwise fire inside `$$…$$` and leave a
 * stray `$` behind.
 *
 * The known cost is that a bare `$5` becomes a formula. A stricter pattern that demands
 * a LaTeX-looking body would reject ordinary prose like `$x$ and $y$`, which is worse:
 * the student could type something correct and have it silently refuse.
 */
function buildBlockInputRules(schema: typeof blockSchema): Plugin {
  const displayMath = schema.nodes[nodeNames.mathDisplay];
  const inlineMath = schema.nodes[nodeNames.mathInline];

  const rules = [
    ...(displayMath ? [makeBlockMathInputRule(REGEX_BLOCK_MATH_DOLLARS, displayMath)] : []),
    ...(inlineMath ? [makeInlineMathInputRule(REGEX_INLINE_MATH_DOLLARS, inlineMath)] : []),
  ];

  return inputRules({ rules });
}

function buildBlockKeymap(options: BlockEditorOptions): Record<string, Command> {
  const handlers: Record<string, Command> = {
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
  };

  const toggle = (name: string): Command | undefined => {
    const type = blockSchema.marks[name];
    return type ? toggleMark(type) : undefined;
  };

  for (const [key, name] of [
    ['Mod-b', markNames.strong],
    ['Mod-i', markNames.em],
    ['Mod-e', markNames.code],
  ] as const) {
    const command = toggle(name);
    if (command) handlers[key] = command;
  }

  if (options.onExit) {
    const exit = options.onExit;
    handlers.Escape = () => {
      exit();
      return true;
    };
  }

  // Enter is deliberately left to `baseKeymap`, which splits the current block. There
  // is no node-level split in a notes panel.
  return handlers;
}

function buildInputRules(schema: typeof inlineSchema): Plugin {
  const inlineMath = schema.nodes[nodeNames.mathInline];

  // Only the inline schema is in play here, so only maths rules are safe to register.
  // Referencing a node the schema does not define makes the input rule plugin throw
  // on the first keystroke rather than at construction, which is a miserable thing
  // to debug. Block rules belong to the notes editor.
  const rules = inlineMath ? [makeInlineMathInputRule(REGEX_INLINE_MATH_DOLLARS, inlineMath)] : [];

  return inputRules({ rules });
}

/**
 * Keymap for the editor.
 *
 * The mindmap keys (`Tab`, `Enter`, `Escape`) are only bound here; what those keys
 * *mean* for the tree lives in the scene, because it owns the document model. The
 * commands below simply report the intent upward.
 */
function buildKeymap(options: EditorOptions): Record<string, Command> {
  const handlers: Record<string, Command> = {
    'Mod-z': undo,
    'Mod-y': redo,
    'Mod-Shift-z': redo,
  };

  // `toggleMark` takes a MarkType, not a name, so the schema is consulted and any
  // mark it does not define is skipped rather than silently bound to undefined.
  const toggle = (name: string): Command | undefined => {
    const type = inlineSchema.marks[name];
    return type ? toggleMark(type) : undefined;
  };

  for (const [key, name] of [
    ['Mod-b', markNames.strong],
    ['Mod-i', markNames.em],
    ['Mod-e', markNames.code],
  ] as const) {
    const command = toggle(name);
    if (command) handlers[key] = command;
  }

  if (options.onExit) {
    const exit = options.onExit;
    handlers.Escape = () => {
      exit();
      return true;
    };
  }

  if (options.onSplit) {
    const split = options.onSplit;
    handlers.Enter = chainCommands(
      newlineInCode,
      createParagraphNear,
      liftEmptyBlock,
      splitBlock,
      () => {
        // Reached only when the structural commands above declined, which for a
        // single-line label means the caret was not at the end.
        split();
        return true;
      },
    );
    handlers['Shift-Enter'] = chainCommands(
      newlineInCode,
      createParagraphNear,
      liftEmptyBlock,
      splitBlock,
    );
  }

  if (inlineSchema.nodes[nodeNames.mathInline]) {
    handlers['Mod-m'] = insertMathCmd(inlineSchema.nodes[nodeNames.mathInline]!);
  }

  return handlers;
}

/** Exported for tests that need to assert on a command's existence. */
export const editingCommands = {
  undo,
  redo,
  insertMath: (): Command | undefined =>
    inlineSchema.nodes[nodeNames.mathInline]
      ? insertMathCmd(inlineSchema.nodes[nodeNames.mathInline]!)
      : undefined,
  mathBackspace: mathBackspaceCmd,
};