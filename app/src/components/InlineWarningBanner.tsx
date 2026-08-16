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

// Extracted verbatim from the amber banner previously duplicated in
// PhotosBrowser.tsx/FoldersBrowser.tsx - pure de-duplication, no behavior
// change.
export default function InlineWarningBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        background: '#4a2f0a',
        color: 'var(--warn)',
        fontSize: 12.5,
        flexShrink: 0,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <span onClick={onDismiss} style={{ cursor: 'default', opacity: 0.8 }}>
        ✕
      </span>
    </div>
  );
}
