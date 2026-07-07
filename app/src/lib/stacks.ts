import type { AssetSummary } from './api';

// Mirrors the design prototype's visibleAssets()/isHiddenChild(): every
// non-pick member of a stack is hidden from the flat grid, selection,
// keyboard nav, and the Viewer's prev/next - only the pick (or an unstacked
// asset) ever shows up as its own row. Expanding a stack inline is the only
// way to see its other members (StackBand fetches them separately).
export function isHiddenStackChild(asset: AssetSummary): boolean {
  return !!asset.stack && asset.stack.primaryAssetId !== asset.id;
}
