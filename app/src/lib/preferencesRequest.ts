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

// Lets UI that lives outside AppShell's tree (e.g. the Change Lens dialog,
// rendered by LensEditProvider) ask AppShell to open Preferences on a tab.
// `overDialogs` stacks Preferences above that dialog instead of behind it,
// so closing Preferences returns to the dialog with its state intact.
export type PreferencesTab = 'library' | 'applications' | 'lenses' | 'sharing' | 'configuration' | 'shortcuts';

export interface PreferencesRequest {
  tab: PreferencesTab;
  overDialogs?: boolean;
}

const EVENT = 'brighttable:open-preferences';

export function requestPreferences(req: PreferencesRequest): void {
  window.dispatchEvent(new CustomEvent<PreferencesRequest>(EVENT, { detail: req }));
}

export function onPreferencesRequest(handler: (req: PreferencesRequest) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<PreferencesRequest>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
