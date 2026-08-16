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

import { useEffect, useState } from 'react';
import { checkSidecarMetadata, getStack, type AssetSummary } from '../lib/api';
import { overlayRawOverrides, useRawOverrides } from '../lib/rawOverrides';
import AssetTile from './AssetTile';

// Full-width band substituted in place of a stack's collapsed tile when
// expanded - matches the design prototype's inline expand/collapse, minus
// drag-to-reorder (Immich has no server-side concept of member order, only
// a single primaryAssetId - see the Stage 1 plan). Always fetches the
// authoritative member list on mount rather than trying to reuse partial
// data from wherever the primary tile came from.
export default function StackBand({
  stackId,
  selected,
  onSelectMember,
  onOpen,
  onCollapse,
  onUnstack,
  onSetPick,
  onRate,
  onContextMenu,
  resolveAsset,
  loupeMode,
  onHoverAsset,
}: {
  stackId: string;
  selected: Set<string>;
  onSelectMember: (id: string) => void;
  onOpen: (id: string) => void;
  onCollapse: () => void;
  onUnstack: (memberIds: string[]) => Promise<void>;
  onSetPick: (assetId: string, memberIds: string[]) => Promise<void>;
  onRate: (assetId: string, rating: number) => Promise<void>;
  // Previously omitted entirely - a stack member (including the pick, once
  // its band is expanded) had no right-click menu at all, unlike every plain
  // or collapsed-pick tile. Harmless while the menu only had Stack/Unstack/
  // Sync Metadata (this band already has its own Unstack button and
  // per-member Set Pick/rating controls), but Copy/Paste Image Processing
  // and Copy/Paste Metadata have no other in-band entry point, so the gap
  // became a real, common-case dead end - found live by the user testing
  // Copy Image Processing on a stacked asset.
  onContextMenu?: (id: string, x: number, y: number) => void;
  // Resolves a known member id to its live AssetSummary from the browser's
  // reactive asset cache. Members are displayed through this (falling back
  // to the one-time getStack() snapshot only if a bucket isn't loaded) so
  // that an edit made through *any* path - a click here, the Metadata panel,
  // or a keyboard shortcut in the main grid (which patches assetCache
  // directly, bypassing this component entirely) - shows up immediately
  // instead of only after the stack is collapsed and re-expanded.
  resolveAsset: (id: string) => AssetSummary | undefined;
  // Grid loupe mode: members stay hoverable into the loupe pane and the
  // Collapse button (the requirement-4 "close stacks" exception) stays live,
  // but Unstack/Set Pick and each member's own select/open/rate are hidden.
  loupeMode?: boolean;
  onHoverAsset?: (id: string | null) => void;
}) {
  const [memberIds, setMemberIds] = useState<string[] | null>(null);
  const [fallbackById, setFallbackById] = useState<Map<string, AssetSummary>>(new Map());
  const [fallbackPrimaryId, setFallbackPrimaryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { overrideIds } = useRawOverrides();

  useEffect(() => {
    let cancelled = false;
    getStack(stackId)
      .then((stack) => {
        if (cancelled) return;
        const overlaid = overlayRawOverrides(stack.assets, overrideIds);
        setMemberIds(overlaid.map((a) => a.id));
        setFallbackById(new Map(overlaid.map((a) => [a.id, a])));
        setFallbackPrimaryId(stack.primaryAssetId);
        // getStack() returns Immich's own asset data, which has no notion of
        // hasProcessingSidecar - that's this app's own local-disk scan, only
        // ever run by the main per-bucket fetch. A member whose own
        // folder/bucket hasn't independently loaded (so `resolveAsset` can't
        // find it and every member here falls back to this snapshot) would
        // otherwise permanently read as "no processing sidecar" - Copy Image
        // Processing silently hidden for a member with a real .arp/.pp3 on
        // disk. Re-runs the same scan here, scoped to just this stack.
        checkSidecarMetadata(
          overlaid
            .filter((a) => a.originalPath)
            .map((a) => ({
              assetId: a.id,
              originalPath: a.originalPath,
              currentRating: a.rating,
              currentDescription: a.description,
            })),
        )
          .then((results) => {
            if (cancelled || !results.length) return;
            setFallbackById((m) => {
              const next = new Map(m);
              for (const r of results) {
                const existing = next.get(r.assetId);
                if (!existing) continue;
                next.set(r.assetId, {
                  ...existing,
                  hasProcessingSidecar: r.hasProcessingSidecar,
                  processingSidecarTools: r.processingSidecarTools,
                });
              }
              return next;
            });
          })
          .catch(() => {});
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackId]);

  const members = memberIds
    ? memberIds.map((id) => resolveAsset(id) ?? fallbackById.get(id)).filter((a): a is AssetSummary => !!a)
    : null;
  const primaryAssetId = members?.[0]?.stack?.primaryAssetId ?? fallbackPrimaryId;
  const primary = members?.find((a) => a.id === primaryAssetId);

  async function handleUnstack() {
    if (!members) return;
    setBusy(true);
    try {
      await onUnstack(members.map((m) => m.id));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function handleSetPick(assetId: string) {
    if (assetId === primaryAssetId || !members) return;
    setBusy(true);
    try {
      await onSetPick(
        assetId,
        members.map((m) => m.id),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRate(assetId: string, rating: number) {
    try {
      await onRate(assetId, rating);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div
      style={{
        gridColumn: '1 / -1',
        background: 'var(--overlay-weak)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '12px 14px',
        color: 'var(--text)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <div style={{ position: 'relative', width: 14, height: 13, flexShrink: 0 }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: 9, height: 9, border: '1.6px solid #dc8add', borderRadius: 2 }} />
          <div style={{ position: 'absolute', left: 4, top: 3, width: 9, height: 9, border: '1.6px solid #dc8add', borderRadius: 2, background: 'var(--canvas)' }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{primary?.fileName ?? 'Stack'}</span>
        <span style={{ fontSize: 12, color: 'var(--text-dimmer)' }}>
          Stack · {members?.length ?? '…'} · Set Pick sets the pick
        </span>
        <div style={{ flex: 1 }} />
        {!loupeMode && (
          <button
            onClick={handleUnstack}
            disabled={busy || !members}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 12px',
              border: '1px solid var(--border-strong)',
              borderRadius: 8,
              background: 'var(--overlay-weak)',
              color: 'var(--text)',
              fontSize: 12,
              cursor: 'default',
              opacity: busy ? 0.6 : 1,
            }}
          >
            Unstack
          </button>
        )}
        <button
          onClick={onCollapse}
          style={{
            height: 28,
            padding: '0 12px',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            background: 'var(--overlay-weak)',
            color: 'var(--text)',
            fontSize: 12,
            cursor: 'default',
          }}
        >
          Collapse
        </button>
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 10 }}>{error}</div>}

      {!members ? (
        <div style={{ color: 'var(--text-dimmer)', fontSize: 12.5 }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {members.map((m) => {
            const isPick = m.id === primaryAssetId;
            return (
              <div
                key={m.id}
                style={{
                  position: 'relative',
                  width: 152,
                  aspectRatio: '3 / 2',
                  flexShrink: 0,
                  borderRadius: 10,
                  padding: 2,
                  background: isPick ? '#f5c518' : 'transparent',
                }}
              >
                <AssetTile
                  asset={m}
                  selected={selected.has(m.id)}
                  onToggleSelect={() => onSelectMember(m.id)}
                  onToggleOne={() => onSelectMember(m.id)}
                  onOpen={onOpen}
                  onRate={handleRate}
                  onContextMenu={onContextMenu}
                  loupeMode={loupeMode}
                  onHoverAsset={onHoverAsset}
                />
                {!loupeMode && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSetPick(m.id);
                    }}
                    disabled={isPick}
                    title={isPick ? 'Stack pick' : 'Set as stack pick'}
                    style={{
                      position: 'absolute',
                      top: 4,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      height: 20,
                      padding: '0 8px',
                      borderRadius: 10,
                      border: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'default',
                      fontSize: 10.5,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      background: isPick ? '#f5c518' : 'rgba(0,0,0,0.6)',
                      color: isPick ? '#1c1c1c' : '#fff',
                    }}
                  >
                    {isPick ? 'Pick' : 'Set Pick'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
