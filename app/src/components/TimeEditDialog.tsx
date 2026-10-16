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

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getStack, thumbnailSrc, type AssetSummary } from '../lib/api';
import { useApplications } from '../lib/applications';
import { useLensConfig } from '../lib/lensConfig';
import { useTimeConfig } from '../lib/timeConfig';
import {
  AS_RECORDED,
  computeNewTimes,
  earliestWall,
  formatOffset,
  formatWall,
  isFixedZone,
  listZones,
  parseLocalString,
  recordedTime,
  recordedZoneText,
  wallToLocalString,
  zoneLabel,
  type Correction,
  type NewTime,
  type ZoneId,
} from '../lib/timeZones';
import { Check, Segmented } from './LensEditDialog';
import { lensBtnPrimary, lensBtnSecondary, lensInput } from './LensControls';

// Change Time - single or bulk. Two questions, the travel model:
//  - which zone the camera's clock was set to, and
//  - which zone the photos were taken in.
// Same zone on both = attach that zone, keeping the clock time; different =
// convert (e.g. a camera left on Toronto time in Paris). "As recorded"
// keeps each photo's own zone. On top of that, a clock correction moves
// every photo by the same amount - either "the first photo was really …" or
// a plain shift - so the spacing between shots never changes.
// Nothing is written until Apply; see lib/timeEdit.tsx for what happens then.
export default function TimeEditDialog({
  assets,
  onClose,
  onSubmit,
}: {
  assets: AssetSummary[];
  onClose: () => void;
  onSubmit: (assets: AssetSummary[], times: NewTime[], writeOriginalOnce: boolean) => Promise<void>;
}) {
  const { homeTimeZone } = useTimeConfig();
  const { lensConfig } = useLensConfig();
  const { exiftoolConfigured } = useApplications();

  // Stack members move with their pick - a RAW+JPEG pair or an edit version
  // drifting apart from its original would break the stack's grouping.
  const [stackExtras, setStackExtras] = useState<AssetSummary[]>([]);
  useEffect(() => {
    const ids = new Set(assets.map((a) => a.id));
    const stackIds = [...new Set(assets.filter((a) => a.stack && a.stack.assetCount > 1).map((a) => a.stack!.id))];
    if (!stackIds.length) return;
    Promise.all(stackIds.map((id) => getStack(id).catch(() => null))).then((stacks) => {
      const extra = new Map<string, AssetSummary>();
      for (const s of stacks) for (const m of s?.assets ?? []) if (!ids.has(m.id) && m.type !== 'VIDEO') extra.set(m.id, m);
      setStackExtras([...extra.values()]);
    });
  }, [assets]);
  const rows = useMemo(() => [...assets, ...stackExtras], [assets, stackExtras]);
  const extraIds = useMemo(() => new Set(stackExtras.map((a) => a.id)), [stackExtras]);

  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const ticked = useMemo(() => rows.filter((a) => !unticked.has(a.id)), [rows, unticked]);

  const recorded = useMemo(() => new Map(rows.map((a) => [a.id, recordedTime(a)])), [rows]);
  const recordedZones = useMemo(() => [...new Set([...recorded.values()].map((r) => r?.zone).filter((z): z is string => !!z))], [recorded]);
  const noZoneCount = [...recorded.values()].filter((r) => !r?.zone).length;
  const refInstant = useMemo(() => {
    const instants = [...recorded.values()].map((r) => r?.instant ?? r?.wall).filter((x): x is number => x != null);
    return instants.length ? Math.min(...instants) : Date.now();
  }, [recorded]);

  const [cameraZone, setCameraZone] = useState<ZoneId>(AS_RECORDED);
  const [takenZone, setTakenZone] = useState<ZoneId>(AS_RECORDED);
  const [mode, setMode] = useState<'shift' | 'anchor'>('shift');
  const [anchor, setAnchor] = useState(() => {
    const w = earliestWall(assets);
    return w != null ? wallToLocalString(w) : '';
  });
  const [shiftSign, setShiftSign] = useState<'+' | '-'>('+');
  const [shift, setShift] = useState({ d: '', h: '', m: '', s: '' });
  const [writeOnce, setWriteOnce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anchorWall = parseLocalString(anchor);
  const shiftMs = (() => {
    const n = (v: string) => (v.trim() === '' ? 0 : Number(v));
    const parts = [n(shift.d), n(shift.h), n(shift.m), n(shift.s)];
    if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
    const ms = ((parts[0] * 24 + parts[1]) * 60 + parts[2]) * 60000 + parts[3] * 1000;
    return shiftSign === '-' ? -ms : ms;
  })();
  const correction = useMemo<Correction | null>(
    () => (mode === 'anchor' ? (anchorWall != null ? { kind: 'anchor', wall: anchorWall } : null) : shiftMs != null ? { kind: 'shift', ms: shiftMs } : null),
    [mode, anchorWall, shiftMs],
  );

  const times = useMemo(
    () => (correction ? computeNewTimes(ticked, { cameraZone, takenZone, homeZone: homeTimeZone, correction }) : new Map<string, NewTime>()),
    [ticked, cameraZone, takenZone, homeTimeZone, correction],
  );
  const changes = [...times.values()].filter((t) => t.changed);
  const flagged = changes.filter((t) => t.flag).length;

  const writeOriginal = lensConfig.writeOriginals || writeOnce;
  const missingPaths = ticked.filter((a) => !a.originalPath).length;
  const blocker =
    ticked.length === 0
      ? 'Tick at least one photo'
      : mode === 'anchor' && anchorWall == null
        ? "Enter the first photo's correct date and time"
        : mode === 'shift' && shiftMs == null
          ? 'The shift must be whole, positive numbers'
          : changes.length === 0
            ? 'Nothing changes with these settings'
            : writeOriginal && !exiftoolConfigured
              ? 'Writing originals needs exiftool — set it in Preferences → Applications'
              : null;

  const zones = useMemo(() => listZones(), []);
  const recordedHint = recordedZones.length === 1 && noZoneCount === 0 ? recordedZones[0] : recordedZones.length === 0 ? `none — uses Home, ${homeTimeZone}` : 'per photo';

  async function apply() {
    if (blocker) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(rows, changes, writeOnce);
      onClose();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  const toggle = (id: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allTicked = unticked.size === 0;

  const count = assets.length;
  const currentLabel = recordedZones.length === 0 ? 'No zone recorded' : recordedZones.length === 1 ? `Recorded zone ${recordedZones[0]}${noZoneCount ? ` · ${noZoneCount} with none` : ''}` : `${recordedZones.length} different zones`;
  const summary = changes.length ? `${changes.length} of ${ticked.length} ${ticked.length === 1 ? 'photo' : 'photos'} change${flagged ? ` · ${flagged} at a DST change ⚠` : ''}` : '';

  return (
    <div className="window-frame window-frame-overlay" style={{ zIndex: 300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={submitting ? undefined : onClose}>
      <div onClick={(e) => e.stopPropagation()} style={dialog}>
        <div style={header}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Change Time</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-dimmer)' }}>
            {count} {count === 1 ? 'photo' : 'photos'}
            {stackExtras.length > 0 && ` + ${stackExtras.length} in their stacks`}
          </span>
          <span style={currentChip} title={recordedZones.join('\n') || undefined}>
            {currentLabel}
          </span>
          <div style={{ flex: 1 }} />
          <div onClick={submitting ? undefined : onClose} style={closeBtn}>
            ✕
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14, padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, flexShrink: 0 }}>
            <Card title="Time zone" sub="Same zone on both = attach it; different = convert">
              <Field label="Camera clock was set to">
                <ZonePicker value={cameraZone} onChange={setCameraZone} zones={zones} pinned={recordedZones} home={homeTimeZone} recordedHint={recordedHint} refInstant={refInstant} autoFocus />
              </Field>
              <Field label="Photos were taken in">
                <ZonePicker value={takenZone} onChange={setTakenZone} zones={zones} pinned={recordedZones} home={homeTimeZone} recordedHint={recordedHint} refInstant={refInstant} />
              </Field>
            </Card>
            <Card
              title="Clock correction"
              sub="Moves every photo by the same amount — the spacing stays"
              toggle={
                <Segmented
                  value={mode}
                  options={[
                    { value: 'shift', label: 'Shift by' },
                    { value: 'anchor', label: 'First photo was' },
                  ]}
                  onChange={setMode}
                />
              }
            >
              {mode === 'anchor' ? (
                <Field label="The earliest ticked photo was really taken at (local time where it was taken)">
                  <input type="datetime-local" step={1} value={anchor} onChange={(e) => setAnchor(e.target.value)} style={lensInput} />
                </Field>
              ) : (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                  <Segmented
                    value={shiftSign}
                    options={[
                      { value: '+', label: '+' },
                      { value: '-', label: '−' },
                    ]}
                    onChange={setShiftSign}
                  />
                  {(['d', 'h', 'm', 's'] as const).map((k) => (
                    <label key={k} style={{ ...fieldLabel, flex: 1 }}>
                      {{ d: 'Days', h: 'Hours', m: 'Minutes', s: 'Seconds' }[k]}
                      <input value={shift[k]} onChange={(e) => setShift({ ...shift, [k]: e.target.value })} placeholder="0" inputMode="numeric" style={lensInput} />
                    </label>
                  ))}
                </div>
              )}
              <div style={hintText}>For a camera clock that was simply wrong, or to line two bodies up.</div>
            </Card>
          </div>

          <div style={table}>
            <div style={{ ...rowGrid, ...tableHead }}>
              <input type="checkbox" checked={allTicked} onChange={() => setUnticked(allTicked ? new Set(rows.map((a) => a.id)) : new Set())} />
              <span />
              <span>Photo</span>
              <span>Current</span>
              <span>New</span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {rows.map((a) => {
                const rec = recorded.get(a.id);
                const t = times.get(a.id);
                const on = !unticked.has(a.id);
                return (
                  <div key={a.id} style={{ ...rowGrid, opacity: on ? 1 : 0.45 }} onClick={() => toggle(a.id)}>
                    <input type="checkbox" checked={on} onChange={() => toggle(a.id)} onClick={(e) => e.stopPropagation()} />
                    <img src={thumbnailSrc(a.id)} alt="" style={thumb} />
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.fileName}>
                      {a.fileName || a.id}
                      {extraIds.has(a.id) && <span style={badge}>stack</span>}
                    </span>
                    <TimeCell wall={rec?.wall ?? null} zone={rec ? (recordedZoneText(rec) ?? 'no zone') : null} />
                    {on && t ? (
                      <TimeCell wall={t.wall} zone={`UTC${formatOffset(t.offset)}${isFixedZone(t.zone) ? '' : ` (${t.zone.replace(/_/g, ' ')})`}`} highlight={t.changed} flag={t.flag} />
                    ) : (
                      <span style={hintText}>{on ? '—' : 'Unchanged'}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {lensConfig.writeOriginals ? (
            <div style={hintText}>Original files are rewritten via exiftool{lensConfig.keepOriginalBackup ? ', keeping a backup copy' : ' without a backup'} (Preferences → Lenses).</div>
          ) : (
            <Check checked={writeOnce} onChange={setWriteOnce}>
              Also write the original files{lensConfig.keepOriginalBackup ? ' (backup kept)' : ' (no backup)'} — needed for ART, RawTherapee and darktable exports to carry the new time
            </Check>
          )}
          {missingPaths > 0 && <div style={warnBox}>{missingPaths} of these photos has no local path — Change Time needs file access and will fail for those.</div>}
          {error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</div>}
        </div>

        <div style={footer}>
          <div style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 12, color: blocker ? 'var(--text-dimmer)' : 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={blocker ?? summary}>
            {blocker ?? summary}
          </div>
          <button onClick={onClose} disabled={submitting} style={lensBtnSecondary}>
            Cancel
          </button>
          <button onClick={apply} disabled={submitting || !!blocker} style={lensBtnPrimary(!submitting && !blocker)}>
            {submitting ? 'Applying…' : `Apply to ${changes.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function TimeCell({ wall, zone, highlight, flag }: { wall: number | null; zone: string | null; highlight?: boolean; flag?: 'gap' | 'ambiguous' | null }) {
  if (wall == null) return <span style={hintText}>Unknown</span>;
  return (
    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontWeight: highlight ? 600 : 400, color: highlight ? 'var(--text)' : 'var(--text-dim)' }}>
        {formatWall(wall)}
        {flag && (
          <span title={flag === 'gap' ? "This clock time never happened (clocks went forward) - read with the offset from before the change" : 'This clock time happened twice (clocks went back) - the earlier one is used'} style={{ marginLeft: 6, color: '#e5a50a' }}>
            ⚠
          </span>
        )}
      </span>
      <span style={{ ...hintText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{zone}</span>
    </span>
  );
}

// Searchable zone list. Pinned at the top: "As recorded", the selection's
// own recorded zones and the Home time zone; then fixed offsets and every
// IANA zone. Labels carry the offset at the selection's own date, so a
// summer trip shows summer offsets.
function ZonePicker({
  value,
  onChange,
  zones,
  pinned,
  home,
  recordedHint,
  refInstant,
  autoFocus,
}: {
  value: ZoneId;
  onChange: (z: ZoneId) => void;
  zones: ZoneId[];
  pinned: ZoneId[];
  home: ZoneId;
  recordedHint: string;
  refInstant: number;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  type Item = { id: ZoneId; label: string; tag?: string };
  const items = useMemo(() => {
    const top: Item[] = [{ id: AS_RECORDED, label: 'As recorded', tag: recordedHint }];
    for (const z of pinned) top.push({ id: z, label: zoneLabel(z, refInstant), tag: 'recorded' });
    if (!pinned.includes(home)) top.push({ id: home, label: zoneLabel(home, refInstant), tag: 'home' });
    const pinnedIds = new Set(top.map((i) => i.id));
    const rest: Item[] = zones.filter((z) => !pinnedIds.has(z)).map((z) => ({ id: z, label: zoneLabel(z, refInstant) }));
    return [...top, ...rest];
  }, [zones, pinned, home, recordedHint, refInstant]);
  // 'utc+5:30' finds 'UTC+05:30'.
  const q = query
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/utc([+-])(\d)(?!\d)/, (_, sign: string, h: string) => `utc${sign}0${h}`);
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q) || (i.tag ?? '').toLowerCase().includes(q)) : items;
  const current = items.find((i) => i.id === value) ?? { id: value, label: zoneLabel(value, refInstant) };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        autoFocus={autoFocus}
        onClick={() => {
          setOpen(!open);
          setQuery('');
        }}
        style={{ ...lensInput, width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, cursor: 'default' }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current.label}
          {current.tag && <span style={{ ...hintText, marginLeft: 6 }}>({current.tag})</span>}
        </span>
        <span style={hintText}>▾</span>
      </button>
      {open && (
        <div style={popover}>
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search — city, region or UTC+5:30" style={{ ...lensInput, margin: 6, width: 'calc(100% - 12px)' }} />
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {shown.map((i) => (
              <div
                key={i.id || 'recorded'}
                onClick={() => {
                  onChange(i.id);
                  setOpen(false);
                }}
                style={{ padding: '6px 12px', fontSize: 12.5, cursor: 'default', background: i.id === value ? 'var(--overlay-medium)' : undefined, display: 'flex', gap: 8 }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.label}</span>
                {i.tag && <span style={hintText}>{i.tag}</span>}
              </div>
            ))}
            {shown.length === 0 && <div style={{ ...hintText, padding: '6px 12px' }}>No matching zone</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ title, sub, toggle, children }: { title: string; sub: string; toggle?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 12, background: 'var(--panel)', border: '1px solid var(--border-strong)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
          <div style={{ ...hintText, marginTop: 2 }}>{sub}</div>
        </div>
        {toggle}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={fieldLabel}>
      {label}
      {children}
    </div>
  );
}

const dialog: CSSProperties = {
  width: 1080,
  maxWidth: '96%',
  height: 740,
  maxHeight: '92%',
  background: 'var(--dialog-bg)',
  borderRadius: 14,
  boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
  border: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};
const header: CSSProperties = { height: 54, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px 0 20px', background: 'var(--panel)', borderBottom: '1px solid rgba(0,0,0,0.4)' };
const closeBtn: CSSProperties = { width: 30, height: 30, borderRadius: '50%', background: 'var(--overlay-medium)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', fontSize: 14 };
const footer: CSSProperties = { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderTop: '1px solid rgba(0,0,0,0.3)' };
const fieldLabel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--text-dim)' };
const currentChip: CSSProperties = { minWidth: 0, padding: '4px 10px', borderRadius: 999, background: 'var(--overlay-weak)', fontSize: 12, color: 'var(--text-dimmer)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const hintText: CSSProperties = { fontSize: 11.5, color: 'var(--text-dimmer)' };
const warnBox: CSSProperties = { fontSize: 12, lineHeight: 1.45, padding: '9px 12px', borderRadius: 9, background: 'rgba(229,165,10,0.12)', border: '1px solid rgba(229,165,10,0.35)', color: 'var(--text)' };
const table: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-sunken)', overflow: 'hidden' };
const rowGrid: CSSProperties = { display: 'grid', gridTemplateColumns: '24px 44px minmax(0,1.1fr) minmax(0,1fr) minmax(0,1fr)', alignItems: 'center', gap: 10, padding: '5px 12px', fontSize: 12.5, borderBottom: '1px solid var(--border)', cursor: 'default' };
const tableHead: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-dimmer)', background: 'var(--panel)' };
const thumb: CSSProperties = { width: 40, height: 40, borderRadius: 6, objectFit: 'cover', background: 'var(--overlay-weak)' };
const badge: CSSProperties = { marginLeft: 6, padding: '1px 6px', borderRadius: 999, fontSize: 10.5, background: 'var(--overlay-medium)', color: 'var(--text-dim)' };
const popover: CSSProperties = { position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10, borderRadius: 10, background: 'var(--dialog-bg)', border: '1px solid var(--border-strong)', boxShadow: '0 12px 34px rgba(0,0,0,0.5)' };
