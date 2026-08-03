# App ↔ Immich Server Compatibility

Which Immich server version each ImmAture release has actually been tested against. ImmAture
talks to Immich over its HTTP API (see `app/src-tauri/src/immich/`), so a server upgrade can in
principle change response shapes ImmAture depends on — this table is the honest record of what's
actually been verified live, not a guarantee about untested versions.

| ImmAture version | Immich server version(s) tested | Notes |
|---|---|---|
| 0.2.3 | 2.7.5 (floor), 3.0.1 (confirmed) | `MIN_TESTED_SERVER_VERSION` in `immich/models.rs` is `2.7.5` — not a hard block, just the floor `Test Connection` warns below (Preferences → Library, and an amber sidebar status dot). 3.0.1 was separately confirmed to behave identically for this build. See `requirements.md` §2.7 for the detailed per-version findings log (e.g. confirmed quirks in `/search/metadata` and `/timeline/bucket`). |
| 0.2.4 | 2.7.5 (floor), 3.0.1 (confirmed) | Same floor and confirmed server version as 0.2.3 — no compatibility-relevant server-facing changes since. |

## Keeping this current

Update this table (new row, or widen the existing row's tested version list) every time a new
ImmAture version is built/released — bump `MIN_TESTED_SERVER_VERSION` in `immich/models.rs` too
if the floor itself moves. This is a manual record (there's no automated compatibility test
against a live Immich server), so it's only as good as what's actually been verified before each
build goes out.
