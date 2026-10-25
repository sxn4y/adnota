/**
 * Shape and colour controls for the selected node.
 *
 * A separate component rather than more markup in `MindmapApp`, which is already carrying
 * the whole application shell. It takes the document and the selected id and does nothing
 * else, so the toolbar does not need to know how appearance is stored.
 *
 * The controls are always visible and disabled when nothing is selected, rather than
 * hidden. A student who selects a node and reaches for colour should find it where it was
 * last time, not have it appear and disappear.
 */

import { useCallback } from 'react';
import { setAppearance, type NodeId, type YDoc } from '@adnota/core';
import { COLOR_SLOTS, NODE_PALETTE, SHAPES, type NodeColorSlot } from '@adnota/scene';
import type { NodeShape } from '@adnota/core';

export interface NodeStyleControlProps {
  readonly doc: YDoc;
  readonly selectedId: NodeId | null;
  /** Called after a change so the caller re-lays out and re-renders. */
  readonly onChange: () => void;
}

/** Human labels. The document stores the key; the student sees a word. */
const COLOR_LABELS: Readonly<Record<NodeColorSlot, string>> = {
  neutral: 'Grey',
  accent: 'Blue',
  red: 'Red',
  amber: 'Amber',
  green: 'Green',
  violet: 'Violet',
};

const SHAPE_LABELS: Readonly<Record<NodeShape, string>> = {
  none: 'None',
  underline: 'Underline',
  box: 'Box',
  round: 'Round',
  pill: 'Pill',
};

export function NodeStyleControl({ doc, selectedId, onChange }: NodeStyleControlProps) {
  const disabled = selectedId === null;

  const apply = useCallback(
    (patch: { readonly shape?: NodeShape; readonly color?: NodeColorSlot }) => {
      // Guarded rather than asserted: these are disabled buttons, and a keyboard can still
      // reach a disabled control in some situations. Writing appearance to a null id would
      // be a silent no-op at best.
      if (selectedId === null) return;
      setAppearance(doc, selectedId, patch);
      onChange();
    },
    [doc, selectedId, onChange],
  );

  return (
    <div className="adnota-styles" role="group" aria-label="Appearance">
      <div className="adnota-swatches" role="group" aria-label="Colour">
        {COLOR_SLOTS.map((slot) => {
          const entry = NODE_PALETTE[slot];
          return (
            <button
              key={slot}
              type="button"
              className="adnota-swatch"
              disabled={disabled}
              onClick={() => apply({ color: slot })}
              aria-label={COLOR_LABELS[slot]}
              title={COLOR_LABELS[slot]}
              data-testid={`style-color-${slot}`}
              // Swapped in as inline style rather than CSS classes: the palette lives in
              // TypeScript, and duplicating six colours in the stylesheet is exactly the
              // drift this file is meant to avoid.
              style={{ background: entry.fill, borderColor: entry.stroke }}
            />
          );
        })}
      </div>

      <div className="adnota-shapes" role="group" aria-label="Shape">
        {SHAPES.map((shape) => (
          <button
            key={shape}
            type="button"
            disabled={disabled}
            onClick={() => apply({ shape })}
            aria-label={SHAPE_LABELS[shape]}
            title={SHAPE_LABELS[shape]}
            data-testid={`style-shape-${shape}`}
          >
            {SHAPE_LABELS[shape]}
          </button>
        ))}
      </div>
    </div>
  );
}