import { useMemo, useRef } from 'react';

// PhotosBrowser/FoldersBrowser both keep an assetCache keyed by bucket
// (time bucket or folder path) and derive an overlaid/filtered version of it
// via a plain useMemo. A single metadata edit (rating, favorite...) only
// ever replaces its own bucket's array in assetCache - every other bucket
// keeps the exact same array reference - but a plain useMemo has no way to
// know that, so it reran `compute` over every asset in every bucket ever
// scrolled past on every single edit. In a library with a lot loaded, that
// synchronous re-map+filter of the whole thing on every click is what made
// selecting/rating/favoriting feel laggy. This reuses each bucket's prior
// result when its source array reference is unchanged, so a single edit's
// cost is proportional to just that bucket. `crossCutting` bundles whatever
// else `compute` reads besides its own bucket's items (filters, stack
// membership, overrides...) - a change to any of those invalidates every
// bucket at once, same as a plain useMemo would.
export function useBucketMemo<T>(
  buckets: Record<string, T[]>,
  crossCutting: readonly unknown[],
  compute: (items: T[]) => T[],
): Record<string, T[]> {
  const cacheRef = useRef<Map<string, { source: T[]; result: T[] }>>(new Map());
  const crossCuttingRef = useRef<readonly unknown[] | null>(null);

  return useMemo(() => {
    const prev = crossCuttingRef.current;
    const changed =
      !prev || prev.length !== crossCutting.length || prev.some((v, i) => v !== crossCutting[i]);
    if (changed) {
      cacheRef.current = new Map();
      crossCuttingRef.current = crossCutting;
    }
    const out: Record<string, T[]> = {};
    for (const [key, items] of Object.entries(buckets)) {
      const cached = cacheRef.current.get(key);
      if (cached && cached.source === items) {
        out[key] = cached.result;
        continue;
      }
      const result = compute(items);
      cacheRef.current.set(key, { source: items, result });
      out[key] = result;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, ...crossCutting]);
}
