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

import { memo, useState } from 'react';
import AssetThumbImage from './AssetThumb';
import { RejectIcon, Star } from './MetadataRows';
import type { AssetSummary, UnsyncedMetadata } from '../lib/api';
import { isRawAsset } from '../lib/filters';

export type ClickMods = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };

function unsyncedMetadataTooltip(gap: UnsyncedMetadata): string {
  const parts: string[] = [];
  if (gap.rating !== undefined) {
    parts.push(gap.rating === -1 ? 'a rejected flag' : `a ${gap.rating}★ rating`);
  }
  if (gap.description !== undefined) {
    parts.push('a description');
  }
  return `Local file has ${parts.join(' and ')} not yet in Immich`;
}

// Shared grid tile used by both the main Photos timeline and the Folders
// (year/month) view - checkbox select, hover-to-open, rating stars, favorite
// heart, and file type badge all render identically in both places.
const AssetTile = memo(function AssetTile({
  asset,
  selected,
  onToggleSelect,
  onToggleOne,
  onOpen,
  onContextMenu,
  onToggleStackExpand,
  onRate,
  loupeMode,
  onHoverAsset,
}: {
  asset: AssetSummary;
  selected: boolean;
  onToggleSelect: (id: string, mods: ClickMods) => void;
  onToggleOne: (id: string) => void;
  onOpen: (id: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  // Only relevant for a stack's pick (asset.stack.assetCount > 1) - clicking
  // the stack badge expands/collapses the band in place of this tile.
  onToggleStackExpand?: (stackId: string) => void;
  // Lets rating be set directly on the tile instead of only via the Metadata
  // panel or a keyboard shortcut on the open/selected asset.
  onRate: (id: string, rating: number) => void;
  // Grid loupe mode: browse-only (hover previews into a separate pane, no
  // clickable select/open/rate) except for expanding/collapsing a stack,
  // which stays live via onToggleStackExpand above. The rating/reject badge
  // stays visible but read-only, since rating can still be set via keyboard
  // shortcut on whichever asset is hovered.
  loupeMode?: boolean;
  onHoverAsset?: (id: string | null) => void;
}) {
  const isStackPrimary = !!asset.stack && asset.stack.primaryAssetId === asset.id && asset.stack.assetCount > 1;
  const isRaw = isRawAsset(asset);
  // Native dblclick is unreliable for this: some touchpad "double tap" drivers
  // never synthesize a real dblclick event, only two plain clicks - but both
  // still carry the browser/OS's own click count in `e.detail` (computed by
  // the platform's double-click timing *before* the event is even dispatched
  // to us), so reading that instead of a native 'dblclick' listener still
  // works uniformly for mouse, touchpad, and touch.
  //
  // This used to track double-clicks with a manual setTimeout instead - a
  // pending-first-click flag that a following second click would read within
  // a fixed window. That raced this component's own render work: applying
  // the first click's selection (mounting the selection bar, re-rendering
  // the grid, React StrictMode's double-render in dev) could keep the main
  // thread busy past the timer's deadline, so by the time the second click's
  // event handler actually ran, the timer had already fired and cleared the
  // flag - the second click then read as a fresh first click (re-toggling
  // selection) instead of a second one, and never opened anything. `e.detail`
  // sidesteps that entirely: it's decided at dispatch time by the platform,
  // not raced against whatever this component's last render was doing.
  const [hovered, setHovered] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    // Loupe mode is browse-only - hovering drives the preview pane, and
    // nothing else on the tile (select, open, rate) is reachable except the
    // stack-expand badge, which has its own onClick with stopPropagation so
    // it never reaches here.
    if (loupeMode) return;
    const mods: ClickMods = { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
    const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey;

    // A plain click that's the 2nd+ (or later) of a double/triple-click
    // means "open" instead of toggling selection again - the first click
    // already applied it. A modified (shift/ctrl) repeat click just toggles
    // again, same as any other modified click.
    if (e.detail >= 2 && plain) {
      onOpen(asset.id);
      return;
    }
    onToggleSelect(asset.id, mods);
  };

  return (
    <div
      data-asset-id={asset.id}
      onClick={handleClick}
      onMouseEnter={() => {
        setHovered(true);
        onHoverAsset?.(asset.id);
      }}
      onMouseLeave={() => {
        setHovered(false);
        onHoverAsset?.(null);
      }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onContextMenu={(e) => {
        if (!onContextMenu || loupeMode) return;
        e.preventDefault();
        onContextMenu(asset.id, e.clientX, e.clientY);
      }}
      style={{
        aspectRatio: '3 / 2',
        borderRadius: 8,
        overflow: 'hidden',
        cursor: 'default',
        background: 'var(--surface-sunken)',
        boxShadow: loupeMode
          ? hovered
            ? '0 0 0 3px #808080'
            : '0 0 0 1px var(--border)'
          : selected
            ? '0 0 0 2px #3584e4, 0 2px 10px rgba(0,0,0,.45)'
            : '0 0 0 1px var(--border)',
        position: 'relative',
        // Without this, the browser's own double-tap-to-zoom gesture
        // recognizer swallows both taps of a touchpad/touch double-tap
        // entirely (waiting to see if a second tap follows, then treating
        // the pair as a zoom gesture instead of two clicks) - a real mouse
        // double-click isn't subject to that gesture recognition, so it kept
        // working while double-tap silently did nothing. `manipulation`
        // disables double-tap-to-zoom specifically while still allowing
        // normal panning/pinch-zoom.
        touchAction: 'manipulation',
      }}
    >
      <AssetThumbImage asset={asset} />

      {hovered && !loupeMode && (
        // A single, reliable click to open - doesn't depend on double-click/
        // double-tap gesture detection working at all, for touchpads where
        // that gesture doesn't reach the browser as two distinct clicks.
        <div
          onClick={(e) => {
            e.stopPropagation();
            onOpen(asset.id);
          }}
          title="Open"
          style={{
            position: 'absolute',
            top: 7,
            right: 7,
            width: 20,
            height: 20,
            borderRadius: 6,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'default',
            fontSize: 12,
            color: '#fff',
          }}
        >
          ⤢
        </div>
      )}

      {isStackPrimary && (
        // Sits just left of the open icon, which only appears on hover - so
        // this shifts further from the corner while hovered instead of
        // sitting underneath/overlapping it.
        <div
          onClick={(e) => {
            e.stopPropagation();
            onToggleStackExpand?.(asset.stack!.id);
          }}
          title="Expand stack"
          style={{
            position: 'absolute',
            top: 7,
            right: hovered && !loupeMode ? 33 : 7,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            height: 20,
            padding: '0 6px',
            borderRadius: 11,
            background: 'rgba(0,0,0,0.62)',
            cursor: 'default',
          }}
        >
          <div style={{ position: 'relative', width: 11, height: 11 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, width: 7, height: 7, border: '1.4px solid #fff', borderRadius: 1.5 }} />
            <div style={{ position: 'absolute', left: 3, top: 3, width: 7, height: 7, border: '1.4px solid #fff', borderRadius: 1.5, background: 'rgba(0,0,0,0.62)' }} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>{asset.stack!.assetCount}</span>
          <div style={{ width: 5, height: 5, borderRight: '1.4px solid #fff', borderBottom: '1.4px solid #fff', transform: 'rotate(45deg)', marginTop: -2 }} />
        </div>
      )}

      {!loupeMode && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            onToggleOne(asset.id);
          }}
          style={{
            position: 'absolute',
            top: 5,
            left: 5,
            width: 16,
            height: 16,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'default',
            background: selected ? '#3584e4' : 'rgba(0,0,0,0.35)',
            boxShadow: selected ? '0 1px 3px rgba(0,0,0,.4)' : 'inset 0 0 0 1px rgba(255,255,255,0.7)',
          }}
        >
          {selected && (
            <div
              style={{
                width: 6,
                height: 3.5,
                borderLeft: '1.8px solid #fff',
                borderBottom: '1.8px solid #fff',
                transform: 'rotate(-45deg) translateY(-1px)',
              }}
            />
          )}
        </div>
      )}

      {
        // Loupe mode drops the click handlers (mouse-driven rating isn't
        // reachable there - see the loupeMode doc above) but the badge itself
        // stays visible read-only, same as the favorite heart below, so a
        // rating set via keyboard shortcut while hovering in loupe mode has
        // somewhere to show up.
      }
      <div
        onClick={loupeMode ? undefined : (e) => e.stopPropagation()}
        style={{ position: 'absolute', left: 6, bottom: 6, display: 'flex', gap: 4, padding: '3px 4px', borderRadius: 5, background: 'rgba(0,0,0,0.5)' }}
      >
        {[1, 2, 3, 4, 5].map((v) => (
          // The clickable box is plain/unclipped, with the clip-path star as a
          // purely decorative child - clip-path clips hit-testing along with
          // painting in Chromium/WebKit, so a star's own corner-notches would
          // otherwise be unclickable. Same shared Star as MetadataRows.tsx's
          // rating control, for a consistent look across the grid, filmstrip,
          // and info panel.
          <div
            key={v}
            onClick={
              loupeMode
                ? undefined
                : (e) => {
                    e.stopPropagation();
                    onRate(asset.id, v === (asset.rating || 0) ? 0 : v);
                  }
            }
            title={loupeMode ? undefined : `Rate ${v}`}
            style={{ width: 12, height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
          >
            <Star filled={v <= (asset.rating || 0)} size={8} dimColor="rgba(255,255,255,0.3)" />
          </div>
        ))}
        <div
          onClick={
            loupeMode
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  onRate(asset.id, asset.rating === -1 ? 0 : -1);
                }
          }
          title={loupeMode ? undefined : 'Reject'}
          style={{ width: 12, height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
        >
          <RejectIcon active={asset.rating === -1} size={9} dimColor="rgba(255,255,255,0.3)" />
        </div>
        {!loupeMode && asset.unsyncedMetadata && (
          // A local sidecar/embedded file has a rating and/or description
          // Immich doesn't have yet (see checkSidecarMetadata) - purely
          // informational here, synced via the context menu / SelectionBar /
          // Edit menu, never by clicking this badge, to keep it consistent
          // with the read-only stack badge.
          <div
            title={unsyncedMetadataTooltip(asset.unsyncedMetadata)}
            style={{ position: 'relative', width: 8, height: 8, marginLeft: 1, flexShrink: 0 }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                border: '1.3px solid #e5a50a',
                borderLeftColor: 'transparent',
                borderRadius: '50%',
                transform: 'rotate(45deg)',
              }}
            />
          </div>
        )}
      </div>

      <div style={{ position: 'absolute', right: 6, bottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
        {asset.isFavorite && (
          <div style={{ position: 'relative', width: 13, height: 12 }}>
            <div style={{ width: 7, height: 7, background: '#ff6b6b', transform: 'rotate(45deg)', position: 'absolute', left: 3, top: 3 }} />
            <div style={{ width: 7, height: 7, background: '#ff6b6b', borderRadius: '50%', position: 'absolute', left: 0, top: 0 }} />
            <div style={{ width: 7, height: 7, background: '#ff6b6b', borderRadius: '50%', position: 'absolute', left: 6, top: 0 }} />
          </div>
        )}
        {asset.fileExtension && (
          <div
            style={{
              font: '600 9.5px ui-monospace,monospace',
              letterSpacing: '.04em',
              padding: '2px 5px',
              borderRadius: 4,
              color: isRaw ? '#241c00' : '#fff',
              background: isRaw ? '#e5a50a' : 'rgba(0,0,0,0.5)',
            }}
          >
            {asset.fileExtension}
          </div>
        )}
      </div>
    </div>
  );
});

export default AssetTile;
