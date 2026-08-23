# App ↔ Immich Server Compatibility

Which Immich server version each BrightTable release has actually been tested against. BrightTable
talks to Immich over its HTTP API (see `app/src-tauri/src/immich/`), so a server upgrade can in
principle change response shapes BrightTable depends on — this table is the honest record of what's
actually been verified live, not a guarantee about untested versions.

| BrightTable version | Immich server version(s) tested | Notes |
|---|---|---|
| 0.2.3 | 2.7.5 (floor), 3.0.1 (confirmed) | `MIN_TESTED_SERVER_VERSION` in `immich/models.rs` is `2.7.5` — not a hard block, just the floor `Test Connection` warns below (Preferences → Library, and an amber sidebar status dot). 3.0.1 was separately confirmed to behave identically for this build. See `requirements.md` §2.7 for the detailed per-version findings log (e.g. confirmed quirks in `/search/metadata` and `/timeline/bucket`). |
| 0.2.4 | 2.7.5 (floor), 3.0.1 (confirmed) | Same floor and confirmed server version as 0.2.3 — no compatibility-relevant server-facing changes since. |
| 0.2.6 | 3.1.0 (floor and confirmed) | Floor raised to match the confirmed version — backward compatibility with pre-3.1.0 servers is no longer being tested, so the floor now tracks whatever's actually verified instead of trailing it. |
| 1.0.0 | 3.1.0 (floor and confirmed) | v1.0 launch release — same tested server version as 0.2.6, no compatibility-relevant server-facing changes since. |

## Keeping this current

Since 0.2.6, backward compatibility isn't tested — the floor (`MIN_TESTED_SERVER_VERSION` in
`immich/models.rs`) is always set equal to the confirmed version, not trailed behind it.

`npm run build:flatpak` (via `scripts/bump-version.mjs`) enforces this: every build prompts for
the Immich server version tested (or reads `TESTED_IMMICH_VERSION` from the env non-interactively),
then writes it into both `MIN_TESTED_SERVER_VERSION` and the About dialog's compatibility line. A
build run non-interactively without `TESTED_IMMICH_VERSION` set fails rather than silently keeping
a stale version.

Add a row to this table by hand after each release — that part stays manual since it carries
free-text notes the script can't generate. This is otherwise not an automated compatibility test
against a live Immich server, so it's only as good as what's actually been verified before each
build goes out.
