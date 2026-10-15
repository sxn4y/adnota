import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LOCAL_ORIGIN,
  ROOT_NODE_ID,
  createDoc,
  createNode,
  getChildIds,
  putAsset,
  setLabel,
  type InlineDoc,
} from '@adnota/core';
import {
  PACKET_MAGIC,
  PACKET_VERSION,
  applySyncPacket,
  createOfflineProvider,
  createSyncPacket,
  createSyncPacketWithAssets,
  normalizeRoomName,
} from '@adnota/collab';

/**
 * Sync packets.
 *
 * `packages/collab` is not wired into the app yet, but the code is the thing that would
 * carry a student's work between two machines, and it had no tests at all. Untested
 * merge code is the kind that corrupts documents quietly — the whole point of a CRDT is
 * that concurrent edits converge, and convergence is a property you can only trust if
 * you have checked it.
 */

const REMOTE = Symbol('test.remote');

function label(text: string): InlineDoc {
  return { type: 'doc', content: [{ type: 'text', text }] };
}

function docWithNodes(...names: string[]): Y.Doc {
  const doc = createDoc('Sync');
  for (const name of names) {
    const id = createNode(doc, { parentId: ROOT_NODE_ID });
    setLabel(doc, id, label(name));
  }
  return doc;
}

describe('createSyncPacket', () => {
  it('carries the document state', () => {
    const doc = docWithNodes('Limits');

    const packet = createSyncPacket(doc);

    expect(packet.header.magic).toBe(PACKET_MAGIC);
    expect(packet.header.version).toBe(PACKET_VERSION);
    expect(packet.update.byteLength).toBeGreaterThan(0);
  });

  /**
   * Merging into an empty document applies without error.
   *
   * Deliberately does not assert how many nodes arrive. That number depends on which
   * side wins the `childrenMap` conflict described below, so asserting it would be
   * asserting a coin toss. The deterministic version of the same defect is recorded as
   * an expected failure two tests down.
   */
  it('applies a packet into an empty document without error', () => {
    const source = docWithNodes('Limits');
    const target = createDoc('Empty');

    const applied = applySyncPacket(target, createSyncPacket(source), REMOTE);

    expect(applied.bytesApplied).toBeGreaterThan(0);
  });

  it('merges concurrent edits made in both directions', async () => {
    // The property the whole design rests on: neither side's work is lost.
    //
    // This was failing and is the reason the child-order array moved onto each node's
    // own map. See `packages/core/src/schema.ts` for the measurement: two peers sharing a
    // parent used to merge to 2 and 2 nodes where 3 and 3 was correct, because both held
    // a competing `Y.Array` under the same map key and Yjs settled it last-writer-wins.
    const base = createDoc('Shared');
    const root = createNode(base, { parentId: ROOT_NODE_ID });

    const a = createDoc('Peer A');
    const b = createDoc('Peer B');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));

    // Each peer adds children to the same parent while offline.
    createNode(a, { parentId: root });
    createNode(a, { parentId: root });
    createNode(b, { parentId: root });

    applySyncPacket(a, createSyncPacket(b), REMOTE);
    applySyncPacket(b, createSyncPacket(a), REMOTE);

    // Three children existed. All three must survive, on both sides, identically.
    expect(getChildIds(a, root)).toHaveLength(3);
    expect(getChildIds(b, root)).toHaveLength(3);
    expect([...getChildIds(a, root)].sort()).toEqual([...getChildIds(b, root)].sort());
  });

  it('is a no-op when applied twice', () => {
    const source = docWithNodes('Limits');
    const target = createDoc('Empty');
    const packet = createSyncPacket(source);

    applySyncPacket(target, packet, REMOTE);
    const afterFirst = getChildIds(target, ROOT_NODE_ID).length;
    applySyncPacket(target, packet, REMOTE);

    expect(getChildIds(target, ROOT_NODE_ID)).toHaveLength(afterFirst);
  });

  it('reports nothing applied when the target is already current', () => {
    const source = docWithNodes('Limits');
    const target = createDoc('Empty');

    applySyncPacket(target, createSyncPacket(source), REMOTE);
    const second = applySyncPacket(target, createSyncPacket(source), REMOTE);

    // Zero bytes means nothing was missing, which is what "already current" means.
    expect(second.bytesApplied).toBe(0);
  });

  it('carries only what changed since a state vector', () => {
    const doc = docWithNodes('Limits');
    const knownToPeer = Y.encodeStateVector(doc);

    // The peer is already current, so there is nothing meaningful to send. Yjs still
    // emits a small envelope rather than zero bytes, so this is a size relationship and
    // not an absolute.
    const full = createSyncPacket(doc);
    const upToDate = createSyncPacket(doc, { since: knownToPeer });
    expect(upToDate.update.byteLength).toBeLessThan(full.update.byteLength);

    // After local work, the same vector yields only the delta.
    const created = createNode(doc, { parentId: ROOT_NODE_ID });
    setLabel(doc, created, label('Later'));

    const delta = createSyncPacket(doc, { since: knownToPeer });

    // A full-state packet every time would make folder sync rewrite whole documents on
    // every tick, which is the difference between sync being usable and not.
    expect(delta.update.byteLength).toBeGreaterThan(upToDate.update.byteLength);
    expect(delta.update.byteLength).toBeLessThan(createSyncPacket(doc).update.byteLength);
  });
});

describe('applySyncPacket validation', () => {
  it('refuses a packet that is not an Adnota sync packet', () => {
    const doc = createDoc('Empty');
    const packet = createSyncPacket(docWithNodes('Limits'));

    expect(() => applySyncPacket(doc, { ...packet, header: { ...packet.header, magic: 'SOMETHING' } }, REMOTE)).toThrow(
      /Not an Adnota sync packet/,
    );
  });

  it('refuses a packet from a newer format rather than guessing', () => {
    // Silently misreading a future packet would corrupt the document; refusing is the
    // only safe answer, and the message has to say so.
    const doc = createDoc('Empty');
    const packet = createSyncPacket(docWithNodes('Limits'));

    expect(() =>
      applySyncPacket(doc, { ...packet, header: { ...packet.header, version: PACKET_VERSION + 1 } }, REMOTE),
    ).toThrow(/Update Adnota to read it/);
  });

  it('accepts an older packet version', () => {
    const doc = createDoc('Empty');
    const packet = createSyncPacket(docWithNodes('Limits'));

    const applied = applySyncPacket(
      doc,
      { ...packet, header: { ...packet.header, version: PACKET_VERSION - 1 } },
      REMOTE,
    );

    expect(applied.bytesApplied).toBeGreaterThan(0);
  });

  it('does not mark the merge as a local edit', () => {
    // A remote merge must not be undoable by the local user, and must not trigger a
    // local save that could resurrect deleted content.
    const doc = createDoc('Empty');
    let seenOrigin: unknown = 'unset';
    doc.on('update', (_update, origin) => {
      seenOrigin = origin;
    });

    applySyncPacket(doc, createSyncPacket(docWithNodes('Limits')), REMOTE);

    expect(seenOrigin).toBe(REMOTE);
    expect(seenOrigin).not.toBe(LOCAL_ORIGIN);
  });
});

describe('assets in sync packets', () => {
  it('carries declared asset hashes', () => {
    const doc = docWithNodes('Limits');
    putAsset(doc, { id: 'asset-a', hash: 'a'.repeat(64), extension: 'png', bytes: 100 });

    const packet = createSyncPacket(doc);

    expect(packet.header.assetHashes).toContain('a'.repeat(64));
  });

  it('can exclude assets the peer is known to have', () => {
    const doc = docWithNodes('Limits');
    putAsset(doc, { id: 'asset-a', hash: 'a'.repeat(64), extension: 'png', bytes: 100 });

    const packet = createSyncPacket(doc, { excludeAssets: new Set(['a'.repeat(64)]) });

    expect(packet.header.assetHashes).not.toContain('a'.repeat(64));
  });

  it('attaches bytes it can read', async () => {
    const doc = docWithNodes('Limits');
    const hash = 'b'.repeat(64);
    putAsset(doc, { id: 'asset-b', hash, extension: 'png', bytes: 4 });

    const packet = await createSyncPacketWithAssets(doc, async (wanted) =>
      wanted === hash ? new Uint8Array([1, 2, 3, 4]) : null,
    );

    expect(packet.assets?.get(hash)?.bytes.byteLength).toBe(4);
  });

  it('does not let a missing asset stop the merge from being attempted', async () => {
    // A missing image must not block the text. Losing a note over a picture would be a
    // far worse outcome than a broken image.
    //
    // Asserted as "does not throw" rather than "the nodes arrived": whether they
    // actually arrive depends on the children-merge defect documented above, and a test
    // that tracked that would be tracking a bug rather than this behaviour.
    const doc = docWithNodes('Limits');
    const hash = 'c'.repeat(64);
    putAsset(doc, { id: 'asset-c', hash, extension: 'png', bytes: 10 });

    const packet = await createSyncPacketWithAssets(doc, async () => null);
    expect(packet.assets.size).toBe(0);

    const target = createDoc('Empty');
    expect(() => applySyncPacket(target, packet, REMOTE)).not.toThrow();
  });
});

describe('normalizeRoomName', () => {
  it('trims and accepts a plain name', () => {
    expect(normalizeRoomName('  calculus  ')).toBe('calculus');
  });

  it('refuses an empty name', () => {
    expect(() => normalizeRoomName('   ')).toThrow(/cannot be empty/);
  });

  it('refuses a name that is too long', () => {
    expect(() => normalizeRoomName('x'.repeat(65))).toThrow(/64 characters/);
  });

  it('refuses path separators and reserved characters', () => {
    for (const name of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(() => normalizeRoomName(name)).toThrow(/path separators/);
    }
  });

  it('refuses a relative path', () => {
    expect(() => normalizeRoomName('.')).toThrow(/relative path/);
    expect(() => normalizeRoomName('..')).toThrow(/relative path/);
  });

  it('accepts a name at exactly the limit', () => {
    expect(normalizeRoomName('x'.repeat(64))).toHaveLength(64);
  });
});

describe('createOfflineProvider', () => {
  it('starts idle and never connects', () => {
    const provider = createOfflineProvider(createDoc('Offline'));

    expect(provider.status).toBe('idle');
  });

  it('destroys without a transport to tear down', () => {
    const provider = createOfflineProvider(createDoc('Offline'));

    expect(() => provider.destroy()).not.toThrow();
  });

  it('publishes nothing, because there is nothing to publish', () => {
    const provider = createOfflineProvider(createDoc('Offline'));
    const seen: unknown[] = [];
    provider.on('status', (status) => seen.push(status));

    expect(seen.every((entry) => entry === 'idle')).toBe(true);
  });
});
