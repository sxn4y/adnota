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
import { EditorState, type Command, type Plugin } from 'prosemirror-state';
import {
  insertMathCmd,
  mathBackspaceCmd,
  mathPlugin,
  makeInlineMathInputRule,
  REGEX_INLINE_MATH_DOLLARS,
} from '@benrbray/prosemirror-math';
import type { InlineDoc } from '@adnota/core';
import { inlineDocToPm } from './convert.ts';
import { inlineSchema, markNames, nodeNames } from './schema.ts';

/**
 * Origin stamped on every transaction this module creates.
 *
 * The autosave layer marks the document dirty only for local origins, so this
 * symbol is what separates a student's typing from a collaborator's update.
 */
export const LOCAL_ORIGIN = Symbol('adnota.editor.local');

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
export const REMOTE_ORIGIN = Symbol('adnota.editor.remote');

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

export function createEditorState(options: EditorOptions): EditorState {
  const schema = inlineSchema;

  const plugins: Plugin[] = [
    mathPlugin,
    buildInputRules(schema),
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