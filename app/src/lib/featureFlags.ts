// Temporary kill-switches for features disabled due to a known upstream bug
// rather than anything wrong in ImmAture itself - grep this file when
// investigating "why is X greyed out".

// Immich (confirmed live on the user's v3.0.3, reproduced independently in
// Immich's own web UI - not an ImmAture bug) has a known server-side bug
// where tag assignment (PUT /tags/{id}/assets) reports success but doesn't
// durably persist the tag<->asset link - see immich-app/immich#17165,
// #14194, #23915. Checked Immich's v3.1.0 (2026-07-29) release notes: no
// tag-related fix listed, so this isn't just a "upgrade and it's fixed"
// situation yet.
//
// Every "Add to Tag" entry point (SelectionBar's button, each browser's
// context-menu item, and the `addToTag` keyboard shortcut) checks this and
// renders disabled/greyed-out with this string as the explanation instead of
// silently doing nothing, so a user isn't left assuming a tag stuck when it
// didn't. Deliberately scoped to *assignment* only - creating/deleting/
// browsing tags (and Remove from Tag) don't go through the same broken path
// and are left enabled.
//
// Set to `null` once Immich ships a real fix to re-enable Add to Tag
// everywhere - every call site keys off this one constant.
export const TAG_ASSIGN_DISABLED_REASON: string | null =
  "Disabled — Immich has a known server bug where tags report as assigned but don't actually save (immich-app/immich#17165). Waiting on an upstream fix.";
