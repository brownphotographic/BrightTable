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

import type { CSSProperties, ReactNode } from 'react';
import type { CopiedLens } from '../lib/lensEdit';
import { copiedLensKeeps, copiedLensName } from '../lib/lenses';
import { Icon } from './Icons';

const fmtFocal = (mm: number) => `${Math.round(mm * 10) / 10} mm`;

// Copy Lens's clipboard at a glance - an aperture badge, the lens name large,
// then chips for what else comes with it. Shown in the "Lens copied" toast
// and at the top of Paste Lens.
export default function CopiedLensCard({ lens, eyebrow, done }: { lens: CopiedLens; eyebrow: string; done?: boolean }) {
  const name = copiedLensName(lens);
  const keep = copiedLensKeeps(lens);
  return (
    <div style={card}>
      <div style={badge}>
        <Icon name="lens" size={26} />
        {done && (
          <div style={tick}>
            <Icon name="check" size={12} />
          </div>
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--accent)' }}>{eyebrow}</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>
          {name}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {lens.focalLength != null && <Chip>{fmtFocal(lens.focalLength)}</Chip>}
          {keep ? (
            <Chip title="The photos keep their own lens; the lens is added as a description note">Note only</Chip>
          ) : lens.noteLens && lens.noteLens.toLowerCase() !== name.toLowerCase() ? (
            <Chip title="Description note">+ note: {lens.noteLens}</Chip>
          ) : lens.noteLens ? (
            <Chip>+ note</Chip>
          ) : null}
          <span style={{ fontSize: 11.5, color: 'var(--text-dimmer)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={lens.fileName}>
            from {lens.fileName}
          </span>
        </div>
      </div>
    </div>
  );
}

function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'var(--overlay-medium)', color: 'var(--text)' }}>
      {children}
    </span>
  );
}

const card: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '12px 14px',
  borderRadius: 12,
  background: 'var(--overlay-weak)',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--accent)',
};
const badge: CSSProperties = {
  position: 'relative',
  width: 46,
  height: 46,
  flexShrink: 0,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--accent)',
  color: '#fff',
};
const tick: CSSProperties = {
  position: 'absolute',
  right: -3,
  bottom: -3,
  width: 18,
  height: 18,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--ok)',
  color: '#fff',
  border: '2px solid var(--dialog-bg)',
};
