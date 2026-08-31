/*
 * BrightTable // Copyright (C) 2026 Rob Brown
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createTag, listTags, tagAssets, type TagSummary } from '../lib/api';

// Small fixed palette for the "New tag" create row - Immich's TagCreateDto
// accepts any hex color, but a free-form color picker is more UI than this
// pass needs; a preset row (plus "no color") covers the common case. Shared
// with TagsBrowser.tsx's own inline "+ New Tag" create row so both places
// offer the same swatches.
export const TAG_COLORS = [
  '#e01b24', '#ff7800', '#e5a50a', '#2ec27e',
  '#3584e4', '#9141ac', '#f66151', '#77767b',
];

// A tag not yet created server-side - queued by the "New tag name" row until
// Assign actually calls createTag for it. `tempId` is a client-only key
// (nothing to do with the real tag id it gets once created).
interface PendingNewTag {
  tempId: string;
  name: string;
  color: string | null;
}

// Modal for adding the current selection to one or more tags - opened from
// SelectionBar's "Add to Tag" button and the equivalent context-menu item.
// Nothing is actually assigned (or even created, for a brand new tag) until
// Assign is clicked: clicking an existing tag below toggles it into a
// pending list rather than assigning immediately, and "Add" on the new-tag
// row queues a not-yet-created tag the same way - so Cancel (or the ✕, or
// clicking outside) truly does nothing at all, matching AlbumsBrowser's
// "nothing happens until you confirm" convention elsewhere in this app.
//
// Currently unreachable in practice: every entry point that would open this
// (SelectionBar's button, each browser's context-menu item, the `addToTag`
// shortcut) is greyed out/disabled via TAG_ASSIGN_DISABLED_REASON (see
// lib/featureFlags.ts) because of a known Immich server-side bug where tag
// assignment reports success but doesn't persist - not a bug in this dialog
// or in tagAssets/createTag below. Once that constant is nulled out (fixed
// upstream), this component itself needs no changes.
export default function AddToTagDialog({
  assetIds,
  onClose,
  onAdded,
}: {
  assetIds: string[];
  onClose: () => void;
  onAdded?: (tagId: string, tagName: string) => void;
}) {
  const [tags, setTags] = useState<TagSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string | null>(null);
  const [pendingExisting, setPendingExisting] = useState<Set<string>>(new Set());
  const [pendingNew, setPendingNew] = useState<PendingNewTag[]>([]);
  const [assigning, setAssigning] = useState(false);
  const nextTempId = useRef(0);

  useEffect(() => {
    listTags()
      .then(setTags)
      .catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    if (!tags) return [];
    const q = search.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, search]);

  const count = assetIds.length;
  const totalPending = pendingExisting.size + pendingNew.length;

  function toggleExisting(id: string) {
    setPendingExisting((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleQueueNewTag() {
    const name = newName.trim();
    if (!name) return;
    nextTempId.current += 1;
    setPendingNew((p) => [...p, { tempId: `new-${nextTempId.current}`, name, color: newColor }]);
    setNewName('');
    setNewColor(null);
  }

  async function handleAssign() {
    if (totalPending === 0) return;
    setAssigning(true);
    setError(null);
    try {
      const created = await Promise.all(pendingNew.map((p) => createTag(p.name, p.color)));
      const targets: { id: string; name: string }[] = [
        ...[...pendingExisting].map((id) => ({ id, name: tags?.find((t) => t.id === id)?.name ?? id })),
        ...created.map((t) => ({ id: t.id, name: t.name })),
      ];
      await Promise.all(targets.map((t) => tagAssets(t.id, assetIds)));
      for (const t of targets) onAdded?.(t.id, t.name);
      onClose();
    } catch (e) {
      setError(String(e));
      setAssigning(false);
    }
  }

  return (
    <div
      className="window-frame window-frame-overlay"
      style={{
        zIndex: 300,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={assigning ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: '92%',
          height: 560,
          maxHeight: '86%',
          background: 'var(--dialog-bg)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
          border: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 0 18px', background: 'var(--panel)', borderBottom: '1px solid rgba(0,0,0,0.4)' }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Add to Tag</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>· {count} selected</span>
          <div style={{ flex: 1 }} />
          <div
            onClick={assigning ? undefined : onClose}
            style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--overlay-medium)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', fontSize: 14, opacity: assigning ? 0.5 : 1 }}
          >
            ✕
          </div>
        </div>

        <div style={{ flexShrink: 0, padding: '14px 18px 12px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tags…" style={inputStyle} />
        </div>

        <div style={{ flexShrink: 0, padding: '12px 18px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleQueueNewTag();
              }}
              placeholder="New tag name…"
              style={inputStyle}
            />
            <button onClick={handleQueueNewTag} disabled={!newName.trim()} style={btnPrimary(!!newName.trim())}>
              Add
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {TAG_COLORS.map((c) => (
              <div
                key={c}
                onClick={() => setNewColor(newColor === c ? null : c)}
                title={c}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: c,
                  cursor: 'default',
                  boxShadow: newColor === c ? '0 0 0 2px var(--dialog-bg), 0 0 0 4px var(--border-strong)' : '0 0 0 1px var(--border-strong)',
                }}
              />
            ))}
          </div>
        </div>

        {totalPending > 0 && (
          <div style={{ flexShrink: 0, padding: '10px 18px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 10.5, letterSpacing: '.06em', color: 'var(--text-dimmer)', marginBottom: 8 }}>TO ASSIGN</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {[...pendingExisting].map((id) => {
                const t = tags?.find((x) => x.id === id);
                return <PendingChip key={id} color={t?.color ?? null} name={t?.name ?? id} onRemove={() => toggleExisting(id)} />;
              })}
              {pendingNew.map((p) => (
                <PendingChip
                  key={p.tempId}
                  color={p.color}
                  name={p.name}
                  onRemove={() => setPendingNew((cur) => cur.filter((x) => x.tempId !== p.tempId))}
                />
              ))}
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: '10px 10px 14px', minHeight: 0 }}>
          {error && <div style={{ fontSize: 12, color: 'var(--danger)', padding: '4px 8px 10px' }}>{error}</div>}
          {!tags && !error && <div style={{ padding: '20px 8px', color: 'var(--text-dimmer)', fontSize: 13 }}>Loading tags…</div>}
          {tags && filtered.length === 0 && (
            <div style={{ padding: '20px 8px', color: 'var(--text-dimmer)', fontSize: 13 }}>
              {tags.length === 0 ? 'No tags yet — add one above.' : 'No tags match your search.'}
            </div>
          )}
          {filtered.map((t) => {
            const isPending = pendingExisting.has(t.id);
            return (
              <div
                key={t.id}
                onClick={() => toggleExisting(t.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  height: 44,
                  padding: '0 8px',
                  borderRadius: 9,
                  cursor: 'default',
                  background: isPending ? 'rgba(53,132,228,0.14)' : 'transparent',
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    flexShrink: 0,
                    border: isPending ? 'none' : '1.5px solid var(--border-strong)',
                    background: isPending ? 'var(--accent)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    color: '#fff',
                  }}
                >
                  {isPending && '✓'}
                </div>
                <div style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0, background: t.color ?? 'var(--text-dimmer)' }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t.name}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid rgba(0,0,0,0.3)' }}>
          <button onClick={onClose} disabled={assigning} style={btnSecondary}>
            Cancel
          </button>
          <button onClick={handleAssign} disabled={assigning || totalPending === 0} style={btnPrimary(!assigning && totalPending > 0)}>
            {assigning ? 'Assigning…' : totalPending > 0 ? `Assign (${totalPending})` : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PendingChip({ color, name, onRemove }: { color: string | null; name: string; onRemove: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 6px 4px 9px',
        borderRadius: 999,
        background: 'var(--overlay-medium)',
        fontSize: 12,
      }}
    >
      <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: color ?? 'var(--text-dimmer)' }} />
      {name}
      <div
        onClick={onRemove}
        title="Remove"
        style={{ cursor: 'default', color: 'var(--text-dimmer)', fontSize: 11, padding: '0 2px' }}
      >
        ✕
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  flex: 1,
  height: 34,
  padding: '0 12px',
  background: 'var(--surface-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 9,
  color: 'var(--text)',
  fontSize: 13,
};

const btnBase: CSSProperties = {
  height: 34,
  padding: '0 16px',
  borderRadius: 9,
  border: 'none',
  fontSize: 12.5,
  cursor: 'default',
  whiteSpace: 'nowrap',
};

const btnSecondary: CSSProperties = {
  ...btnBase,
  border: '1px solid var(--border-strong)',
  background: 'var(--overlay-weak)',
  color: 'var(--text)',
};

function btnPrimary(enabled: boolean): CSSProperties {
  return {
    ...btnBase,
    background: '#3584e4',
    color: '#fff',
    fontWeight: 700,
    opacity: enabled ? 1 : 0.5,
    pointerEvents: enabled ? 'auto' : 'none',
  };
}
