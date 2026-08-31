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

// Shared shape for every non-bespoke SelectionBar action (Favorite/Rate stay
// their own dedicated props - see SelectionBar.tsx - since their button
// reflects live state rather than just firing a click). Each of the six
// browser pages builds its own MenuAction[] (same as they already build their
// own ContextMenuItem[]) using useAssetActions.ts's shared handlers, so the
// *labels and gating* can't drift between pages even though each page still
// owns which actions apply to its own context.
export type ActionGroup = 'primary' | 'organize' | 'stack' | 'edit' | 'copyPaste' | 'share' | 'more' | 'destructive';

export interface MenuAction {
  id: string;
  group: ActionGroup;
  label: string;
  disabled?: boolean;
  // Shown as the action's title/tooltip when disabled, so a greyed-out
  // dropdown entry still explains itself instead of just doing nothing.
  disabledReason?: string;
  onClick: () => void;
}

// Buckets a flat MenuAction[] by .group for SelectionBar's dropdown
// rendering - `primary`/`destructive` render as plain inline buttons, the
// rest collapse into Organize/Stack/Edit/Copy-Paste/Share/More ActionDropdowns.
export function groupActions(actions: MenuAction[]): Record<ActionGroup, MenuAction[]> {
  const groups: Record<ActionGroup, MenuAction[]> = { primary: [], organize: [], stack: [], edit: [], copyPaste: [], share: [], more: [], destructive: [] };
  for (const action of actions) groups[action.group].push(action);
  return groups;
}
