import type { AssetSummary } from './api';
import { isRawAsset } from './filters';

export type SmartStackMode = 'name' | 'version' | 'time';

export interface SmartStackGroup {
  key: string;
  members: AssetSummary[];
  pickId: string;
}

// 19 steps: tenths of a second up to 1s, then whole seconds up to 10s -
// ported verbatim from the design prototype's TOL scale.
export const TOL = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function toleranceSeconds(index: number): number {
  return TOL[Math.max(0, Math.min(TOL.length - 1, index))];
}

// `fileName` is Immich's originalFileName and already includes the extension
// (e.g. "IMG_4471.ARW") - this strips exactly the known `.{fileExtension}`
// suffix rather than a generic "everything after the last dot" split, so a
// base name that itself contains a dot isn't mangled.
export function baseName(asset: AssetSummary): string {
  const { fileName, fileExtension } = asset;
  if (fileExtension && fileName.toLowerCase().endsWith('.' + fileExtension.toLowerCase())) {
    return fileName.slice(0, fileName.length - fileExtension.length - 1);
  }
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function captureTs(asset: AssetSummary): number {
  return Date.parse(asset.fileCreatedAt);
}

export function agByName(list: AssetSummary[]): { key: string; members: AssetSummary[] }[] {
  const groups = new Map<string, AssetSummary[]>();
  for (const a of list) {
    const key = baseName(a);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  return [...groups.entries()].filter(([, members]) => members.length >= 2).map(([key, members]) => ({ key, members }));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds the version-matching regex from a pattern that may contain `*`
// wildcards (e.g. "*converted*"). `*` -> lazy "any characters"; everything
// else is matched literally (case-insensitive). A leading `*` folds directly
// into the mandatory leading capture group instead of adding a second,
// adjacent ".*?" - two lazy wildcards back to back would let the first stay
// empty and the second silently absorb everything, collapsing every match's
// key to "" and merging unrelated groups together. Without a leading `*`, a
// bounded (non-wildcard) run of separator characters is still allowed before
// the literal text, so a plain suffix like "converted" matches equally well
// whether the real file uses "-converted", " - converted", or "_converted".
function buildVersionRegex(pattern: string): RegExp | null {
  const hasLeadingWildcard = pattern.startsWith('*');
  const hasTrailingWildcard = pattern.endsWith('*');
  const core = pattern
    .split('*')
    .filter((part) => part.length > 0)
    .map(escapeRegExp)
    .join('.*?');
  if (!core) return null;
  const gap = hasLeadingWildcard ? '' : '[\\s_-]*';
  // No trailing wildcard: keep the original "optional trailing version
  // number" convention (" - converted 2"). Trailing wildcard: allow any
  // trailing content at all, matching the wildcard's own "anything goes"
  // semantics rather than restricting it to just a number.
  const tail = hasTrailingWildcard ? '.*' : '(?:[ _-]?\\d+)?';
  return new RegExp('^(.*?)' + gap + core + tail + '$', 'i');
}

export function agByVersion(list: AssetSummary[], suffix: string): { key: string; members: AssetSummary[] }[] {
  const sfx = (suffix || '').trim();
  if (!sfx) return [];
  const re = buildVersionRegex(sfx);
  if (!re) return [];
  const groups = new Map<string, AssetSummary[]>();
  for (const a of list) {
    const base = baseName(a);
    const match = base.match(re);
    // Strip any separator punctuation left dangling at the end of the
    // captured prefix (e.g. the " - " before "converted") - otherwise a
    // rendition's key never lines up with its RAW original's own
    // (separator-free) base name and the two never end up in the same group.
    const key = match ? match[1].replace(/[\s_-]+$/, '') : base;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length >= 2 && members.some((a) => re.test(baseName(a))))
    .map(([key, members]) => ({ key, members }));
}

export function agByTime(list: AssetSummary[], tolMs: number): { key: string; members: AssetSummary[] }[] {
  const sorted = list.slice().sort((a, b) => captureTs(a) - captureTs(b));
  const groups: AssetSummary[][] = [];
  let cur: AssetSummary[] = [];
  for (const a of sorted) {
    if (!cur.length) {
      cur = [a];
      continue;
    }
    if (captureTs(a) - captureTs(cur[cur.length - 1]) <= tolMs) cur.push(a);
    else {
      if (cur.length >= 2) groups.push(cur);
      cur = [a];
    }
  }
  if (cur.length >= 2) groups.push(cur);
  return groups.map((members) => ({ key: 't' + members[0].id, members }));
}

// Pick-assignment rule per mode (Immich Desktop.dc.html lines 1475-1478),
// factored out so it can be re-run after a group's members are expanded with
// an already-existing stack's other members (see mergeExistingStacks below) -
// the initial match and the post-merge re-evaluation both need the exact same
// rule, just over different member lists.
export function pickForGroup(members: AssetSummary[], mode: SmartStackMode, key: string): string {
  if (mode === 'time') {
    const earliest = members.reduce((a, b) => (captureTs(a) <= captureTs(b) ? a : b));
    return earliest.id;
  }
  if (mode === 'version') {
    // Prefer an exact match on the group's un-suffixed key that's also the
    // RAW file (the true original a rendition was made from); fall back to
    // any exact match, then any RAW, then just the first member.
    const src =
      members.find((m) => baseName(m) === key && isRawAsset(m)) ??
      members.find((m) => baseName(m) === key) ??
      members.find((m) => isRawAsset(m)) ??
      members[0];
    return src.id;
  }
  const raw = members.find((m) => isRawAsset(m)) ?? members[0];
  return raw.id;
}

// Runs the mode-appropriate grouping algorithm, then assigns each group's pick.
export function agGroups(
  candidates: AssetSummary[],
  mode: SmartStackMode,
  suffix: string,
  tolSeconds: number,
): SmartStackGroup[] {
  const raw =
    mode === 'name'
      ? agByName(candidates)
      : mode === 'version'
        ? agByVersion(candidates, suffix)
        : agByTime(candidates, tolSeconds * 1000);

  return raw.map((g) => {
    const members = mode === 'time' ? g.members.slice().sort((a, b) => captureTs(a) - captureTs(b)) : g.members.slice();
    return { key: g.key, members, pickId: pickForGroup(members, mode, g.key) };
  });
}

// A group's members may include an asset that's already the primary of an
// existing (smaller) stack - e.g. a RAW+JPEG pair the camera/Immich already
// paired up, now also matching a new "-converted" rendition. Rather than
// silently skipping such assets (the design prototype's behavior, `!st.
// stackMap[a.id]`), this app auto-merges: any already-existing stack touched
// by a group gets its full membership folded in and its pick re-derived, so
// applying the group later can dissolve the old stack(s) and create one
// unified one instead of losing the old pairing. `existingMembers` maps a
// stack id to its full (fetched) member list - the caller is responsible for
// fetching it (see SmartStackDialog's use of `getStack`), since this module
// stays free of network calls.
export function mergeExistingStacks(
  groups: SmartStackGroup[],
  mode: SmartStackMode,
  existingMembers: Map<string, AssetSummary[]>,
): SmartStackGroup[] {
  return groups.map((g) => {
    const byId = new Map(g.members.map((m) => [m.id, m]));
    let expanded = false;
    for (const m of g.members) {
      const extra = m.stack && existingMembers.get(m.stack.id);
      if (!extra) continue;
      for (const em of extra) {
        if (!byId.has(em.id)) {
          byId.set(em.id, em);
          expanded = true;
        }
      }
    }
    if (!expanded) return g;
    const members = [...byId.values()];
    return { key: g.key, members, pickId: pickForGroup(members, mode, g.key) };
  });
}
