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

import type { AssetSummary } from './api';

// Change Time's zone math - all of it lives here so the dialog's preview is
// exactly what's written (the Rust side just writes the finished values).
//
// Two kinds of time:
//  - an *instant* - plain epoch ms, the moment the shutter fired;
//  - a *wall* time - what a clock on the wall read there, held as epoch ms
//    of that reading as if it were UTC. That's the same trick Immich's own
//    `localDateTime` uses, so Date.parse() of it is a wall time directly.
//
// A ZoneId is either an IANA name ('Europe/Paris', DST worked out per date)
// or a fixed offset written 'UTC+05:45' / 'UTC-04:00'.
export type ZoneId = string;

// Pseudo-zone for the dialog's pickers - each photo keeps whatever zone it
// already has recorded (falling back to the Home time zone when none is).
export const AS_RECORDED = '';

const FIXED_RE = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/;

export function systemTimeZone(): ZoneId {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isFixedZone(zone: ZoneId): boolean {
  return FIXED_RE.test(zone);
}

// Minutes east of UTC -> 'UTC+05:45'.
export function fixedZone(minutes: number): ZoneId {
  return `UTC${formatOffset(minutes)}`;
}

// Minutes east of UTC -> '+05:45' (EXIF's OffsetTime form).
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(zone)) {
    try {
      formatters.set(
        zone,
        new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      );
    } catch {
      formatters.set(zone, null);
    }
  }
  return formatters.get(zone)!;
}

export function isValidZone(zone: ZoneId): boolean {
  return isFixedZone(zone) || formatterFor(zone) != null;
}

// The zone's UTC offset (minutes east) at `instant`.
export function offsetAt(zone: ZoneId, instant: number): number {
  const fixed = FIXED_RE.exec(zone);
  if (fixed) {
    const mins = Number(fixed[2]) * 60 + Number(fixed[3] ?? 0);
    return fixed[1] === '-' ? -mins : mins;
  }
  const fmt = formatterFor(zone);
  if (!fmt) return 0;
  const whole = Math.floor(instant / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(whole))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - whole) / 60000);
}

// 'gap' = that wall time never happened (clocks jumped forward) - read with
// the offset from before the jump; 'ambiguous' = it happened twice (clocks
// went back) - the earlier of the two is used.
export type WallFlag = 'gap' | 'ambiguous' | null;

export function wallToInstant(wall: number, zone: ZoneId): { instant: number; flag: WallFlag } {
  const day = 86_400_000;
  const offsets = [...new Set([offsetAt(zone, wall - day), offsetAt(zone, wall + day)])];
  const valid = offsets.map((o) => wall - o * 60000).filter((inst) => offsetAt(zone, inst) * 60000 === wall - inst);
  if (valid.length === 0) return { instant: wall - offsets[0] * 60000, flag: 'gap' };
  if (valid.length > 1) return { instant: Math.min(...valid), flag: 'ambiguous' };
  return { instant: valid[0], flag: null };
}

export function instantToWall(instant: number, zone: ZoneId): number {
  return instant + offsetAt(zone, instant) * 60000;
}

// Immich's exifInfo.timeZone - 'Europe/Paris', 'UTC', 'UTC+2', 'UTC-04:00',
// 'UTC+05:30' - as a ZoneId, or null when absent/unrecognised.
export function parseImmichZone(tz: string | null | undefined): ZoneId | null {
  const t = tz?.trim();
  if (!t) return null;
  const fixed = FIXED_RE.exec(t);
  if (fixed) {
    const mins = Number(fixed[2]) * 60 + Number(fixed[3] ?? 0);
    return fixedZone(fixed[1] === '-' ? -mins : mins);
  }
  return isValidZone(t) ? t : null;
}

// The real-world offsets that aren't whole hours.
const PART_HOUR_OFFSETS = ['-09:30', '-03:30', '+03:30', '+04:30', '+05:30', '+05:45', '+06:30', '+08:45', '+09:30', '+10:30', '+12:45'];

// Every zone the pickers offer: fixed offsets (whole hours -12..+14 plus the
// part-hour ones in real use), then the IANA names this runtime knows.
export function listZones(): ZoneId[] {
  const fixed: ZoneId[] = [];
  for (let h = -12; h <= 14; h++) fixed.push(fixedZone(h * 60));
  for (const o of PART_HOUR_OFFSETS) fixed.push(`UTC${o}`);
  fixed.sort((a, b) => offsetAt(a, 0) - offsetAt(b, 0));
  let iana: string[] = [];
  try {
    iana = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    iana = [];
  }
  if (!iana.length) iana = ['UTC', systemTimeZone()];
  return [...fixed, ...iana.filter((z) => !fixed.includes(z))];
}

// 'Europe/Paris' -> 'Europe/Paris · UTC+02:00' (offset at `instant`).
export function zoneLabel(zone: ZoneId, instant: number): string {
  if (isFixedZone(zone)) return zone;
  return `${zone.replace(/_/g, ' ')} · UTC${formatOffset(offsetAt(zone, instant))}`;
}

// Wall ms -> 'YYYY-MM-DDTHH:MM:SS'.
export function wallToLocalString(wall: number): string {
  return new Date(Math.floor(wall / 1000) * 1000).toISOString().slice(0, 19);
}

// 'YYYY-MM-DDTHH:MM[:SS]' (a datetime-local value) -> wall ms, or null.
export function parseLocalString(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}

const wallFormat = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' });
const wallFormatLong = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' });

export function formatWall(wall: number, long = false): string {
  return (long ? wallFormatLong : wallFormat).format(new Date(wall));
}

// What an asset records now. `zone`/`offset` are null when Immich has no
// zone for it - its wall time is then just the camera's clock reading.
export interface RecordedTime {
  wall: number;
  instant: number | null;
  zone: ZoneId | null;
  offset: number | null;
}

export function recordedTime(a: AssetSummary): RecordedTime | null {
  const local = a.localDateTime ? Date.parse(a.localDateTime) : NaN;
  const dto = a.dateTimeOriginal ? Date.parse(a.dateTimeOriginal) : NaN;
  const zone = parseImmichZone(a.timeZone);
  if (!Number.isNaN(local)) {
    const offset = zone && !Number.isNaN(dto) ? Math.round((local - dto) / 60000) : null;
    return { wall: local, instant: zone && !Number.isNaN(dto) ? dto : null, zone, offset };
  }
  // Older backend / Trash asset: only the instant - read it on this
  // computer's clock, as the Taken row always used to.
  const created = Date.parse(a.fileCreatedAt);
  if (Number.isNaN(created)) return null;
  return { wall: instantToWall(created, systemTimeZone()), instant: null, zone: null, offset: null };
}

// 'UTC+02:00 · Europe/Paris', 'UTC-04:00', or null when no zone is recorded.
export function recordedZoneText(r: RecordedTime): string | null {
  if (r.offset == null || !r.zone) return null;
  const off = `UTC${formatOffset(r.offset)}`;
  return isFixedZone(r.zone) ? off : `${off} (${r.zone.replace(/_/g, ' ')})`;
}

export type Correction = { kind: 'anchor'; wall: number } | { kind: 'shift'; ms: number };

export interface TimeOptions {
  cameraZone: ZoneId; // AS_RECORDED or a zone
  takenZone: ZoneId; // AS_RECORDED or a zone
  homeZone: ZoneId;
  correction: Correction;
}

export interface NewTime {
  assetId: string;
  instant: number;
  wall: number;
  offset: number;
  zone: ZoneId;
  local: string; // 'YYYY-MM-DDTHH:MM:SS'
  offsetText: string; // '+02:00'
  flag: WallFlag;
  changed: boolean;
}

// The heart of the dialog, for the photos that are ticked:
//  1. read each photo's recorded wall time on the camera clock's zone
//     (or, "as recorded", trust the instant Immich already has);
//  2. move every instant by the same correction, so spacing is kept -
//     an anchor sets the earliest photo's new local time in its taken-in
//     zone, a shift is just added;
//  3. show the instant in the taken-in zone, with that zone's offset on
//     that date (so a set spanning a DST change gets both offsets right).
export function computeNewTimes(assets: AssetSummary[], opts: TimeOptions): Map<string, NewTime> {
  const base = assets
    .map((a) => {
      const rec = recordedTime(a);
      if (!rec) return null;
      const camera = opts.cameraZone === AS_RECORDED ? (rec.zone ?? opts.homeZone) : opts.cameraZone;
      const read = opts.cameraZone === AS_RECORDED && rec.instant != null ? { instant: rec.instant, flag: null as WallFlag } : wallToInstant(rec.wall, camera);
      const taken = opts.takenZone === AS_RECORDED ? (rec.zone ?? opts.homeZone) : opts.takenZone;
      return { a, rec, taken, ...read };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  let delta = 0;
  if (opts.correction.kind === 'shift') {
    delta = opts.correction.ms;
  } else if (base.length) {
    const first = base.reduce((m, x) => (x.instant < m.instant ? x : m));
    delta = wallToInstant(opts.correction.wall, first.taken).instant - first.instant;
  }

  const out = new Map<string, NewTime>();
  for (const x of base) {
    const instant = x.instant + delta;
    const offset = offsetAt(x.taken, instant);
    const wall = instant + offset * 60000;
    const local = wallToLocalString(wall);
    const changed = local !== wallToLocalString(x.rec.wall) || x.rec.offset !== offset || x.rec.zone !== x.taken;
    out.set(x.a.id, { assetId: x.a.id, instant, wall, offset, zone: x.taken, local, offsetText: formatOffset(offset), flag: x.flag, changed });
  }
  return out;
}

// The earliest of `assets`' recorded wall times - the anchor field's default.
export function earliestWall(assets: AssetSummary[]): number | null {
  let best: { wall: number; key: number } | null = null;
  for (const a of assets) {
    const r = recordedTime(a);
    if (!r) continue;
    const key = r.instant ?? r.wall;
    if (!best || key < best.key) best = { wall: r.wall, key };
  }
  return best?.wall ?? null;
}
