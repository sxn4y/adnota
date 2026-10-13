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
  setBlockType,
  splitBlock,
  toggleMark,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { EditorState, type Command, type Plugin } from 'prosemirror-state';
import {
  insertMathCmd,
  mathBackspaceCmd,
  mathPlugin,
  makeBlockMathInputRule,
  makeInlineMathInputRule,
  REGEX_BLOCK_MATH_DOLLARS,
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

  // `filterTransaction` is the single place that decides what counts as a local edit,
  // so autosave cannot be told about transactions that are not the student's own.
  const filterTransaction = (transaction: {
    getMeta: (key: unknown) => unknown;
    docChanged: boolean;
  }): boolean => {
    if (!transaction.docChanged) return true;
    return transaction.getMeta(LOCAL_ORIGIN) === true;
  };

  return EditorState.create({
    doc: inlineDocToPm(options.doc, schema),
    schema,
    plugins,
    filterTransaction,
  });
}

function buildInputRules(schema: typeof inlineSchema): Plugin {
  const inlineMath = schema.nodes[nodeNames.mathInline];
  const displayMath = schema.nodes[nodeNames.mathDisplay];

  return inputRules({
    rules: [
      ...(inlineMath
        ? [makeInlineMathInputRule(REGEX_INLINE_MATH_DOLLARS, inlineMath)]
        : []),
      ...(displayMath
        ? [makeBlockMathInputRule(REGEX_BLOCK_MATH_DOLLARS, displayMath)]
        : []),
      // `**bold**` and `- list item` cover the markdown a student is likely to paste
      // or type by reflex. Both are cheap and disappear entirely if they misfire,
      // since the underlying text remains.
      textblockTypeInputRule(/^```$/, schema.nodes.code_block),
      wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
      wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
    ],
  });
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

    'Mod-b': toggleMark(markNames.strong),
    'Mod-i': toggleMark(markNames.em),
    'Mod-e': toggleMark(markNames.code),
  };

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

/** Export for tests that need to assert on a command's existence. */
export const editingCommands = {
  undo,
  redo,
  insertMath: (): Command | undefined =>
    inlineSchema.nodes[nodeNames.mathInline]
      ? insertMathCmd(inlineSchema.nodes[nodeNames.mathInline]!)
      : undefined,
  mathBackspace: mathBackspaceCmd,
  setBlockType,
};