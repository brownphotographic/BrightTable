import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getStack, type AssetSummary } from '../lib/api';
import { isRawAsset } from '../lib/filters';
import { agGroups, mergeExistingStacks, TOL, toleranceSeconds, type SmartStackGroup, type SmartStackMode } from '../lib/smartStack';
import { useSmartStackSettings } from '../lib/smartStackSettings';
import { overlayRawOverrides, useRawOverrides } from '../lib/rawOverrides';
import AssetThumbImage from './AssetThumb';

const MODE_DESC: Record<SmartStackMode, string> = {
  name: 'Groups files that share a base name but differ by extension — e.g. IMG_4471.ARW + IMG_4471.JPG.',
  version: 'Groups a source image with renditions whose name matches the pattern below. Use * as a wildcard — e.g. *converted* matches "converted" anywhere in the name, regardless of spacing or punctuation. Saved as an ordinary Immich stack.',
  time: 'Groups frames captured within the chosen time tolerance of one another.',
};

// Modal dialog for Smart Stack auto-grouping, ported from the design
// prototype's autoGroup dialog (Immich Desktop.dc.html lines 840-900). Mode/
// suffix/tolerance live in SmartStackSettingsProvider (persisted across
// restarts, unlike the prototype's in-memory-only state) - every edit here
// updates the live preview and saves at the same time.
export default function SmartStackDialog({
  candidateAssets,
  onClose,
  onApply,
}: {
  candidateAssets: AssetSummary[];
  onClose: () => void;
  onApply: (groups: SmartStackGroup[]) => Promise<void>;
}) {
  const { settings, setSettings } = useSmartStackSettings();
  const { overrideIds } = useRawOverrides();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Full member lists for any already-existing stack referenced by a match
  // below, fetched lazily as new ones show up - see mergeExistingStacks for
  // why an already-stacked asset in the selection isn't simply skipped.
  const [existingStackMembers, setExistingStackMembers] = useState<Map<string, AssetSummary[]>>(new Map());

  const baseGroups = useMemo(
    () => agGroups(candidateAssets, settings.mode, settings.suffix, toleranceSeconds(settings.tolerance)),
    [candidateAssets, settings],
  );

  const referencedStackIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of baseGroups) for (const m of g.members) if (m.stack) ids.add(m.stack.id);
    return ids;
  }, [baseGroups]);

  useEffect(() => {
    const missing = [...referencedStackIds].filter((id) => !existingStackMembers.has(id));
    if (!missing.length) return;
    let cancelled = false;
    Promise.all(missing.map((id) => getStack(id).then((s) => [id, overlayRawOverrides(s.assets, overrideIds)] as const)))
      .then((pairs) => {
        if (cancelled) return;
        setExistingStackMembers((m) => {
          const next = new Map(m);
          for (const [id, assets] of pairs) next.set(id, assets);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referencedStackIds]);

  const groups = useMemo(
    () => mergeExistingStacks(baseGroups, settings.mode, existingStackMembers),
    [baseGroups, settings.mode, existingStackMembers],
  );

  const selN = candidateAssets.length;
  const emptyText =
    selN < 2 ? 'Select two or more photos in the grid, then choose Smart Stack.' : 'No groups match these settings — try another mode or widen the tolerance.';

  async function handleApply() {
    if (!groups.length) return;
    setBusy(true);
    setError(null);
    try {
      await onApply(groups);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={busy ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 600,
          maxWidth: '94%',
          height: 600,
          maxHeight: '92%',
          background: '#242424',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: 50,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 10px 0 18px',
            background: '#303030',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Smart Stack</span>
          <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.4)' }}>· {selN} selected</span>
          <div style={{ flex: 1 }} />
          <div
            onClick={busy ? undefined : onClose}
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'default',
              fontSize: 14,
            }}
          >
            ✕
          </div>
        </div>

        <div style={{ flexShrink: 0, padding: '18px 22px 16px', borderBottom: '1px solid rgba(0,0,0,0.3)' }}>
          <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'rgba(255,255,255,0.45)', marginBottom: 8 }}>GROUP BY</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {(['name', 'version', 'time'] as SmartStackMode[]).map((m) => (
              <div key={m} onClick={() => setSettings({ ...settings, mode: m })} style={segStyle(settings.mode === m)}>
                {m === 'name' ? 'Name' : m === 'version' ? 'Version' : 'Time'}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5, minHeight: 36 }}>{MODE_DESC[settings.mode]}</div>

          {settings.mode === 'version' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
              <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', flexShrink: 0 }}>Version pattern</span>
              <input
                value={settings.suffix}
                onChange={(e) => setSettings({ ...settings, suffix: e.target.value })}
                placeholder="*converted*"
                style={{
                  flex: 1,
                  height: 34,
                  padding: '0 12px',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 9,
                  color: '#fff',
                  font: '500 13px ui-monospace,monospace',
                }}
              />
            </div>
          )}

          {settings.mode === 'time' && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>Time tolerance</span>
                <span style={{ font: '600 13px ui-monospace,monospace', color: '#7fb0f0' }}>
                  Within {formatTolerance(toleranceSeconds(settings.tolerance))}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={TOL.length - 1}
                step={1}
                value={settings.tolerance}
                onChange={(e) => setSettings({ ...settings, tolerance: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'rgba(255,255,255,0.35)', marginTop: 5 }}>
                <span>{formatTolerance(TOL[0])}</span>
                <span>{formatTolerance(TOL[TOL.length - 1])}</span>
              </div>
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '16px 22px', minHeight: 0 }}>
          <div style={{ fontSize: 11, letterSpacing: '.05em', color: 'rgba(255,255,255,0.45)', marginBottom: 12 }}>PREVIEW · {groups.length} GROUPS</div>
          {groups.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', padding: '48px 20px', fontSize: 13, lineHeight: 1.6 }}>{emptyText}</div>
          ) : (
            groups.map((g) => <GroupCard key={g.key} group={g} mode={settings.mode} />)
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', borderTop: '1px solid rgba(0,0,0,0.4)', flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
            Grouping {selN} selected photo{selN === 1 ? '' : 's'}. Already-stacked photos are merged into the new
            group, not skipped.
          </span>
          <div style={{ flex: 1 }} />
          {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
          <button onClick={busy ? undefined : onClose} disabled={busy} style={btnSecondary}>
            Cancel
          </button>
          <button onClick={handleApply} disabled={busy || groups.length === 0} style={btnPrimary(groups.length > 0 && !busy)}>
            {busy ? 'Working…' : `Create ${groups.length} Stack${groups.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupCard({ group, mode }: { group: SmartStackGroup; mode: SmartStackMode }) {
  const pick = group.members.find((m) => m.id === group.pickId);
  let title: string;
  let sub: string;
  if (mode === 'name') {
    title = group.key;
    sub = group.members.map((m) => m.fileExtension).join(' + ');
  } else if (mode === 'version') {
    title = group.key;
    sub = `${group.members.length} renditions · pick ${pick?.fileName ?? ''}`;
  } else {
    const earliest = group.members.find((m) => m.id === group.pickId) ?? group.members[0];
    title = new Date(earliest.fileCreatedAt).toLocaleTimeString();
    sub = `${group.members.length} frames`;
  }

  return (
    <div style={{ background: '#262626', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}>
        <div style={{ position: 'relative', width: 14, height: 13, flexShrink: 0 }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: 9, height: 9, border: '1.6px solid #dc8add', borderRadius: 2 }} />
          <div style={{ position: 'absolute', left: 4, top: 3, width: 9, height: 9, border: '1.6px solid #dc8add', borderRadius: 2, background: '#262626' }} />
        </div>
        <span style={{ font: '600 13px ui-monospace,monospace' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.42)' }}>{sub}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {group.members.map((m) => {
          const isPick = m.id === group.pickId;
          const isRaw = isRawAsset(m);
          return (
            <div
              key={m.id}
              style={{
                position: 'relative',
                height: 58,
                aspectRatio: '3 / 2',
                borderRadius: 6,
                overflow: 'hidden',
                flexShrink: 0,
                background: '#1c1c1c',
                boxShadow: isPick ? '0 0 0 2px #3584e4' : '0 0 0 1px rgba(255,255,255,0.1)',
              }}
            >
              <AssetThumbImage asset={m} />
              {isPick && (
                <div
                  style={{
                    position: 'absolute',
                    top: 3,
                    left: 3,
                    width: 15,
                    height: 15,
                    borderRadius: '50%',
                    background: '#3584e4',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <div
                    style={{
                      width: 4,
                      height: 2.5,
                      borderLeft: '1.2px solid #fff',
                      borderBottom: '1.2px solid #fff',
                      transform: 'rotate(-45deg) translateY(-0.5px)',
                    }}
                  />
                </div>
              )}
              {m.fileExtension && (
                <div
                  style={{
                    position: 'absolute',
                    right: 4,
                    bottom: 4,
                    font: '600 9px ui-monospace,monospace',
                    padding: '1px 4px',
                    borderRadius: 4,
                    color: isRaw ? '#241c00' : '#fff',
                    background: isRaw ? '#e5a50a' : 'rgba(0,0,0,0.55)',
                  }}
                >
                  {m.fileExtension}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTolerance(seconds: number): string {
  if (seconds >= 60) return `${seconds / 60} m`;
  if (seconds < 1) return `${seconds.toFixed(1)} s`;
  return `${seconds} s`;
}

function segStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    height: 30,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    borderRadius: 7,
    cursor: 'default',
    color: active ? '#fff' : 'rgba(255,255,255,0.7)',
    background: active ? '#3584e4' : 'rgba(255,255,255,0.06)',
  };
}

const btnBase: CSSProperties = {
  height: 38,
  padding: '0 18px',
  borderRadius: 9,
  fontSize: 13,
  cursor: 'default',
  border: 'none',
};

const btnSecondary: CSSProperties = {
  ...btnBase,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
};

function btnPrimary(enabled: boolean): CSSProperties {
  return {
    ...btnBase,
    padding: '0 22px',
    background: '#3584e4',
    color: '#fff',
    fontWeight: 700,
    opacity: enabled ? 1 : 0.5,
    pointerEvents: enabled ? 'auto' : 'none',
  };
}
