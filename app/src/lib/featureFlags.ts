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

// Temporary kill-switches for features disabled due to a known upstream bug
// rather than anything wrong in BrightTable itself - grep this file when
// investigating "why is X greyed out".

// Immich (confirmed live on the user's v3.0.3, reproduced independently in
// Immich's own web UI - not a BrightTable bug) had a server-side bug where
// tag assignment (PUT /tags/{id}/assets) reported success but didn't durably
// persist the tag<->asset link - tracked upstream as immich-app/immich#23915
// (also #17165, #14194). Root cause: `createTag` wasn't populating the
// `tag_closure` table, so a newly-created tag's own closure row was missing
// and any lookup that walks that table (search-by-tag, browsing a tag) came
// up empty even though the direct tag<->asset link existed - matching
// #23915's exact symptom. Fixed server-side by immich-app/immich@1b3aa9c
// ("fix(server): correct tag create operations", PR #30877), shipped in
// v3.2.0. Note #23915 itself is still shown open upstream (the fix wasn't
// linked to it via a closing keyword), so this isn't a 100%-certified match -
// verify tag assignment actually persists on your server before relying on
// this being re-enabled.
//
// Every "Add to Tag" entry point (SelectionBar's button, each browser's
// context-menu item, and the `addToTag` keyboard shortcut) checks this and
// renders disabled/greyed-out with this string as the explanation instead of
// silently doing nothing, so a user isn't left assuming a tag stuck when it
// didn't. Deliberately scoped to *assignment* only - creating/deleting/
// browsing tags (and Remove from Tag) don't go through the same broken path
// and are left enabled.
//
// Set back to a non-null string if this regresses - every call site keys off
// this one constant.
export const TAG_ASSIGN_DISABLED_REASON: string | null = null;
