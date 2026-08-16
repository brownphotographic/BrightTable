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

import { useState } from 'react';
import { useResourceUsage, type ResourceSample } from '../lib/useResourceUsage';
import { formatSize } from '../lib/exifFormat';

type Metric = 'ram' | 'cpu';

// Reuses the app's existing Adwaita-derived hues (Sidebar's Photos blue /
// Trash red) instead of introducing new ones, so the chart reads as part of
// the same UI rather than a bolted-on widget.
const RAM_COLOR = '#e01b24';
const CPU_COLOR = '#62a0ea';
const DIM_TEXT = 'var(--text-dimmer)';

const SLOT_COUNT = 60; // 1 sample/s * 60s = the chart's fixed 1-minute extent
const CHART_HEIGHT = 30;

function valueOf(s: ResourceSample, metric: Metric): number {
  return metric === 'ram' ? s.systemRamPercent : s.cpuPercent;
}

function Tab({
  label,
  color,
  active,
  value,
  onClick,
}: {
  label: string;
  color: string;
  active: boolean;
  value: number | null;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        cursor: 'default',
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          flexShrink: 0,
          background: active ? color : 'var(--text-dimmer)',
        }}
      />
      <span
        style={{
          fontSize: 11,
          fontVariantNumeric: 'tabular-nums',
          color: active ? 'var(--text-dim)' : DIM_TEXT,
        }}
      >
        {label} {value != null ? `${Math.round(value)}%` : '—'}
      </span>
    </div>
  );
}

// Compact rolling bar chart standing in for the old byte-count memory
// readout - one bar per second over the last minute, y-axis fixed 0-100%.
// Click either tab (or the chart itself) to switch which resource is
// plotted; both are sampled every tick regardless, so switching never loses
// history.
export default function ResourceChart() {
  const { samples, latest, appRssBytes } = useResourceUsage();
  const [metric, setMetric] = useState<Metric>('ram');

  const toggle = () => setMetric((m) => (m === 'ram' ? 'cpu' : 'ram'));
  const color = metric === 'ram' ? RAM_COLOR : CPU_COLOR;

  // Right-align the trailing SLOT_COUNT samples; older/missing slots at the
  // left render empty so the bar width stays constant from app start.
  const trailing = samples.slice(-SLOT_COUNT);
  const slots: (ResourceSample | null)[] = [
    ...Array(SLOT_COUNT - trailing.length).fill(null),
    ...trailing,
  ];

  // The RAM tab/chart plots systemRamPercent (accurate, machine-wide
  // pressure - see commands::get_resource_usage's doc comment) rather than
  // this app's own share of it: summing RSS across BrightTable + its
  // webkit2gtk child processes double-counts memory they share, so an
  // app-specific % could read like "300%" despite being a real number.
  // appRssBytes is still shown here, just as a byte count instead of a %,
  // for exactly that reason.
  const title =
    appRssBytes != null
      ? `System RAM: ${latest ? Math.round(latest.systemRamPercent) : 0}% used · BrightTable (approx.): ${formatSize(appRssBytes)} · CPU: ${latest ? Math.round(latest.cpuPercent) : 0}% of system`
      : undefined;

  return (
    <div style={{ padding: '6px 6px 8px' }} title={title}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 5 }}>
        <Tab label="RAM" color={RAM_COLOR} active={metric === 'ram'} value={latest?.systemRamPercent ?? null} onClick={() => setMetric('ram')} />
        <Tab label="CPU" color={CPU_COLOR} active={metric === 'cpu'} value={latest?.cpuPercent ?? null} onClick={() => setMetric('cpu')} />
      </div>
      <div
        onClick={toggle}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 1,
          height: CHART_HEIGHT,
          cursor: 'default',
        }}
      >
        {/* Recessive 50% reference line, one step off the sidebar surface */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: CHART_HEIGHT / 2,
            height: 1,
            background: 'var(--overlay-weak)',
          }}
        />
        {slots.map((s, i) => {
          const v = s ? Math.max(0, Math.min(100, valueOf(s, metric))) : 0;
          const h = Math.max(v > 0 ? 1.5 : 0, (v / 100) * CHART_HEIGHT);
          return (
            <div
              key={i}
              style={{
                flex: '1 1 0',
                minWidth: 1,
                height: h,
                borderRadius: '1.5px 1.5px 0 0',
                background: s ? color : 'transparent',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
