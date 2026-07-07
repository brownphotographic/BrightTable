import { useEffect, useState } from 'react';
import { getStack, type AssetSummary } from '../lib/api';
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
  resolveAsset,
}: {
  stackId: string;
  selected: Set<string>;
  onSelectMember: (id: string) => void;
  onOpen: (id: string) => void;
  onCollapse: () => void;
  onUnstack: (memberIds: string[]) => Promise<void>;
  onSetPick: (assetId: string, memberIds: string[]) => Promise<void>;
  onRate: (assetId: string, rating: number) => Promise<void>;
  // Resolves a known member id to its live AssetSummary from the browser's
  // reactive asset cache. Members are displayed through this (falling back
  // to the one-time getStack() snapshot only if a bucket isn't loaded) so
  // that an edit made through *any* path - a click here, the Metadata panel,
  // or a keyboard shortcut in the main grid (which patches assetCache
  // directly, bypassing this component entirely) - shows up immediately
  // instead of only after the stack is collapsed and re-expanded.
  resolveAsset: (id: string) => AssetSummary | undefined;
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
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.09)',
        borderRadius: 12,
        padding: '12px 14px',
        margin: '2px 0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <div style={{ position: 'relative', width: 14, height: 13, flexShrink: 0 }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: 9, height: 9, border: '1.6px solid #dc8add', borderRadius: 2 }} />
          <div style={{ position: 'absolute', left: 4, top: 3, width: 9, height: 9, border: '1.6px solid #dc8add', borderRadius: 2, background: '#1c1c1c' }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{primary?.fileName ?? 'Stack'}</span>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.42)' }}>
          Stack · {members?.length ?? '…'} · Set Pick sets the pick
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={handleUnstack}
          disabled={busy || !members}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 12px',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.05)',
            color: '#fff',
            fontSize: 12,
            cursor: 'default',
            opacity: busy ? 0.6 : 1,
          }}
        >
          Unstack
        </button>
        <button
          onClick={onCollapse}
          style={{
            height: 28,
            padding: '0 12px',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.05)',
            color: '#fff',
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
                />
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
