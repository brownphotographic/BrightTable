import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getConfig, setRawOverrides, type AssetSummary } from './api';

interface RawOverridesContextValue {
  overrideIds: Set<string>;
  setOverride: (assetIds: string[], isRaw: boolean) => void;
}

const RawOverridesContext = createContext<RawOverridesContextValue | null>(null);

// Mirrors SmartStackSettingsProvider/ShortcutsProvider's persist-to-config
// pattern - which asset ids the user has manually flagged as "actually RAW"
// despite an unrecognized extension (currently only relevant for .tif/.tiff,
// see AssetTile/Edit menu's "Toggle Canon RAW"). Immich has no concept of
// this, so it lives entirely in BrightTable's own config.json.
export function RawOverridesProvider({ children }: { children: ReactNode }) {
  const [overrideIds, setOverrideIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    getConfig()
      .then((cfg) => setOverrideIds(new Set(cfg.rawOverrides)))
      .catch(() => {});
  }, []);

  const setOverride = useCallback((assetIds: string[], isRaw: boolean) => {
    if (!assetIds.length) return;
    setOverrideIds((cur) => {
      const next = new Set(cur);
      for (const id of assetIds) {
        if (isRaw) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setRawOverrides(assetIds, isRaw).catch(() => {});
  }, []);

  return <RawOverridesContext.Provider value={{ overrideIds, setOverride }}>{children}</RawOverridesContext.Provider>;
}

export function useRawOverrides(): RawOverridesContextValue {
  const ctx = useContext(RawOverridesContext);
  if (!ctx) throw new Error('useRawOverrides must be used within a RawOverridesProvider');
  return ctx;
}

// Overlays isRawOverride onto a raw AssetSummary/StackInfo asset list -
// shared by every spot that fetches assets straight from a Tauri command
// (filteredAssetCache in the two browsers, StackBand, SmartStackDialog's
// existing-stack merge) so the override is visible wherever the asset shows
// up, not just in the grid it happened to be selected from.
export function overlayRawOverrides<T extends AssetSummary>(assets: T[], overrideIds: Set<string>): T[] {
  return assets.map((a) => ({ ...a, isRawOverride: overrideIds.has(a.id) }));
}
