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

import { listen } from '@tauri-apps/api/event';

/**
 * `save_settings_folder`/`save_share_vault` (Preferences → Configuration)
 * can wholesale *replace* the backend's config with one adopted from a
 * different file entirely, not just update the one field the caller knows
 * it changed - see their own doc comments. Every long-lived provider that
 * loads its own slice of config once at startup and never refetches
 * (Theme, WindowControls, Applications, Shortcuts, SmartStackSettings,
 * RawOverrides, LibraryStatus - all mounted once at the app root) has no
 * way to notice that on its own, so the backend emits `config-reloaded` for
 * them to catch. Unlike `vaultReadyRetry`'s `vault-ready`, this doesn't need
 * a bounded-backoff fallback - it only ever fires from a user action taken
 * from within the already-running app, well after every listener here is
 * already registered, so there's no missed-event startup race to guard
 * against.
 */
export function onConfigReloaded(reload: () => void): () => void {
  const unlistenPromise = listen('config-reloaded', () => reload());
  return () => {
    unlistenPromise.then((fn) => fn());
  };
}
