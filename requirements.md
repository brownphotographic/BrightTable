# ImAture / ImView — Requirements

> A desktop Digital Asset Management (DAM) client for an **Immich** server, focused on
> culling, rating, stacking, and round-tripping RAW files to external editors.
> Target stack: **Tauri + Rust** shell with a web UI. Visual language: GNOME/Adwaita-style
> dark desktop app (Cantarell, `#1c1c1c` canvas, `#3584e4` accent).
>
> This file is the living source of truth for scope. Paste context from any chat here.
> **Status tags in §1/§2 below track the real app** (`app/` — Tauri + Rust + React), not
> the design prototype (`Immich Desktop.dc.html`). A requirement the prototype visibly
> demonstrates but the real app doesn't have yet is tagged ⬜/🟡 and marked "prototype
> only" — see §4.2 for what the prototype demonstrates, and §7 for the detailed, dated
> real-app implementation log these tags are drawn from. §5/§6 are historical, dated
> feedback logs from prototype design iteration and are left as originally written.
> Status tags: ✅ built (real app) · 🟡 partial (real app) · ⬜ planned / prototype only

---

## 1. Product Requirements

### 1.1 Library & navigation
- 🟡 Left sidebar with Photos, Albums, People, Folders, Trash, plus a connection-status
  indicator — all real (§7.1–§7.10). Live asset **counts** are real for Photos, Folders,
  and Trash; Albums/People show no count (they're placeholders, below). The mockup's
  "Stacks" sidebar tab is gone even there (removed per §5 feedback) and was never part of
  the real app.
- ✅ **Photos** timeline grouped by day, with date / place / count headers, newest-first (§7.3).
- ✅ **Folders** view: the real server-side folder tree (Immich's `/view/folder*`
  endpoints, same as Immich's own web UI) with its own thumbnail grid (§7.10).
- ⬜ Albums and People are pure placeholders in the real app (no fake grid data like the
  prototype shows — just a "not built yet" message). Prototype only.
- 🟡 Menu bar (File / Edit / View / Help) is real, but only some items are wired: Select
  All / Deselect All, Refresh Timeline, Preferences, Quit, Stack Selected (§7.13), Smart
  Stack… (§7.14), and the Filters dropdown (§7.11) are real; Upload…, Print…, Recent
  Activity, Copy/Paste Settings, Zoom In/Out, and Sort Photos By are present but do nothing
  yet (§7.15).
- 🟡 Search field exists visually; not wired to Immich search in the real app either.

### 1.2 Selection, detail & viewing
- ✅ Single-click select and checkbox multi-select are real (grid + Folders view), plus a
  floating **selection action bar** (`SelectionBar.tsx`, §7.17) across the top of both the
  Photos and Folders grids whenever the selection is non-empty — Cancel, Favorite (a real
  click target now, not just a keyboard shortcut), Smart Stack, Stack N Photos, and Move to
  Trash. The bottom status bar's redundant text links for the same two actions were removed
  once the bar covered them (§7.17). A right-click **context menu** (**Stack N Photos**,
  **Smart Stack N Photos**, **Unstack** — §7.13) remains for per-tile access. Paste Settings
  and Add to Album from the prototype's bar are deliberately left out — no Copy/Paste
  Settings or Albums feature exists in the real app yet (§1.5, §7.15).
- ✅ Detail view (`Viewer.tsx`) with zoomable preview, EXIF info panel, and a filmstrip of
  the current set (§7.5).
- 🟡 Adjustable thumbnail size and file-type badges are real and always-on. They are **not**
  configurable via Preferences in the real app (Preferences → Configuration is still a
  placeholder, §7.15) — the prototype's "expose as a toggle" framing doesn't apply yet.

### 1.3 Ratings & favorites
- ✅ 1–5 star ratings, editable on thumbnails and in the detail/metadata panel; 0 clears
  (§7.6), including on individual **stack members** in both the grid's expanded stack row
  and the lightbox (§7.16).
- ✅ Favorites (heart) with a favorites-only filter (§7.6, §7.11).
- ✅ Filter panel: minimum rating, favorites-only, media type (photos/videos), file type
  (RAW / JPEG / both) (§7.11).
- ⬜ "Toggle ratings/favorites off globally in Preferences" is prototype only — Preferences
  → Configuration (where this would live) is still a placeholder in the real app (§7.15).
- 🟡 **Rating keyboard shortcuts**: keys `1`–`5` set the rating, `0` clears, `f` toggles
  favorite, applied to the open photo (Viewer) or the entire selection (grid/Folders),
  fully rebindable (§7.8). There's no confirmation toast — the real app has no toast/
  notification system at all.

### 1.4 Stacks
> Stage 1 (manual create, inline expand/collapse, pick, unstack, a first context menu) and
> Stage 2 (Smart Stack auto-grouping) are both now real — see §7.13/§7.14 for the full log.
> No dedicated Stacks tab (confirmed dead even in the prototype, removed per §5) and no
> drag-to-reorder (Immich has no server-side concept of member order to persist it to —
> see §7.13).
- ✅ Create a stack from any 2+ selected thumbnails (Edit menu, status bar link, context
  menu, or `S`) (§7.13).
- 🟡 Inline expand/collapse in the grid and a per-member pick control are real; drag-to-
  reorder is not (§7.13).
- ✅ **Smart Stack** auto-grouping (Name / Version / Time modes), with a live preview
  dialog and persisted settings (§7.14).
- ✅ Stacks are also fully usable from the **detail/lightbox view**, not just the grid: a
  filmstrip badge marks stacked frames, an info-panel section lists every member with a
  **Set Pick** button and lets you preview any non-pick member without leaving the
  lightbox, and per-member star ratings are editable from both the grid's expanded stack
  row and the lightbox — all consistent with the plain (non-stacked) thumbnail/detail UX
  (§7.16).

### 1.5 Editing & metadata
- ✅ Open in RAW Editor / External Editor, app picker, local-path resolution — real (§7.21).
  Preferences → Applications now detects installed native/Flatpak/Snap apps and lets the
  user pick a RAW Editor and an External Editor, each launched on the asset's resolved local
  path from the Viewer toolbar. Launch-only, by design (§7.21) — no file-watching/auto-
  refresh/auto-stacking; see §1.6 for why.
- 🟡 **Metadata panel** is real (`MetadataPanel.tsx` / `MetadataRows.tsx`, §7.6) but with a
  much smaller field set than the prototype:
  - ⬜ IPTC (title, caption, keywords, creator, copyright) — not implemented; Immich's
    asset model has no such fields (§7.6).
  - 🟡 EXIF core (make/model, lens, aperture, shutter, ISO, focal length, dimensions, file
    size) is real but **read-only** — the real app doesn't let you edit capture date/time
    or GPS. Only rating, favorite, and description are editable.
  - ⬜ Arbitrary EXIF tags via ExifTool — not implemented.
  - 🟡 Bulk edit — only rating/favorite have a bulk path, and only via keyboard shortcuts
    over the current grid selection (§7.8), not a Copy Settings → Paste Settings flow.
    Description, and everything else, is single-asset-only (the panel says so explicitly).
  - ⬜ Copy Settings / Paste Settings (adjustments, EXIF/IPTC fields, ratings) — prototype only.

### 1.6 Versioning & round-trip
> The prototype's "Create Version" concept (version lineage, auto-stacked renditions, a
> whole dialog) remains **deliberately out of scope** — the prototype itself simplified this
> away (§6: "let's simplify and comment this out for now... we aren't going to be doing any
> edits directly in this tool"). §7.21 built only the much smaller thing that survived that
> decision: launch the configured editor, then the user manually refreshes once it saves.
- ⬜ Create Version, auto-stacked renditions, version lineage — confirmed dead scope, not
  revisited.
- ✅ RAW-editor round-trip, in the launch-only sense that decision left behind (§7.21).

### 1.7 Sharing & export
> **Prototype only — none of this exists in the real app.** No Sharing preferences content,
> no Share context-menu action, no Export to Folder, no Activity/recent-writes system.
- ⬜ Preferences → Sharing (Flickr/Mastodon/PixelFed/Loops + custom services).
- ⬜ Share via context menu; Export to Folder dialog.
- ⬜ Activity (recent writes) panel.

### 1.8 Printing
- ⬜ Print dialog — prototype only; no printing anywhere in the real app.

### 1.9 Preferences
- 🟡 Tabs: **Library**, **Shortcuts**, and now **Applications** are real and fully
  functional (§7.2, §7.8, §7.21). **Sharing** and **Configuration** still exist as tabs in
  the UI shell but each renders the same literal placeholder message (§7.15).
- ✅ Library, Shortcuts, and Applications config now persist to a real `config.json` in the
  app's config directory via `serde_json` (§7.2, §7.21) — not `localStorage`. A user-
  **chosen** settings folder (rather than the fixed app config dir) is still ⬜ (§2.6).
- ⬜ **New this round, not yet exposed in Preferences at all**: the SD-card/disk import
  feature's own settings (folder-layout choice, last-used source path, §7.22) persist to
  `config.json` the same way, but there's no dedicated Preferences pane for them — the
  choice lives entirely inside the Import dialog itself (§7.22). Revisit if a standalone
  Import settings section turns out to be wanted.

---

## 2. System / Technical Requirements

### 2.1 Platform
- ✅ Desktop app, **Tauri + Rust** core with a web (React/TypeScript) front end — this is
  the real app's actual architecture (§7.1).
- ✅ Flatpak/Snap/AppImage app detection is real (§7.21/§2.5) — Native/Flatpak/Snap apps are
  detected by scanning `.desktop` entries (including Flatpak's and Snap's own desktop-export
  directories); AppImage has no such registry to scan, so it's only reachable via the app
  picker's own custom-executable file-browse fallback, matching the prototype's own design.

### 2.2 Immich integration
- ✅ Connect to an Immich server via endpoint URL + API key (§7.2).
- ✅ `stack.*` scope: create/read/update/delete stacks are real (§7.13).
- ✅ Read assets/timeline (§7.3); real writes so far are asset metadata (rating/favorite/
  description, §7.6), delete/restore/trash (§7.7), and stacks (§7.13).
- ⬜ Wire Search field to Immich search.

### 2.3 Filesystem & round-trip
> "Originals on Disk" path mapping (§7.18 Stage 0) and editor launch (§7.21) are both real
> now; the rest below is still prototype-only or was never part of the plan to begin with.
- ✅ Preferences → Library → "Originals on Disk" (share type, local mount, path mapping) —
  real since §7.18 Stage 0; there's no separate "Verify Access" button, the mapping is just
  used directly wherever a local path needs resolving.
- ✅ Editor launch using a resolved local path (§7.21) — reuses the same
  `paths::resolve_local_path()` §7.18 Stage 0 built.
- ⬜ Export/round-trip destination from a local originals path — still prototype-only in the
  "Create Version" sense (§1.6); SD-card **import**'s destination (§7.22) is a related but
  distinct feature (files coming *in* from a card, not a rendition going back *out*).
- ⬜ Auto-load timeline refresh tied to a version/export write landing (the real app *does*
  have a manual Refresh Timeline, §7.8 — just not an automatic one, since there's no write
  of that kind to trigger it).

### 2.4 Sidecar & metadata compatibility
- ⬜ Sidecar storage (XMP, `.arp`), read/write, ExifTool-backed arbitrary fields — all
  still planned, matching the prototype's own status here.

### 2.5 External applications
- ✅ Detect/launch native, Flatpak, Snap apps; custom executable (also covers AppImage,
  via the same fallback) — real (§7.21).
- ✅ Separate RAW editor / external editor roles — real, Preferences → Applications
  (§7.21; §7.15's placeholder-list mention of Applications is now stale).

### 2.6 Persistence
- 🟡 Library, Shortcuts, and Applications settings are real, persisted to `config.json` in
  the app's config directory (§7.2, §7.8, §7.21) — not `localStorage`. Sharing/Configuration
  prefs aren't real yet (nothing to persist — those panes are still placeholders). A user-
  **chosen** settings folder (vs. the fixed OS config dir) is still ⬜.
- ✅ SD-card import's own dedupe cache (`import_history.json`, §7.22) is a separate file
  from `config.json`, always in the OS app-config dir regardless of a chosen settings
  folder — it's a content-hash cache, not a setting, and churns far more (potentially tens
  of thousands of entries) than anything else persisted so far.

### 2.7 Immich server compatibility
- ✅ **`MIN_TESTED_SERVER_VERSION`** constant (`immich/models.rs`) — not a hard technical
  floor (the app doesn't refuse to connect below it), just the honest boundary of what's
  actually been verified end-to-end. `Test Connection` compares the server's reported
  version and surfaces a warning (Preferences → Library, and an amber sidebar status dot)
  when the connected server is older, instead of silently leaving odd behavior unexplained.
- **Compatibility log** (bump `MIN_TESTED_SERVER_VERSION` and update this list whenever a
  new server version gets verified, or a real version-dependent behavior difference is found):
  - **Immich 2.7.5** — current floor. Trash, ratings/favorites, Filters, Folders, and Stacks
    (§7.7, §7.6, §7.11, §7.10, §7.13) all confirmed live. Notably, `/search/metadata` and
    `/timeline/bucket` do **not** populate their `stack` field at all on this version (the
    key is simply absent from the response, confirmed live) — Stacks works anyway because
    §7.13 cross-references `GET /stacks` client-side rather than trusting inline asset data,
    so this isn't actually a version-gated feature in practice, just a discovered quirk.
  - **Immich 3.0.1** — user upgraded to this mid-session; ✅ verified live. `/search/metadata`
    and `/timeline/bucket` still don't populate/include `stack` either (same as 2.7.5 — the
    inline-stack-info feature genuinely hasn't shipped in any released version yet, not a
    quirk specific to the old one), and `GET /stacks` returns the identical shape. No code
    changes needed; Stacks (§7.13) behaves identically on both versions.

## 3. Open questions / notes
- Confirm Immich API surface for version-as-stack mapping and cover assignment.
- Define the sidecar schema for version lineage (which suffixes, ordering, pick).
- Decide conflict handling when Immich DB metadata and sidecar metadata disagree.
- **Scope the rest of Immich's metadata surface for the real app** (raised, not yet
  prioritized): **Tags** — a hierarchical tag menu (view + add/remove), People
  (view-only), Location (view + edit GPS/place), Date/time (view + edit capture time).
  Rating/favorite/description are already done (§7.6) — this would extend the same
  metadata panel to the remaining fields Immich's API exposes.
- **Bulk metadata update** (raised, not yet prioritized) — two sub-features, both needing
  write access to EXIF/IPTC fields beyond what's currently editable (rating/favorite/
  description only, per §1.5), so they'd need scoping alongside the metadata-surface item
  above:
  1. **Time zone / DST conversion** — bulk-shift capture date/time across a selection to
     correct for timezone or daylight-saving offset errors (e.g., camera clock set wrong,
     or footage shot across a timezone change).
  2. **Lens profiles for vintage/uncoded lenses** — user-curated, named lens profiles that
     bulk-write multiple EXIF/IPTC fields at once (lens model, focal length, max aperture,
     etc.) to a selection. Targeted at manual/vintage/uncoded lenses that don't report data
     to the camera body, so Immich/EXIF has nothing to read. Will need research help
     identifying correct field values per lens model when the user builds out the profile
     set.

---

## 4. Context from prior chats

### 4.1 Key decisions & rationale
- **Backend: Immich, not PhotoPrism.** Both run on the user's server. Immich was chosen as the
  backend because it has a first-class **stacks** concept (group + cover/primary) exposed over its
  API, which is core to this app's culling/stacking workflow. The earlier PhotoPrism prototype is
  retained as `PhotoPrism Desktop.dc.html` for reference only.
- **Shell: Tauri + Rust, not Electron.** The original ask said "PWA + Electron," but a PWA can't do
  the required OS integration (launch external editors, system print dialog, filesystem browse,
  enumerate installed apps). Among native shells, **Tauri** was chosen over Electron and GTK4 because:
  it keeps the existing web UI almost verbatim, ships far lighter on Linux (system WebKitGTK vs.
  bundled Chromium), sits well in GNOME, and gives first-class shell/dialog/FS APIs. Secondary
  driver: the user wants to **learn Rust**. GTK4/libadwaita was considered (most-native, best perf)
  but rejected for now because it abandons the web UI and has a steeper curve.
- **App name: ImView.** Window title / About reflect this; "Immich" is retained only where it names
  the server (Library connection, status, API-key hint). Project/file may still read "Immich Desktop".
- **Versions are an app-layer concept.** Immich has stacks but no native "versions"; version lineage
  is stored in this app's sidecar and mapped onto Immich stacks for display (see §1.6, §2.4).

### 4.2 Build status snapshot (prototype = `Immich Desktop.dc.html`)
- The HTML file is a **functioning front-end prototype** (real state, interactions, dialogs) — it is
  *not* yet wired to a live Immich server or the OS. Actions that need the Tauri/Rust layer
  (launching editors, real print/file dialogs, app enumeration, stack/rating API writes) currently
  fire a toast and mutate local/`localStorage` state.
- Verified working in-prototype: timeline, folders, selection, stacking (incl. inline expand /
  drag-reorder / pick), ratings (thumbnail + detail + filters + on/off pref), favorites, filters
  pane, app picker w/ Flatpak/Snap/AppImage detection, file chooser, print dialog, full Preferences
  incl. **Shortcuts editor**, **rating keyboard shortcuts (1–5 set, 0 clears, rebindable)**, and the
  **metadata editing panel** (IPTC/EXIF/ExifTool fields + add custom tag) with **Copy → Paste
  Settings** bulk edit (adjustments / metadata fields / ratings; four paste entry points, `Ctrl+C`/`Ctrl+V`).

### 4.3 Suggested next steps (historical — superseded by §7)
> Written before the real app existed. Kept for history; **§7 is the current, accurate log**
> of what's actually been built since.
- Map prototype actions → Immich endpoints: `searchAssets` for the timeline/Search field and
  filters; `POST/PUT/DELETE /stacks` for stack create/cover/unstack; asset rating + favorite writes.
- Scaffold Tauri command signatures + a generated Rust client stub as a concrete target for the
  Rust learning curve.
- Wire the stored shortcut map's global dispatcher to all actions (rating keys already dispatch).

---

## 5. UI refinement (feedback round — June 2026)

> User feedback, wording preserved verbatim. Each item gets a status tag as we work through it.
> ✅ done · 🟡 in progress · ⬜ not started

**App name**
- ✅ Look through the UI and change the name of the app to ImmAture
  - (Supersedes the earlier "ImView" decision in §4.1.)

**Thumbnail / Photos view**
- ✅ Add a zoom level slider in bottom right. Currently it states Photos 100%.
- ✅ On the Photos view (accessible in the left hand side bar), add a timeline bar on the right side
  of the screen to allow the user to quickly jump to a particular spot in the whole timeline. Copy
  how Immich did this.
- ✅ Top right of the thumbnail browser view is a label called Newest First., then further left is
  "Photos N Items". This is redundant with the bottom bar of the screen (lower left shows N assets).
  Let's kill this top bar. Default the sort order to Newest first. Then add a the sort order in the
  View menu.

**Stacks view**
- ✅ On the Stacks view, which is accessible in the left hand side bar: remove this option (just this
  view where it shows just stacked images). This view serves zero purpose.
  - (Inline stack expand/collapse + Smart Stack in the grid stay — only the sidebar Stacks *tab* goes.)

**Preferences**
- Library:
  - ✅ For Immich Server: Add an option to let the application work over LAN, or over tailscale when
    tailscale is connected (user enters a URL from tailscale). So 2 boxes: one for the LAN endpoint
    url, and one for the Tailscale url.
- Sharing:
  - ✅ Can you create more screens for how to handle the setup of the flickr API to start with to
    connect with that?

**Activity**
- ✅ Button looks like Downloads. Change it. Also move to the bottom of the screen into the bottom bar.

**Image preview screen (shown when the user double clicks a thumbnail)**
- ✅ Always make the image default to fit the width of the viewable area and ensure this grows as the
  user turns on or off the thumbnails, metadata, or otherwise shrinks or grows the screen.
- ✅ Let user press l for lights out to only show the image. Let user press f for full screen (again
  just show the image).
- ✅ Let user press z to zoom to 100%.
- ✅ Add a zoom slider bottom right of window like thumbnail views.
  - (Superseded July 2026 — moved into the **top toolbar** and the floating control removed; see §6.)
- ✅ Add a loupe option like apple aperture had: the image stays at fit width, but then a circular
  loupe is placed where the user hovers their cursor and shows at 100% within the loupe. Just lookup
  how Apple did it and let's go with that.
- ✅ I'm not sure how the Create Version works. We aren't going to be doing any edits directly in this
  tool. So perhaps let's simplify and comment this out for now. There's already a Open In Raw Editor
  button (which should be available only for raw type files like dng, raf etc), and when the image
  gets saves back to the same folder it should appear.
- ✅ Change the 'External Editor' button too "Open in Ext. Editor"

**Print preview**
- I want to get this right as I do a lot of printing.
  - ✅ Remove the Color and Grayscale options
  - ✅ Paper - this should reflect all papers added in the system for that printer
  - ✅ Need an option for 'printed image size' - which could be less then the paper size. Let the user
    enter different sizes e.g. via text boxes. Always lock the aspect ratio.
  - ✅ There are settings like dpi that the user needs to have access to.
  - I will come up with more requirements on this later so let's do the above, then revise when I
    think about it more.

---

## 6. UI refinement (feedback round — July 2026)

> User feedback, wording preserved verbatim where given. ✅ done · 🟡 in progress · ⬜ not started

**Image preview screen (photo viewer)**
- ✅ Don't like the double zoom slider. Moved the **photo zoom slider into the top toolbar**
  (with −/+ buttons and a 100% reset) and **removed the floating zoom control** that sat over
  the image.
- ✅ Dislike the floating filename/location caption over the image — **removed** the bottom
  gradient caption (filename + format badge); that info already lives in the top toolbar.
- ✅ On the thumbnail-size slider in the status bar, **removed the `%`** (meaningless there) and
  added a **"Thumbnails"** text label before the magnifier icon.

**Buttons (global)**
- ✅ Standardized toolbar and dialog buttons to **icon + text**. Selection bar (Paste / Favorite /
  Add to Album), viewer toolbar (Unstack / Open in RAW / Open in Ext. Editor / Print / Loupe /
  Info / Filmstrip), and all modal footers (× on Cancel/Close, a fitting glyph on each primary
  action). Toggles keep their active-blue state.

**Print preview**
- ✅ **Print resolution** is now a **dropdown** driven by the selected printer's own dpi list,
  each option annotated (Highest quality / Standard / Draft) and swapping with the printer —
  replacing the earlier segmented buttons.

**Photos view — right-hand timeline**
- ✅ Rail shows **year labels** proportional to library content instead of a cluttered per-day
  list; hovering pops a **month bubble** (e.g. "December 2023") at the cursor. Anchored
  newest-at-top → oldest-at-bottom over the whole library, thumb synced to scroll.

**Filmstrip (viewer)**
- ✅ Filmstrip thumbnails now show their **star rating** (white stars in a dark pill, bottom-left),
  matching the grid thumbnail format; unrated frames show no pill.

---

## 7. Real app implementation (July 2026)

> Until now, `Immich Desktop.dc.html` was the **only** thing that existed — a design-tool
> prototype (loads React/Babel from a CDN, needs the claude-design preview host; can't run
> standalone). This section covers the **real, running Tauri app**, started this round, which
> is a separate codebase from the prototype. The prototype stays as the visual/interaction
> reference; the real app is what now actually talks to a live Immich server.

### 7.1 Project layout
- ✅ New project at `app/` (repo root, alongside the untouched `.dc.html` + `support.js`):
  `app/src/` (React + Vite frontend, TypeScript), `app/src-tauri/` (Rust backend, Tauri v2).
  Scaffolded Cargo-first (`cargo tauri init`) with a plain Vite dev server, no extra tooling
  beyond what Vite needs.

### 7.2 Library preferences (real, not mock)
- ✅ **Preferences → Library** pane (`PreferencesLibrary.tsx`) ported from the prototype's
  layout: Connect over LAN / Tailscale / Auto, LAN endpoint, Tailscale URL, API key.
- ✅ **Test Connection** hits the real server (`GET /server/version` + `GET /users/me` with
  `x-api-key`) and reports the actual version + account email, or a real error.
- ✅ **Save** persists `LibraryConfig` to `config.json` in the app's config dir (or a
  user-chosen settings folder later) via plain `serde_json` — not `localStorage`.
- ✅ **Safety net**: a **Read-only mode** toggle (default **ON**) and a **Max assets per
  action** cap (`max_writes_per_batch`, default 25), both enforced server-side in Rust.
  Every write command (`delete_assets`, `restore_assets`, `empty_trash`,
  `update_asset_metadata`) refuses outright if read-only, and refuses if the number of
  assets touched by *that one call* exceeds the cap. This is a per-action limit, not a
  cumulative session counter (corrected from an earlier design) — there's no running
  total to reset, so it can't be worn down across many small actions in one sitting.
  Both fields live in the Preferences → Library → **Safety** section and save
  immediately (independent of the Connect/Save flow).
  - ✅ Now exercised by real UI: grid multi-select delete, Viewer single-asset delete,
    Trash restore/delete-forever/empty-trash (see §7.8) all route through this gate.
- ⬜ "Originals on Disk" (share type / local mount / Immich path mapping, §2.3) exists in the
  UI but isn't wired to any real filesystem check yet — same status as the prototype.

### 7.3 Main browser view (real Immich data)
- ✅ **Photos** view (`PhotosBrowser.tsx`) reads the **real** timeline: month buckets from
  `GET /timeline/buckets`, but per-bucket asset details now come from `POST
  /search/metadata` (`withExif: true`, paginated) instead of `GET /timeline/bucket`.
  Immich's `/timeline/bucket` response turned out to be a compact **columnar** shape
  (parallel arrays) that's missing `originalFileName` and EXIF `rating` entirely; switching
  the per-month asset fetch to `/search/metadata` gets file type + star rating at the same
  "one call per visible month" granularity, without reintroducing a request-per-thumbnail
  cost. Handled in `immich/mod.rs` / `immich/models.rs`.
- ✅ **Virtualized grid**: `@tanstack/react-virtual` windows the DOM so only months near the
  viewport are ever mounted; asset *data* (ids/dates, cheap) is cached permanently per month
  once fetched, but thumbnail `<img>` DOM is torn down when scrolled away — bounds memory for
  a huge library instead of every visited month accumulating forever.
- ✅ Real thumbnails via a custom `immich-thumb://` URI scheme registered in Rust: proxies an
  authenticated fetch to Immich server-side, so the **API key never reaches the webview's JS
  or network tab** — only `immich-thumb://` URIs ever show up in devtools.
- ✅ **Persistent on-disk thumbnail cache** (`thumb_cache.rs`), keyed by asset id + size.
  Fixed a real race condition along the way: concurrent requests for the same in-flight asset
  (e.g. switching views doesn't cancel an in-flight fetch) used to share one temp file path,
  where an overlapping write could corrupt it into a permanently-broken cache entry; each write
  now gets a unique temp filename so concurrent writers can never collide.
- ✅ **Thumbhash blur-up placeholders**: Immich already ships a tiny `thumbhash` per asset in
  the bucket data; decoded client-side (`thumbhash` npm package) for an instant blurred
  preview with zero network cost while the real thumbnail loads in behind it.
- ✅ Grid uses the **`thumbnail`** size (~30KB), not `preview` (~1MB, full-viewer resolution) —
  the single biggest performance fix; `preview` is reserved for a future detail/lightbox view.
- ✅ Disk cache reads/writes run via `tokio::task::spawn_blocking`, not directly on the async
  task — otherwise a burst of simultaneous thumbnail requests (a grid scrolling into view at
  once) would queue up behind Tokio's small worker pool even on cache **hits**.
- ✅ Failed thumbnails (real `404`s from Immich — some assets genuinely have no generated
  thumbnail yet, e.g. a stuck/failed thumbnail-generation job server-side) show a quiet,
  clickable retry placeholder instead of the browser's broken-image glyph.
- ✅ Thumbnails show **real** star rating and favorite badges (from live
  `AssetSummary.rating` / `isFavorite`, sourced from `/search/metadata` per above) and a
  file-extension badge (RAW formats styled amber) — see §7.7 for how these get edited.
- ⬜ Month/day labels' date parsing needed a fix: `new Date("2026-06-01")` parses bare
  (time-less) date strings as **UTC midnight**, then `toLocaleDateString()` renders that back
  in the local timezone — shifting the displayed month/day back one for any timezone behind
  UTC. Fixed via manual y/m/d parsing (`parseCalendarDate` in `PhotosBrowser.tsx`); worth
  remembering as a general trap anywhere else a bare date string gets displayed.
- ⬜ The right-hand year-rail scrubber (§1.1/§6) has **not** been built in the real app yet —
  Photos is a plain scrollable grid for now.

### 7.4 Known real-world finding
- A batch of ~34 assets (and a handful of stragglers elsewhere) return a **persistent,
  reproducible 404** from this server's `/assets/{id}/thumbnail` — not flaky, confirmed by
  retrying the same asset IDs multiple times over several minutes with identical results.
  Likely a stuck/failed Immich thumbnail-generation job for that batch. Not fixable
  client-side — needs checking Immich's own **Administration → Jobs → Generate Thumbnails**.

### 7.5 Detail viewer (`Viewer.tsx`)
- ✅ Full-screen lightbox opened by double-click (grid) or a hover "⤢" icon. Fit-width
  preview with a 3-layer crossfade: thumbhash blur → cached `thumbnail` → full-res
  `preview`. Zoom lives as a **slider in the top toolbar** (25–400%, with −/+ and a 100%
  reset) — no floating control over the image.
- ✅ **Loupe** (Apple Aperture–style): header toggle overlays a circular 3× magnifier that
  follows the cursor over the already-loaded preview.
- ✅ **Filmstrip** toggle — a windowed (±120 items) strip of the current set, each tile
  showing its real star rating.
- ✅ **Info** toggle renders the same `MetadataRows` used in the grid's metadata panel
  (§7.6) alongside the image.
- ✅ Keyboard: `←`/`→` prev/next asset, `Escape` closes, `i` toggles Info, `m` toggles
  Filmstrip, `f` toggles favorite, `l` toggles the Loupe, `0`–`5` set/clear rating,
  `Delete` opens a confirm dialog to move the asset to Trash (all rebindable, §7.8).
- ✅ Header **"Move to Trash"** button — real, gated by the same safety net as the grid
  (see §7.7).
- ⬜ The prototype's **lights-out** (`l`) and **fullscreen** (`f`, image-only) keys from
  §6 have not been ported — those letters are now used for Loupe and Favorite instead
  (§7.8). Revisit if lights-out/fullscreen viewing is still wanted, under different keys.

### 7.6 Ratings, favorites & metadata (real)
- ✅ Star rating (1–5, click to set, click-again-on-current to clear) and favorite heart
  are real and live on both the grid thumbnails (`AssetThumb.tsx`) and the metadata
  panel/Viewer info pane, backed by `PUT /assets/{id}` via the `update_asset_metadata`
  command (rating / `isFavorite` / description, each field optional so a call never
  clobbers fields it didn't mean to touch).
- ✅ **Metadata panel** (`MetadataPanel.tsx` + `MetadataRows.tsx`) — toggled by the
  toolbar **Metadata** button, targets the focused asset (grid selection or Viewer).
  Read-only: taken date/time, camera make/model, lens, exposure (aperture/shutter/ISO/
  focal length), dimensions, file size. Editable: rating, favorite, and a description/
  caption field (debounced, saves on blur).
- 🟡 The Metadata **panel** (mouse-driven) still applies to **one asset at a time** (it says
  so explicitly) — no bulk/multi-select edit there, unlike the prototype's Copy/Paste
  Settings flow (§1.5), which remains prototype-only. The **keyboard** shortcuts for
  rating/favorite are the one exception: they apply in bulk over the current grid
  selection (§7.8).
- ⬜ **Title, keywords, creator, copyright** from the original mockup (§1.5) are **not**
  implemented in the real app — Immich's asset model has no such fields, so this was
  scoped down to what the API actually supports (rating / favorite / description /
  read-only EXIF). Tags, People, Location editing, and structured date/time editing
  remain an open, unscoped thread (see §3).

### 7.7 Delete & Trash (real)
- ✅ **Soft delete → Trash**: grid multi-select `Delete` key or the status-bar
  **"Move to Trash"** button; Viewer's header **"Move to Trash"** button for the open
  asset. Both go through a `ConfirmDialog`, then `DELETE /assets` with `force: false`.
  Deleted assets are removed from local grid state immediately on success.
- ✅ **Trash tab** (`Sidebar.tsx`, below Folders) with a live count, rendering
  `TrashBrowser.tsx` — a plain (non-virtualized) CSS grid of trashed assets loaded via
  `get_trashed_assets`, which pages through `GET /timeline/buckets` + `GET
  /timeline/bucket` with a real `isTrashed: true` query param. (Originally implemented
  against `POST /search/metadata` with `isTrashed: true` in the request body — a real bug,
  caught by the user live: confirmed against Immich's OpenAPI spec that endpoint's
  `MetadataSearchDto` has no `isTrashed` field at all, so the value was silently dropped
  and the "Trash" view was actually loading the **entire non-trashed library** (tens of
  thousands of assets) instead of the ~30 actually in the trash. Fixed and live-verified
  against the real server: now correctly returns just the trashed assets.)
- ✅ Per-tile hover actions: **Restore** (`POST /trash/restore/assets`) and
  **Delete Forever** (`DELETE /assets` with `force: true`, behind its own
  `ConfirmDialog`), each with inline busy/error state on the tile.
- ✅ **Empty Trash** button in the Trash view's bottom bar (hidden when empty), behind a
  `ConfirmDialog`, calling `POST /trash/empty`.
- ✅ All of the above are gated by the same **read-only** + **max assets per action**
  safety net as every other write (§7.2); `empty_trash` checks the cap against however
  many assets are currently trashed, since it has no caller-supplied id list of its own.
- 🟡 No bulk multi-select **within** the Trash view itself (restore/delete-forever are
  one-at-a-time, or all-at-once via Empty Trash) — a deliberate scope cut, since Trash is
  normally a short-lived, low-traffic view that didn't seem to warrant duplicating the
  grid's full selection model.
- ✅ `/trash/restore/assets`, `/trash/empty`, and the trash-listing endpoints above have
  all been **live-verified** against the user's real server (confirmed a correct, small
  trashed-asset count instead of the pre-fix bug above).

### 7.8 Customizable keyboard shortcuts (real)
- ✅ **Preferences → Shortcuts** tab (`PreferencesShortcuts.tsx`) is now real, matching the
  mockup's interaction: click a binding to enter capture mode ("Press a key…"), press any
  key/combo to assign it, `Esc` cancels, **Reset to defaults** restores the built-in set.
  Persisted via a new `shortcuts: HashMap<String, String>` field on `AppConfig` (Rust) and
  `save_shortcuts` command — stored as overrides only, so the frontend's own defaults
  (`DEFAULT_SHORTCUTS` in `lib/shortcuts.tsx`) fill in anything missing, meaning a future
  new shortcutable action never needs a config migration.
- ✅ Covers every keybinding that's actually wired to a real action today: **Open photo**
  (Enter), **Select all** (Ctrl+A), **Deselect / close** (Escape), **Move to Trash**
  (Delete), **Previous/Next photo** (←/→), **Toggle info panel** (I), **Toggle filmstrip**
  (M — moved off F to make room for Favorite below), **Toggle favorite** (F), **Toggle
  loupe** (L), **Clear rating** (0), **Rate 1–5 stars** (1–5), **Refresh timeline** (F5),
  **Open preferences** (Ctrl+,). `PhotosBrowser.tsx`, `FoldersBrowser.tsx`, `Viewer.tsx`,
  and `App.tsx`'s own keydown handlers all read live bindings from a shared
  `ShortcutsProvider`/`useShortcuts()` context instead of hardcoded key checks; `MenuBar.tsx`
  renders the current binding next to Select All / Deselect All / Refresh Timeline /
  Preferences instead of a static label.
- ✅ **Favorite/rating shortcuts apply to the whole current selection at once** in the grid
  (`PhotosBrowser.tsx`/`FoldersBrowser.tsx`, via a bulk `commitEditMany`), matching the
  design prototype's `rateTarget`/`favTarget` behavior — distinct from the Metadata
  panel's mouse-driven single-asset-only editing (§7.6). In the Viewer they apply to just
  the open asset. Rating shortcuts **set** the value directly (0 clears); they don't
  toggle like the thumbnail/panel star click does.
- ✅ **Refresh Timeline** and **Open Preferences** are now real keyboard shortcuts, not just
  menu-item labels — previously `F5`/`Ctrl+,` were shown in the menu but did nothing unless
  clicked.
- ✅ Fixed a latent bug while centralizing this: none of the old per-component key handlers
  checked whether the user was typing in a text field, so e.g. typing "i" or "f" into the
  Viewer's caption box would toggle the Info/Filmstrip panels out from under the cursor.
  All shortcut handling now shares an `isTypingTarget()` guard (input/textarea/contentEditable).
- ✅ While the Shortcuts pane is capturing a new binding, every other consumer (grid, viewer,
  app-level) ignores keydowns entirely via a shared `capturing` flag in the same context —
  otherwise the very key being captured (e.g. pressing "A" to rebind Select All) would also
  fire its *old* binding in the view underneath the Preferences dialog.
- 🟡 **Stack/Copy/Paste Settings** shortcuts from the mockup are still **not** included —
  those don't exist as real behavior in the app at all yet (no real Stacks feature).

### 7.10 Folders view (real)
- ✅ **Folders tab** (`FoldersBrowser.tsx`) reflects Immich's **real server-side folder
  structure** — the same one Immich's own web "Folders" view shows — not capture date.
  Backed by two endpoints Immich's own frontend uses for exactly this
  (`GET /view/folder/unique-paths` for the tree, `GET /view/folder?path=` for a folder's
  direct-child assets), wrapped as `get_folder_paths`/`get_folder_assets` Tauri commands.
  Requires the configured API key to have the `folder.read` permission. (Originally
  shipped as a synthetic Year → Month tree over capture-date timeline buckets, matching
  the design prototype's placeholder grouping — replaced once real folder browsing was
  confirmed to look wrong against the user's actual library, e.g. inventing a "1970"
  bucket and hiding real folders like "1979 Rob through the years"/"VSCO edits".)
- ✅ `app/src/lib/folderTree.ts` builds the tree client-side from the flat list of
  asset-holding directory paths, folding chains of asset-less single-child directories
  into one display node (e.g. a whole library mount collapsing into one row) — the same
  approach as Immich's own `tree-utils.ts`. Depth is whatever the real filesystem is (this
  library is flat `YYYY/` for older years but `YYYY/MM/` from a later year onward), not a
  fixed two-level shape.
- ✅ Left tree pane: **All Originals** (every asset-holding folder in the tree) plus the
  real recursive folder tree (chevron toggles expand/collapse). Selecting a container
  folder recurses over its subfolders' assets; selecting a leaf folder shows just its own
  direct children — matching real folder semantics (non-recursive per Immich's own
  `originalPath LIKE 'path/%' AND NOT LIKE 'path/%/%'` query). No per-row counts (the
  folder API doesn't expose them upfront, and Immich's own UI doesn't show them either).
- ✅ Section-level virtualization (`@tanstack/react-virtual`, same approach as Photos)
  scoped to whichever real folders feed the selected node — selecting "All Originals"
  windows across every folder exactly like the Photos timeline windows across months, so
  a large library doesn't render everything at once. Row-height estimates are a fixed
  guess (folder sizes aren't known upfront) corrected after each section renders.
- ✅ Full parity with the Photos grid: multi-select (click / Ctrl+click / Shift-range),
  Move to Trash, rating/favorite keyboard shortcuts applied in bulk over the selection
  (§7.8), the Metadata panel, and the Viewer (prev/next navigate within the selected
  node's assets). The per-tile rendering was extracted out of `PhotosBrowser.tsx` into a
  shared `AssetTile.tsx` component so both views render thumbnails identically.
- ✅ Switching tree nodes resets scroll position and selection, so a selection made in one
  month can't silently carry over into an unrelated one.
- 🟡 Stack-count badges from the design prototype are not shown — there's no real Stacks
  feature yet (§7.15/§4.3), consistent with the rest of the real app.

### 7.11 Filters (real)
- ✅ The menu bar's **Filters** dropdown (previously a static "not wired up" placeholder)
  is now real: **Minimum rating** (star picker, 1–5, click-again clears), **Favorites
  only** toggle, and **File type** (RAW + JPEG / RAW / JPEG) segmented control, plus a
  **Clear all filters** button and a live count badge on the Filters button itself.
- ✅ Filtering is applied client-side to both the **Photos** and **Folders** grids (shared
  `matchesFilters` predicate in `lib/filters.ts`) — it only ever hides already-loaded
  assets from the grid, selection, and Viewer prev/next; it doesn't change what gets
  fetched from Immich.
- ✅ **Performance fix**: re-filtering touches every asset ever loaded into a view's cache,
  not just what's currently on screen, which made filter clicks feel laggy against a
  large, heavily-scrolled real library (~90k assets). Fixed with `useDeferredValue` on the
  filters value in both `PhotosBrowser.tsx` and `FoldersBrowser.tsx`, so the panel's own
  UI (checked star, switch position, count badge) updates instantly while the grid
  recompute lags a frame behind under load. User-confirmed snappier after the fix.
- ✅ Extracted a shared `Switch` toggle component (`components/Switch.tsx`, out of
  `PreferencesLibrary.tsx`) reused by both the Filters panel's Favorites-only toggle and
  the Preferences read-only toggle.

### 7.13 Stacks — Stage 1 (real)
> Built against Immich's live OpenAPI spec (GitHub `main` branch), then corrected against
> the user's actual server (2.7.5) when reality diverged — see the compatibility note below.
- ✅ **Backend** (`immich/mod.rs`/`models.rs`, `commands.rs`): `create_stack` (`POST
  /stacks`, first id = primary), `get_stack`/`list_stacks` (`GET /stacks/{id}` /
  `GET /stacks`), `set_stack_pick` (`PUT /stacks/{id}`, deprecated in Immich's spec but
  still the only endpoint that does this), `delete_stack` (`DELETE /stacks/{id}`, always
  dissolves the whole stack — no partial-member-removal action anywhere in the UI, matching
  the prototype). All four gated by the same read-only + max-writes-per-batch safety net
  as every other write (§7.2); `delete_stack` fetches the stack first to check its member
  count against the cap, mirroring `empty_trash`'s pattern.
- ✅ **Grid**: a stack's pick shows a count badge (top-right, replacing the hover-open icon
  on hover) — click to expand a full-width band in place of that tile (`StackBand.tsx`),
  showing every member (reusing `AssetTile`), a gold ring + ★ overlay to change the pick,
  and **Unstack**/**Collapse** buttons. Non-pick members are hidden from the flat grid,
  selection, keyboard nav, and the Viewer's prev/next (`lib/stacks.ts`'s
  `isHiddenStackChild`), matching the prototype's `visibleAssets()`/`isHiddenChild()`.
- ✅ **Create Stack** (2+ selected): the Edit menu's previously-inert **"Stack Selected"**
  item, a new **`S`** keyboard shortcut (rebindable, §7.8), and a **"Stack N Photos"** link
  in the bottom status bar — all three call the same action.
- ✅ **First context menu** (`ContextMenu.tsx`) — the real app had none before this. Right-
  click a tile for **"Stack N Photos"** (2+ selected) and/or **"Unstack"** (if that tile is
  a stack); deliberately not extended to Delete/Favorite/rating in this pass. "Set as Stack
  Pick" only ever makes sense on a *member* tile, and members are only ever visible inside
  an already-expanded band (which has its own ★ control for exactly this) — so it's not in
  the menu at all, unlike the prototype's context menu which could reach it from within a
  band too.
- ✅ **Viewer**: an **Unstack** button in the header when the open asset is a stack's pick.
- 🟡 **No drag-to-reorder** — confirmed via Immich's OpenAPI spec that a stack is just an
  asset list + one `primaryAssetId`, with no server-side member-order field at all. The
  prototype's "drag to reorder, leftmost = pick" is pure client-side fiction with nothing
  real to persist it to; "reorder" here means "click a member to make it the pick" instead
  (a real, persistable action), per an explicit decision with the user.
- ✅ **Smart Stack** (Name/Version/Time auto-grouping) — Stage 2, now real, see §7.14.
- ⬜ **No dedicated Stacks tab** — confirmed dead even in the prototype (§5: removed from
  the sidebar; only inline expand/collapse + Smart Stack were meant to remain).
- 🐛 **Real bug found and fixed**: initially assumed (per Immich's live OpenAPI spec) that
  `/search/metadata`/`/timeline/bucket` inline stack membership on every asset, avoiding an
  extra fetch. Confirmed live against the user's real server (2.7.5) that neither endpoint
  populates (or even includes) the `stack` field at all — stacks the user created were
  invisible after any refresh, and changes made in Immich's own web client didn't show up
  either. The write side (`POST /stacks` et al.) worked fine throughout; only the "inline
  read" assumption was wrong for this server version. Fixed by fetching `GET /stacks` once
  per browser mount and cross-referencing client-side (a `stackByAssetId` map, overlaid in
  `filteredAssetCache`) instead of trusting each asset's own `.stack` field — works
  regardless of server version, so no version gate was actually needed for this feature.
  See §2.7 for the compatibility-tracking mechanism this prompted.

### 7.14 Stacks — Stage 2: Smart Stack (real)
> Ported from the prototype's `autoGroup` dialog (`Immich Desktop.dc.html`), adapted to
> real `AssetSummary` fields (`fileName`/`fileExtension` split into a base name,
> `fileCreatedAt` parsed for capture time) in place of the mockup's synthetic `base`/`ext`/`ts`.
- ✅ **Grouping algorithm** (`lib/smartStack.ts`, pure, no React): three modes, all ported
  faithfully —
  - **Name**: exact match on filename base (no extension), e.g. a RAW+JPEG pair.
  - **Version**: a user-entered pattern groups a source image with its renditions — this is
    the mode that fits the user's real ART/RawTherapee workflow (`" - converted"`, `" -
    converted 1"`, …). Supports `*` wildcards (e.g. the default `*converted*`, matched
    anywhere in the base name regardless of exact separator/spacing); without a leading
    wildcard, a bounded run of separator characters is still allowed before the literal
    text, and without a trailing wildcard the original "optional trailing version number"
    convention (` 2`/`-2`/`_2`) still applies.
  - **Time**: chain-clusters frames whose capture timestamps are within a tolerance of the
    previous frame, using the same 19-step 0.1s–10s scale as the prototype.
  Pick assignment per mode (`pickForGroup`): Time → earliest frame; Version → the member
  matching the group's un-suffixed key **and** RAW, else any exact-key match, else first
  RAW, else first; Name → first RAW, else first. Candidates are the current selection in
  full — unlike the prototype, already-stacked assets are **not** excluded (see the
  auto-merge bug-fix bullet below).
- ✅ **Dialog** (`components/SmartStackDialog.tsx`): mode selector, mode-specific control
  (suffix text field / tolerance slider), and a live-recomputing preview list (one card per
  group, member thumbnails, pick marked) — all reactive to every edit, no separate "preview"
  step, matching the prototype's feel.
- ✅ **Settings persistence** — the one deliberate deviation from the prototype (which keeps
  mode/suffix/tolerance in throwaway in-memory state). A `SmartStackSettingsProvider`
  (`lib/smartStackSettings.tsx`), structurally identical to the existing
  `ShortcutsProvider`/`useShortcuts` (§7.8), persists these to `config.json` via a new
  `smart_stack` field on `AppConfig` and a `save_smart_stack_settings` command — so the
  user's real suffix only needs typing once, ever.
- ✅ **Entry points**: the Edit menu's previously-inert **"Smart Stack…"** item, and a new
  **"Smart Stack N Photos"** context-menu item alongside the existing "Stack N Photos"
  (§7.13). No dedicated keyboard shortcut (matches the prototype, which only binds a key to
  the plain manual stack action) and no selection-action-bar entry point (that bar doesn't
  exist in the real app at all — see §1.2).
- ✅ **Apply**: one `createStack` call per proposed group (pick asset id first, matching
  Stage 1's existing "first id = primary" convention), run sequentially rather than
  concurrently so a mid-batch failure is easy to surface — reuses Stage 1's
  `stackByAssetId` overlay, no new backend concept.
- 🐛 **Real bug found and fixed, twice, against the live server**: the user reported
  Version mode matching zero groups for a suffix like `-converted`.
  1. First pass added `*` wildcard support to the pattern (`buildVersionRegex` in
     `lib/smartStack.ts`) on the assumption that exact literal-substring matching was too
     brittle about separator spacing — a leading `*` folds into the mandatory
     prefix-capture group (rather than adding a second adjacent lazy wildcard, which would
     collapse every match's key to `""` and merge unrelated groups together), a trailing
     `*` allows arbitrary trailing content instead of just an optional version number, and
     the captured key has dangling separator punctuation trimmed. Genuinely more robust,
     and the default pattern changed from `-edited` to `*converted*` accordingly — but the
     user reported it *still* didn't work.
  2. Pulling the user's actual filenames from the live server (rather than continuing to
     guess) showed the real renditions are named `"20260621_08-23-13-converted.jpg"` —
     directly attached, no spaces at all — so spacing was never the real problem. The
     actual cause: the RAW+JPEG pair Immich already auto-paired (`20260621_08-23-13.DNG` +
     `.JPG`, sharing a `duplicateId`) was already a 2-member stack, and candidates
     silently excluded **any** already-stacked asset (mirroring the prototype's
     `!st.stackMap[a.id]`) — including that stack's own visible primary, the only one of
     the pair selectable in the grid at all. Selecting that primary plus the `-converted`
     rendition left only one real candidate, so zero groups ever formed, with no
     indication why. Fixed by no longer excluding already-stacked assets from matching at
     all, and instead **merging**: `mergeExistingStacks` in `lib/smartStack.ts` fetches
     the full member list of any existing stack touched by a match (via `getStack`) and
     folds it into the group, re-deriving the pick over the expanded set (now preferring
     an exact-key match that's also RAW, so the DNG rather than the JPG ends up picked).
     Applying such a group (`applySmartStackGroups` in both browsers) dissolves the old
     stack(s) first, then creates one unified stack with the full merged membership.

### 7.15 Not yet started in the real app
- **Albums, People** tabs are pure placeholders (`PlaceholderView.tsx`: "Not built in the
  real app yet — placeholder data only in the design prototype"). **Folders** is now real
  (§7.10).
- **Preferences** — **Library**, **Shortcuts**, and now **Applications** (§7.21) are real;
  Sharing / Configuration each still render the same literal placeholder as before.
- **Sharing, printing, "Create Version" round-trip/versions lineage** — all still only exist
  in the `.dc.html` prototype (manual Stacks and Smart Stack are now both real, §7.13/§7.14;
  the much smaller launch-only editor round-trip that survived §1.6's scope cut is real too,
  §7.21).
- **Menu bar stubs** (`MenuBar.tsx`): Upload…, Print…, Copy/Paste Settings, View → Zoom
  In/Out, View → Sort Photos By (Newest/Oldest/Name/Rating) are present in the menu but not
  wired to anything real yet. **Refresh Timeline** (`F5`), **Select All / Deselect All**
  (`Ctrl+A` / Edit menu), **Stack Selected** (`S`, §7.13), **Smart Stack…** (§7.14), **Import
  from SD Card/Disk…** (§7.22), **Recent Activity…**, **Quit**, **Preferences** (`Ctrl+,`),
  and the **Filters** dropdown (§7.11) are real.
- Next real-app milestone: pick one of the above (Albums/People, sharing/printing) to wire
  up the same way Library + Photos + Folders + Viewer + Delete/Trash + Filters + Stacks +
  Applications + Import were done so far.

### 7.16 Stacks in the lightbox, and rating-UX consistency (real)
> Stage 1 (§7.13) only surfaced stacks in the grid — the lightbox (`Viewer.tsx`) had
> nothing but a coarse header **Unstack** button. This round brought full stack awareness
> into the lightbox and, along the way, fixed rating editing so it works uniformly
> everywhere a stack member or plain asset can be seen.
- ✅ **Filmstrip stack badge**: each filmstrip tile shows a small overlapping-squares icon
  (mirrors the grid tile's badge) when its asset is part of a stack — purely informational,
  no interaction, consistent with the filmstrip's existing read-only rating-star badge.
- ✅ **Info panel Stack section**: when the open asset is a stack's pick, the info panel
  shows metadata at the top (unchanged) and a scrollable **Stack** section below it listing
  every member (`flex:1, minHeight:0, overflowY:auto`, so it grows to fill the panel down
  to the bottom of the screen instead of clipping after ~3 rows). Clicking a member tile
  **peeks** it into the main lightbox stage (image, title, EXIF, keyboard shortcuts — see
  the peek architecture below) without touching the app's real navigation state; a
  separate **Set Pick** button (not the whole tile) promotes that member to the stack's
  pick, matching the plain-tile-vs-star-icon separation used by `MetadataRows`.
- ✅ **"Set Pick" UX made consistent** between the grid's expanded stack row
  (`StackBand.tsx`) and the lightbox: both use a small labeled **Set Pick** / **Pick**
  button overlaid on the corner of each member tile — only the button is clickable, so a
  click elsewhere on the tile always opens/previews that image instead of accidentally
  changing the pick. Replaces the earlier plain ★-icon-over-the-whole-tile approach in
  both places.
- ✅ **Peek architecture** (`Viewer.tsx`): a `peekAsset` state (`shown = peekAsset ?? asset`)
  lets clicking a non-pick stack member preview it in the lightbox — image, title,
  dimensions, EXIF panel, and keyboard shortcuts all operate on `shown` — without changing
  the app's actual `openId`/navigation state, since non-pick stack members are deliberately
  excluded from the flat navigable asset list (`isHiddenStackChild`, §7.13) and can't be
  "opened" through the normal path. Resets automatically when the underlying `asset` prop
  changes (e.g. arrowing to a different photo).
- 🐛 **Fixed: setting a new stack pick closed the lightbox back to the grid.** Root cause:
  the lightbox's open-asset lookup only searched the grid's *filtered* asset map, which
  structurally excludes hidden stack children — right after promoting a new pick, neither
  the new pick (briefly) nor the demoted old pick was resolvable there. Fixed with a second,
  **unfiltered** `assetByIdAll` map (built the same way as the filtered one, minus the
  hidden-stack-child/filter trims) used specifically to resolve one already-known asset id;
  the pick-setting handler now also explicitly re-opens the lightbox on the newly-promoted
  asset instead of leaving it to fall out of the filtered view.
- 🐛 **Fixed: image looked stuck/blurry for one frame after switching stack pick.** The
  blur-up placeholder's "loaded" flags were reset via a `useEffect` keyed on the asset id,
  which runs *after* React commits — for one render, the new asset's data was showing
  against the still-`true` "loaded" flag from the previous asset. Fixed by deriving
  `loaded`/`thumbLoaded` synchronously (comparing a `loadedId`/`thumbLoadedId` state value
  against the current asset's id) instead of a separate boolean reset in an effect.
- 🐛 **Fixed: could rate a stack's pick but not its other members**, in both the lightbox
  and the grid's expanded row. Root cause: both `Viewer.tsx`'s peek panel and
  `StackBand.tsx`'s expanded row fetched a **one-time snapshot** of member data and only
  manually patched it for edits made through their own UI — an edit that succeeded via a
  *different* path (e.g. a keyboard shortcut, handled by the parent page) updated the real
  server/shared cache but never touched that private snapshot, so the rating silently
  reverted to stale on next render. Fixed two ways: `Viewer.tsx` centralized all of its own
  edit call sites (keyboard shortcuts and the info panel) through one `handleEdit` handler
  that patches both the peeked asset and the stack-member list; `StackBand.tsx` went
  further and dropped the snapshot as its source of truth entirely, instead deriving each
  member's displayed data live via a new `resolveAsset: (id) => AssetSummary | undefined`
  prop bound to the browser page's reactive asset cache — so it reflects an edit made
  through *any* path, including a keyboard shortcut fired from the parent page's own
  handler, which has no way to reach into a child component's private state to patch it
  after the fact.
- ✅ **Ratings made editable on plain (non-stacked) grid thumbnails too** — previously the
  grid tile's rating badge was read-only everywhere; `AssetTile.tsx` now takes a required
  `onRate` prop and renders clickable stars, wired through both browser pages' bulk-edit
  path.
- 🐛 **Fixed: clicking the new thumbnail rating stars did nothing.** Root cause: each
  star's clickable element also had the decorative `clip-path` star shape applied directly
  to it — in Chromium/WebKit, `clip-path` clips pointer-event hit-testing along with
  painting, so clicks landing in the star polygon's "notches" (most of its bounding box)
  never registered. Fixed by separating the clickable hit target (a plain, unclipped box)
  from a purely decorative inner element carrying the clip-path — the pattern
  `MetadataRows.tsx`'s original rating row had already used correctly.
- ✅ **Visual consistency pass on rating stars app-wide**: the main grid, the grid's
  expanded stack row, the lightbox filmstrip, the lightbox's Stack-section member tiles,
  and the info panel's own rating control all now render through one shared `Star`
  component (`MetadataRows.tsx`), filled color changed from yellow to **white**
  (`rgba(255,255,255,0.25)` unfilled), uniform `gap: 4` spacing, and always showing all 5
  stars (filled + unfilled) rather than only the filled count.
- ⬜ All of the above verified via `tsc --noEmit` and `oxlint` only (both clean) — not yet
  manually exercised against a running `cargo tauri dev` session.

### 7.17 Floating selection action bar (real)
> Closes the gap flagged in §1.2: the real app previously had no equivalent of the
> prototype's floating selection bar, just scattered status-bar links and a context menu.
- ✅ **`SelectionBar.tsx`** — a 46px bar (`#26313f` background, blue-tinted bottom border,
  matching the prototype's styling) rendered above the grid in both `PhotosBrowser.tsx` and
  `FoldersBrowser.tsx` whenever `selected.size > 0`. Left side: a circular Cancel (×) button
  (`deselectAll`) and an "N selected" label. Right side: **Favorite** (reuses `MetadataRows`'
  now-exported `Heart` icon), **Smart Stack**, **Stack N Photos** (both disabled under 2
  selected), a divider, then **Move to Trash** in the status bar's existing red (`#ff8080`).
- ✅ **Bulk rating control** — a "0" clear button plus a plain 5-star row (reusing
  `MetadataRows`' now-exported `Star`) sits to the left of Favorite. Chosen over a "Rate"
  popover button or a text dropdown after presenting all three to the user: inline stars
  read as one click for a novice, and reuse the same `Star` glyph already used on grid
  tiles, the metadata panel, and the filmstrip. Since a selection can have mixed ratings,
  the stars are a plain set-rating input (always unfilled at rest) rather than a
  reflection of any one asset's current value, unlike the single-asset rating row in
  `MetadataRows`.
- ✅ **Scoped to real functionality only** — the prototype's bar also had **Paste Settings**
  (needs a clipboard/copy-paste-settings feature, §1.5, prototype-only) and **Add to Album**
  (needs Albums, still a placeholder, §7.15); both intentionally left out rather than wired
  to dead ends, per an explicit decision with the user.
- ✅ **Favorite is now a real click target**, not just a keyboard shortcut (§7.8's gap) — a
  shared `toggleFavoriteForSelection` callback (same "any non-favorited member flips
  everything on" convention the `f` shortcut already used) is now the single implementation
  behind both the button and the shortcut, in both browser pages.
- ✅ **Removed the now-redundant bottom-status-bar text links** ("Move to Trash", "Stack N
  Photos") from both pages once the bar covered the same actions — an explicit decision with
  the user rather than leaving two UI locations doing the same thing. The status bar's plain
  "N selected" count label stays, alongside the total asset count.
- ⬜ Verified via `tsc --noEmit` and `oxlint` (both clean) and confirmed the touched files
  transform without error through the already-running `cargo tauri dev` / Vite dev server
  (live against the user's real, connected Immich library) — not yet manually clicked
  through in the actual window, since that session has real writes enabled
  (`readOnly: false`) and Favorite/Stack/Delete are all real mutations against the live
  library, not something to exercise unattended.

### 7.18 RAW-editor metadata sync — Stage 0 through Stage B + reject control (real)
> Larger, user-planned feature: digiKam/darktable/RawTherapee/ART all write sidecar files (or,
> for JPEG/TIFF, straight into the image itself) that Immich never sees. Full plan (all stages)
> recorded in this session's plan file. darktable/ART Copy-Paste Settings + the local "pasted
> settings" badge remain queued next, not yet built (separate feature, separate risk profile —
> wholesale sidecar copy vs. this feature's targeted field patch).
- ✅ **Stage 0 — local path resolution.** A second NFS/SMB mount mapping on `LibraryConfig`/
  Preferences → Library → Originals on Disk: `uploadedLocalRoot`/`uploadedImmichRoot`,
  alongside the existing External Library `localRoot`/`immichRoot` pair — External Library
  assets keep their real folder path, while ones uploaded directly (phone/web) live under
  Immich's own internal upload storage instead, so each needs its own local mount.
  - `originalPath` is captured end-to-end (`immich/models.rs` → `AssetSummary` → the frontend's
    `AssetSummary`), despite Immich's `/search/metadata` already returning it.
  - `app/src-tauri/src/paths.rs`: `resolve_local_path()` substitutes whichever of the two
    configured server-root prefixes matches (External Library first, then Immich Uploads),
    returning `None` — never an error — if neither mapping is configured or the path matches
    neither prefix, since most users will only ever set up one of the two.
- ✅ **Stage A — passive metadata sync (rating + description).** New `check_sidecar_metadata`
  command resolves each asset's rating and description independently, each via its own
  precedence chain (`paths::read_asset_metadata`):
  1. `.xmp` sidecar — `xmp:Rating` (digiKam/darktable/ART, and RT if configured to sync XMP)
     and `dc:description`; a `digiKam:PickLabel` of "rejected" also counts as a rating of `-1`
     when `xmp:Rating` itself isn't present.
  2. metadata embedded directly in the file (`app/src-tauri/src/embedded.rs`) — JPEG APP1/XMP
     and APP13/legacy-IPTC-caption, or a TIFF's IFD0 XMP tag. RAW files always go through a
     sidecar instead, regardless of tool, so no embedded-RAW parsing exists.
  3. RawTherapee's own `.pp3`: `Rank=` (`[General]`) for rating, `Caption=` (`[IPTC]`, a
     semicolon-delimited glib key-file list even though RT only ever writes one value — key
     name/format confirmed against RT's own `procparams.cc`, not just documentation) for
     description.
  - `-1` (RT/ART's/XMP's standard "rejected" marker, and digiKam's `PickLabel=1`) is a real,
    syncable value — Immich's `rating` field explicitly supports it. Every reader/writer here
    is a small hand-rolled scan, not a full XML/TIFF/EXIF parser — deliberate, since this is a
    fixed, well-known set of fields across a small set of known tools.
  - Returns a gap whenever the sidecar/embedded value differs from what Immich currently has for
    that field, independently per field (an asset with a matching rating but a differing
    description still surfaces a description-only gap, and vice versa) — not "gap-fill only": a
    rating changed in digiKam/ART/RT after Immich last saw a value must still surface as
    unsynced, since those tools (not Immich) are where ratings/captions are actually set day to
    day. Immich is still never overwritten automatically — the user always explicitly triggers
    the sync action.
  - Wired into the existing per-bucket/per-folder asset-fetch effect in
    `PhotosBrowser.tsx`/`FoldersBrowser.tsx` — passive/automatic detection, but the actual write
    into Immich only happens on an explicit user action (never silent), per the user's own
    framing: "read automatically from the sidecar, but Immich should take precedence if there
    is already a rating in Immich. Then let the user sync them if they aren't synced."
  - Sync action does one `commitEdit` per affected asset (not grouped/batched — descriptions
    are per-asset-unique text, unlike a plain rating) — still gated by the same read-only +
    max-writes-per-batch safety net as every other edit.
  - Entry points: a small amber badge on the grid tile (`AssetTile.tsx`, tooltip naming which
    field(s) have a gap), a context-menu "Sync Metadata from Sidecar" item (single asset), a
    SelectionBar "Sync N Items" button (current selection), and an Edit-menu "Sync Metadata
    from Sidecar" item (every currently-loaded gap, not just the selection).
  - Tags/keywords have no Immich-side home (no Tags UI exists in ImmAture yet, §3) — never read
    for sync purposes, and digiKam tag-sync remains an explicitly deferred stretch idea.
- ✅ 7 unit tests in `paths.rs` (prefix substitution for both mappings, sibling-prefix
  rejection, unconfigured/unmatched → `None`, both xmp:Rating forms, pp3 `Rank=` scoped to
  `[General]` plus the `-1` rejected case, and the xmp-then-pp3 fallback order) — `cargo test`
  passing, alongside `tsc --noEmit`/`oxlint`/`cargo check` all clean.
- ✅ **Stage B — write-mirror: `.xmp` patch/create on every rating/description edit.**
  Root-caused live against the user's real Immich server: `PUT /assets/{id}` with a `rating`
  returns `200 OK` for External Library assets (ImmAture's core use case) without the value
  ever actually persisting (confirmed via direct write-then-reread against a disposable test
  asset; `isFavorite` and non-external-library `rating` both persist correctly with the same
  call). So a rating/description edit made inside ImmAture is no longer trusted to have
  "stuck" just because Immich's PUT returned success — it's also written directly into the
  asset's own `.xmp` sidecar, which is the mechanism actually relied on to persist it.
  - New `xmp::patch_or_create(path, rating, description)` — patches an existing attribute or
    element form in place, or inserts a new one onto/into `rdf:Description` (converting a
    self-closing tag to open/close first if a new child element is needed), or synthesizes a
    minimal well-formed packet if no sidecar exists yet. Every sibling attribute/child element
    is left byte-for-byte untouched — verified against a real, unmodified Exiv2/digiKam-written
    sidecar captured from the user's own test library, not just synthetic fixtures. Atomic
    write (unique tmp file + rename), same pattern as `thumb_cache.rs`.
  - `update_asset_metadata` now takes `targets: {id, originalPath}[]` instead of bare ids.
    Immich's PUT is still attempted first for every target (unchanged), then whichever of
    rating/description were part of the edit are mirrored into the sidecar via
    `paths::xmp_write_path` (prefers whichever of the two sidecar-naming conventions already
    exists on disk, defaulting to the append-form for a brand-new file). A real sidecar-write
    failure is collected into a `SidecarWriteWarning[]` response and surfaced to the user via a
    small inline banner in `PhotosBrowser.tsx`/`FoldersBrowser.tsx` (not silently swallowed —
    this is the one failure mode in the whole feature a user actually needs to notice).
  - After a successful sidecar write, best-effort `POST /assets/jobs {name: "refresh-metadata"}`
    nudges Immich to re-read the file promptly instead of waiting on its own periodic
    sidecar-scan queue (fire-and-forget — doesn't affect whether the edit itself succeeded).
- ✅ **Reject (-1) rating control.** Previously ImmAture could only *detect* a `-1`/rejected
  rating from a sidecar, with no way to set one itself. Added `reject` shortcut (default `9`,
  matching digiKam's own binding) plus a small reject icon (`RejectIcon` in `MetadataRows.tsx`)
  next to the star row in `AssetTile.tsx`, `MetadataRows.tsx`, and `SelectionBar.tsx` — clicking
  it sets rating `-1`; clicking again clears back to `0`, mirroring the existing
  reclick-a-star-to-clear pattern.
- ✅ 11 new unit tests in `xmp.rs` (attribute/element rating patch, self-closing-tag handling,
  description-block patch/insert, brand-new-file creation, XML-escaping, and two regression
  tests against a real, unmodified digiKam-written sidecar confirming every sibling
  attribute/child element survives byte-for-byte) plus 1 in `paths.rs`
  (`xmp_write_path` naming-convention precedence) — `cargo test` (29/29), `cargo check`,
  `tsc --noEmit`, `oxlint` all clean.
- ⬜ Not yet manually verified against the user's real library end-to-end (set a rating from
  the Folders view, a Photos-view thumbnail, the SelectionBar, and the new reject control;
  confirm the `.xmp` sidecar's `xmp:Rating` actually changes on disk and survives a
  refresh) — automated tests cover the write logic itself, but this hasn't been exercised
  through the real running app yet.
- ⚠️ **Superseded by §7.20**: `update_asset_metadata`'s synchronous, sequential per-target loop
  and its `SidecarWriteWarning[]` response (both described above) were replaced by a decoupled,
  optimistic-UI background edit queue once this session's real-world testing showed the
  synchronous round trip itself — not just a failure within it — could freeze the UI for minutes
  under an NFS/Tailscale slowdown. The write mechanism (Immich PUT + `.xmp` patch, sidecar
  authoritative) is unchanged; only when/how it runs, and how the UI learns about it, changed.

### 7.19 NFS `hard`-mount reads blocking system suspend (real, Linux)
> The Stage 0 local-path mapping (§7.18) means `check_sidecar_metadata` and the Stage B `.xmp`
> write can read/write through a `hard`-mounted NFS path. Root-caused against the user's real
> laptop: when the NFS server becomes unreachable (e.g. during a suspend transition) while a
> `hard`-mount read is in flight, the calling thread blocks in the kernel in uninterruptible `D`
> state (`nfs_file_read`/`folio_wait_bit_common`) for as long as the outage lasts — confirmed via
> `journalctl -k` showing `tokio-rt-worker` threads stuck there, causing Linux's s2idle
> `freeze_processes()` step to time out and suspend to fail/retry in a loop. This is unrelated to
> which Tokio thread pool a blocking call runs on — Tokio 1.52.3 (this app's pinned version) gives
> `spawn_blocking` pool threads the same default name as core reactor threads
> (`tokio-1.52.3/src/runtime/blocking/pool.rs:227`), and all 4 blocking-fs call sites in this
> codebase were already correctly wrapped in `spawn_blocking` before this work — that was never
> the bug. The user chose to keep the NFS mount's `hard` option (data integrity on writes matters
> more than suspend convenience), so the fix is two complementary pieces:
- ✅ **Part A — the actual guarantee: a systemd-sleep force-unmount hook**, external to this repo,
  at `/etc/systemd/system-sleep/immature-nfs-unmount`. Force-unmounts (`umount -f`, not lazy `-l`)
  the NFS mount on the `pre` sleep hook, which actively aborts any in-flight NFS RPC and returns
  an error to the blocked thread — the only thing that can un-stick a thread already parked in
  `D` state; nothing in userspace short of this can. The mount's existing `x-systemd.automount`
  fstab option transparently reconnects on next access after resume, so no explicit remount step
  is needed. Logs via `logger -t immature-nfs-unmount` for diagnosability.
- ✅ **Part B — a complementary reduction, not sufficient alone: Linux-only delay-inhibitor
  subsystem** (`app/src-tauri/src/io_guard.rs` portable + `suspend_guard.rs` Linux-only, gated
  `#[cfg(target_os = "linux")]` and kept out of the non-Linux dependency graph via a
  `[target.'cfg(target_os = "linux")'.dependencies]` table for `zbus`/`futures-util`). Uses
  systemd-logind's `Inhibit("sleep", ..., "delay")` + `PrepareForSleep` D-Bus signal (the same
  idiom NetworkManager/gnome-keyring use) to get advance warning before suspend: on
  `PrepareForSleep(true)`, `IoGuard` stops new blocking fs calls from starting (all 4 existing
  `spawn_blocking` call sites now go through `io_guard::guarded_spawn_blocking`, each degrading to
  its existing tolerant fallback when paused — thumbnail read/write treat it as a cache miss/no-op,
  `update_asset_metadata` surfaces it as an ordinary `SidecarWriteWarning`,
  `check_sidecar_metadata` returns an empty result for that round) and waits up to 3s (comfortably
  under logind's default 5s `InhibitDelayMaxSec`) for in-flight calls to drain before releasing the
  inhibitor. **This cannot rescue a thread already blocked in `D` state** — nothing in userspace
  can once the syscall is inside the kernel's NFS client — so Part A remains the actual guarantee
  and Part B only narrows how often Part A's rescue is even needed. All D-Bus failure paths
  (`log::warn!` + early return, never `.unwrap()`) degrade to "inhibitor never held, behaves as
  before" rather than crashing, so this is safe on non-systemd/sandboxed Linux environments too.
  - ⚠️ Caution for any future `zbus` upgrade: `zbus`/`zbus_macros` must be version-pinned together
    (currently exact `5.12.0`) — letting them resolve independently produces a
    `cannot find type DispatchResult2` compile error from macro/crate version skew. Confirmed by
    reproducing it directly. Also respects this crate's declared `rust-version = 1.77.2`; plain
    `cargo update` floats zbus to 5.17+, which itself requires rustc ≥1.87.
  - ✅ 4 new unit tests in `suspend_guard.rs` (pause sets the flag, resume clears it, paused guard
    refuses new work, pause waits for in-flight work to drain) exercising the pause/drain logic
    directly against `IoGuard` — deliberately independent of a live D-Bus connection, since
    `PrepareForSleep` is a sender-filtered signal, not a callable method, and can't be simulated
    via `busctl call`/`busctl emit` from an unprivileged process (confirmed both fail/are ignored
    while designing this).
- ✅ Sleep hook installed at `/etc/systemd/system-sleep/immature-nfs-unmount` (`root:root`,
  `0755`), confirmed by the user.
- ✅ Inhibitor acquisition/release verified end-to-end against the real running app and the
  user's live `systemd-logind` (`ImmAture`/`sleep`/`delay` appeared in `systemd-inhibit --list`
  and `ListInhibitors`, matching the running PID; killing the process released it immediately —
  RAII drop behavior confirmed).
- ⬜ Not yet verified against one real suspend/resume cycle (both `PrepareForSleep(true)` and
  `(false)` firing in practice), nor against an actual NFS outage during suspend.

### 7.20 Decoupled optimistic-UI edit queue (real)
> This session diagnosed that the NFS mount backing `.xmp` sidecar writes (§7.18) runs over a
> real ~100ms WAN link (Tailscale) with `hard`+`sync` options, and that a burst of writes (e.g.
> Unraid's recursive permission-fix walk) can saturate that single shared connection for minutes
> at a time. Because every rating/favorite/description edit was fully synchronous end-to-end
> (§7.18's sequential per-target loop, awaiting an Immich PUT then a blocking `.xmp` write before
> the frontend ever touched local UI state), any such slowdown made the whole UI feel frozen —
> keyboard shortcuts and rating clicks didn't visibly do anything until the round trip completed.
> The fix: stop gating the UI on any per-edit round trip at all.
- ✅ **New `app/src-tauri/src/edit_queue.rs`** — a bounded-concurrency (`MAX_CONCURRENT_JOBS = 4`,
  deliberately small given the single shared NFS connection above) background queue. `EditQueue`
  holds an in-memory `VecDeque<EditJob>` board (`Pending → Writing → Done|Failed`, capped
  `Done`/`Failed` history at 200 via `trim_completed`, never evicting active jobs) plus an
  `mpsc` channel to its own drain worker (`edit_queue::run`, spawned once from `lib.rs`'s
  `.setup()`). Per job, the worker runs the XMP sidecar write (still via the existing
  `io_guard::guarded_spawn_blocking`, unchanged mechanism) **concurrently** with the Immich PUT
  via `tokio::join!` — independent systems, no real dependency between them. The sidecar remains
  authoritative (§7.18's root-cause finding): an XMP write failure is fatal (`Failed`, and the
  frontend rolls its optimistic patch back); an Immich-only failure is non-fatal (`Done` with an
  advisory `immichWarning`, no rollback) since the edit already stuck via the sidecar.
- ✅ `update_asset_metadata` is now a plain **sync** `fn` — after its unchanged
  `read_only`/`max_writes_per_batch` checks, it just resolves each target's local path (cheap, no
  I/O) and pushes jobs onto the queue, returning their ids immediately. New poll-target command
  `get_edit_queue_status` (`{ jobs, pendingCount }`) and `clear_completed_edit_jobs` back the
  frontend's advisory activity panel.
- ✅ **Frontend applies its own optimistic patch before any of the above runs** —
  `PhotosBrowser.tsx`/`FoldersBrowser.tsx`'s `commitEdit`/`commitEditMany` patch local state
  immediately, then enqueue; `useEditJobReconciliation` (`app/src/lib/useEditJobReconciliation.ts`)
  gives them a one-shot callback the moment each tracked job settles, to roll back on `failed` or
  just drop bookkeeping on `done`. `enqueueError` (renamed from `editWarning`) now only fires on a
  *synchronous* rejection (read-only/over-cap) — an async job failure surfaces via the new shared
  UI instead. Known, deliberate trade-off: `MetadataPanel`'s description-textarea inline error
  also now only reflects a sync rejection, not an async job failure.
- ✅ **Advisory, polled activity UI** — `EditQueueProvider` (`app/src/lib/editQueue.tsx`) polls
  `get_edit_queue_status` every 1s (same shape as `useMemoryUsage.ts`), shared via context so the
  new `EditQueueIndicator` pill (mounted in `TitleBar.tsx`, "N syncing…"/"N failed") and the new
  `ActivityPanel` modal (per-job thumbnail + status pill + inline error/warning text, "Clear
  Completed" footer action, visual language loosely modeled on Immich Desktop's own "Recent
  Activity" modal) both read from one shared poll. Polling was chosen deliberately over a
  per-edit Tauri event stream: the queue is already fully decoupled from the optimistic UI, so a
  transition missed between polls only affects how granularly "in progress" briefly renders,
  never correctness.
- ✅ **The one deliberate exception: app close.** `lib.rs`'s `.on_window_event` intercepts
  `WindowEvent::CloseRequested`, and if `edit_queue.pending_count() > 0`, calls
  `api.prevent_close()` and emits a one-shot `queue-close-blocked` event (the only per-edit-queue
  Tauri event in this design). `App.tsx` shows a `ConfirmDialog` ("Wait" / "Quit anyway" — a warn,
  not a hard block; force-quit accepts data loss) whose confirm action calls the new `force_quit`
  command (`app.exit(0)`, bypassing the interception).
- ✅ 7 new unit tests in `edit_queue.rs` (id assignment + `Pending` on enqueue, ids increasing
  across calls, XMP failure classified `Failed` even when Immich also fails, Immich-only failure
  classified `Done`+warning, both-success plain `Done`, `trim_completed` never evicts
  `Pending`/`Writing` and caps `Done`/`Failed` history at the cap) — pure, no runtime/network/
  filesystem needed, same testable-reaction-vs-I/O-loop split as `suspend_guard.rs`. `cargo test`
  (43/43), `cargo build`, `cargo clippy` (no new warnings), `tsc -b`/project-references typecheck
  all clean.
- ⬜ Not yet manually verified against the user's real library/server — this sandbox has no
  display server (no Xvfb/webkit2gtk GUI harness set up) and no live Immich server or NFS mount
  configured, so the native window itself, and the actual behavior of rapid multi-select edits,
  a forced XMP permission failure, an Immich-only outage, and the close-blocking dialog against a
  stalled job, are all still outstanding — only static verification (types, unit tests, clippy,
  full build) was possible here.
- ⚠️ **Superseded by §7.23**: the `EditQueueIndicator` pill mentioned above (mounted directly in
  `TitleBar.tsx`) was replaced by a combined `ActivityIndicator` once the import feature added a
  second background queue — same file still exists, just no longer mounted on its own.

### 7.21 RAW/External editor launch (real)
> Closes the gap flagged in §1.5/§1.6/§2.5: Preferences → Applications was a placeholder and
> nothing launched an external editor at all. Scoped deliberately narrow per an explicit
> decision this session: **launch only** — no file-watching, no auto-refresh, no auto-stacking.
> The user manually hits the existing Refresh Timeline once the editor saves, matching the
> user's own framing from §6 ("There's already an Open In Raw Editor button... when the image
> gets saved back to the same folder it should appear") and the prior, separate decision to cut
> the prototype's much bigger "Create Version" round-trip entirely (§1.6) — that machinery
> (version lineage, auto-stacked renditions) was **not** revisited or resurrected here.
- ✅ **App detection** (`app/src-tauri/src/apps.rs`) — best-effort, never errors. Native apps:
  a hand-rolled `.desktop` reader (same "narrow parser for a known format" style as `paths.rs`'s
  `.pp3` reader) over the standard XDG applications directories. Flatpak and Snap apps are
  picked up "for free" by also scanning their own desktop-export directories
  (`/var/lib/flatpak/exports/...`, `~/.local/share/flatpak/exports/...`,
  `/var/lib/snapd/desktop/applications`) rather than shelling out to `flatpak list`/`snap list`
  and parsing column output — avoids depending on either CLI being resolvable from this app's
  `PATH` (not guaranteed for a GUI app launched outside a shell), and reuses one `.desktop`-
  reader for every kind. `AppKind` (Native/Flatpak/Snap/AppImage/Custom) is classified from the
  `Exec=` line's own shape (`flatpak run` prefix, `/snap/` substring, else native). **AppImage is
  deliberately never auto-detected** — there's no standard registry of installed AppImages to
  scan, so it's only reachable via the picker's own custom-executable file-browse fallback,
  matching the design prototype's own split.
- ✅ **Launch** (`apps::launch_app`) — Native/Flatpak/Snap entries carry a real `Exec=` command
  line (for Flatpak/Snap this already includes `flatpak run <id>`/the `/snap/bin/<name>` wrapper
  itself); only the file-argument field code (`%f`/`%F`/`%u`/`%U`) needs substituting with the
  resolved local path, via a pragmatic (not fully XDG-spec-general) tokenizer — the picker always
  shows the raw `exec` string, so a launch that goes wrong is at least diagnosable. AppImage/
  Custom entries are a bare executable path with no `Exec=` grammar, so the path is simply
  appended. Plain `std::process::Command` — no `tauri-plugin-shell` needed or added; this keeps
  the same tight trust boundary as every other hand-written command in this codebase (one narrow
  Rust function ever spawns a process, not a generically-scoped shell-exec surface reachable
  from JS).
- ✅ **New commands** (`commands.rs`): `list_installed_apps`, `save_applications_config`,
  `launch_editor` (resolves the local path via the *existing, unchanged*
  `paths::resolve_local_path()` from §7.18 Stage 0, then calls `apps::launch_app`).
  **Deliberately skips the read-only/max-writes-per-batch safety net** that gates every other
  mutating command — launching a third-party process writes nothing to Immich and doesn't touch
  the file itself; whatever that external app later does to the file is outside ImmAture's own
  write path. A judgment call, not a silent assumption.
- ✅ **Config** (`config.rs`): `ApplicationsConfig { raw_editor: Option<AppChoice>,
  external_editor: Option<AppChoice> }` on `AppConfig`, following the existing
  `SmartStackSettings` pattern exactly (struct + `Default` + `#[serde(default)]` field +
  paired save command).
- ✅ **Preferences → Applications** (`PreferencesApplications.tsx`) — real now, replacing the
  placeholder branch in `PreferencesOverlay.tsx`. Two rows, **RAW Editor** / **External
  Editor**, each showing the chosen app (name + monospace `exec`) or "No application chosen",
  with a **Change…** button opening the picker.
- ✅ **App picker** (`AppPickerDialog.tsx`) — filterable list, each row a letter-avatar + name +
  monospace `exec` + a colored kind badge using the design prototype's own hex values (Flatpak
  `#3584e4`, Snap `#e95420`, AppImage `#2ec27e`, Native `#9141ac`, Custom `#5e5c64`), plus an
  **"Other application…"** row at the bottom that opens `tauri-plugin-dialog`'s native file-open
  dialog (new dependency — no dialog/shell/fs plugin existed in this app before this round) to
  produce a `Custom` (or, if the picked path ends in `.AppImage`, `AppImage`-badged) entry. No OS
  icon-theme lookup — letter-avatar only, matching the prototype.
- ✅ **Viewer buttons** — two new header buttons next to Unstack/Move to Trash: **"Open in RAW
  Editor"** (shown only when `isRawAsset(shown)`, reusing the existing `lib/filters.ts`
  predicate) and **"Open in Ext. Editor"** (always shown). Neither button existed in the real
  app before this round — confirmed via a full grep of `Viewer.tsx`, this wasn't "wire up a
  disabled button," the buttons themselves were net-new. Clicking with no app chosen for that
  role redirects straight into Preferences → Applications (`onOpenApplicationsPreferences`,
  threaded through `PhotosBrowser.tsx`/`FoldersBrowser.tsx` from `App.tsx`) instead of just
  disabling the button with no way to fix it from there.
- ✅ `ApplicationsProvider`/`useApplications()` (`lib/applications.tsx`) — structurally identical
  to `SmartStackSettingsProvider`, shared so Viewer doesn't need its own `getConfig()` round trip
  on every open.
- ✅ 7 new unit tests in `apps.rs` (`.desktop` `Name=`/`Exec=`/`NoDisplay=`/section-scoping
  parsing, Flatpak/Snap/Native classification from `Exec=` shape, field-code substitution
  including the no-field-code-present append case and `%%` unescaping) — `cargo test`, `cargo
  check`, `cargo clippy` (no new warnings), `tsc -b`, `oxlint` all clean.
- ⬜ Not yet manually verified against the user's real library/server or a real desktop
  environment — same sandbox limitation as §7.20 (no display server, no installed
  darktable/RawTherapee/GIMP/etc. to actually detect and launch here). Static verification only.

### 7.22 SD card / disk import (real)
> Genuinely new territory — confirmed via search that no prior prototype design, requirements
> discussion, or real-app code touched import/download/SD-card/memory-card anywhere before this
> round. Modeled loosely on Rapid Photo Downloader (local download-history/dedupe cache,
> configurable rename-on-import, RAW+JPEG paired under one shared basename), explicitly scoped
> down from RPD's full feature depth per the user's own answers this session: launch-only import
> (no per-file thumbnail/checkbox staging grid), one fixed curated naming scheme rather than a
> token-builder UI, and copy-to-disk-plus-nudge-Immich rather than a parallel upload-API path.
- ✅ **Scan + pairing** (`app/src-tauri/src/import/scan.rs`) — recursively walks a source folder
  (`walkdir`, new dependency) for RAW/JPEG/HEIC/PNG/TIFF/common-video extensions, grouping files
  by `(parent_dir, basename_without_extension)` — **deliberately scoped per source directory**,
  not a global flat basename match across the whole scan the way `smartStack.ts`'s Name mode
  groups already-imported Immich assets (which have globally unique ids/paths). A raw filesystem
  scan has no such guarantee: a reused SD card can have `100CANON/IMG_0001.CR3` and
  `101CANON/IMG_0001.CR3` as two unrelated files that happen to share a basename — a naive port
  of the TS grouping logic would have been a real correctness bug, caught during design rather
  than after the fact. Video is included by default (a judgment call, flagged rather than
  assumed — real camera SD cards always mix video in, and Immich already treats it as
  first-class); easy to exclude later if unwanted.
- ✅ **Capture-date derivation** (`import/capture_time.rs`) — EXIF `DateTimeOriginal`/`DateTime`
  via `kamadak-exif` (new dependency) preferred, falling back to file mtime (via the `time`
  crate, new dependency, for the epoch→calendar conversion) when EXIF is missing/unreadable.
  Per-group selection prefers an EXIF-derived time from a RAW member, then any EXIF-derived time,
  then the earliest mtime among the group. **Known, accepted gap**: Canon CR3 (ISO-BMFF/MOV-style
  container, not TIFF) and Fujifilm RAF (proprietary wrapper around an embedded TIFF section) are
  weaker fits for `kamadak-exif` than the TIFF-based RAW formats (NEF/ARW/DNG/ORF/RW2/PEF/SRW) —
  degrades gracefully to mtime either way; not yet empirically confirmed against one of the
  user's own CR3/RAF files. `exiftool` was considered and rejected as the primary mechanism,
  consistent with this codebase's existing "hand-roll a narrow parser for a known format"
  philosophy (`xmp.rs`, `paths.rs`'s `.pp3` reader) and §1.5's own prior, explicit decision to
  scope ExifTool out entirely.
- ✅ **Dedupe cache** (`import/history.rs`) — content-hash based (partial BLAKE3 hash, first
  ~4MB + file size, new `blake3` dependency chosen over the already-transitively-present `sha2`
  specifically because BLAKE3's throughput matters where a full read is unavoidable anyway, see
  below), persisted to its own `import_history.json` file rather than folded into `config.json`
  — it can grow into the tens of thousands of entries and churns far more than settings, so
  keeping it separate avoids rewriting the whole settings blob on every import. A group is
  treated as fully imported only when **every** member matches an existing record; if only some
  members match (e.g. a RAW+JPEG pair where just the JPEG half was imported previously, possibly
  under a different destination name), the whole group is copied together again — the simplest
  option, accepted as a known v1 trade-off over a full pair-aware history lookup, rather than a
  silent gap.
- ✅ **Naming** (`import/naming.rs`) — the one fixed scheme asked for: `yyyymmdd_hh-mm-ss.ext`
  filenames, with a **Flat** vs **Year/Month** (`yyyy/yyyy_mm/`) folder-hierarchy choice (not a
  full token-builder). A collision is resolved **once per group**, not per file — a RAW+JPEG
  pair must keep sharing one destination basename even when that basename collides with
  something else (same-second burst, or a reset camera clock); suffixing each member
  independently (`-1`/`-2`/…) would silently break the pairing this whole feature exists to
  preserve. Checked against both the rest of the current batch and whatever's already on disk
  (any extension, not just a matching one).
- ✅ **`ImportQueue`** (`import/queue.rs`) — the same bounded-concurrency background-job
  architecture as `edit_queue.rs` (`Pending → Copying → Done|Failed` board, `mpsc`-fed drain
  worker spawned once from `lib.rs`'s `.setup()`, capped completed-history), deliberately capped
  lower (`MAX_CONCURRENT_IMPORT_JOBS = 2` vs. the edit queue's 4) since this moves large RAW
  files over the same constrained NFS/Tailscale mount that already caused §7.19/§7.20's real
  suspend-blocking and UI-freeze bugs, and a multi-hundred-file SD card import is a much bigger
  burst than any metadata edit ever was. Copies through a unique temp name then renames into
  place (same atomic idiom as `thumb_cache.rs`/`xmp.rs`), always via
  `io_guard::guarded_spawn_blocking` — not optional, for the same NFS-mount-burst reason. Every
  copy is byte-count-verified against the size captured at scan time before the rename (a real,
  cheap integrity check using the BLAKE3 hash `copy_with_hash` already computes as a byproduct of
  the copy, not a separate re-read pass) — a size mismatch fails the job and cleans up the temp
  file rather than silently landing a truncated/corrupt copy.
- ✅ **Immich "nudge"** (`immich/mod.rs`) — `get_libraries()` (`GET /libraries`) +
  `scan_library()` (`POST /libraries/{id}/scan`), verified against Immich's live `main`-branch
  OpenAPI-generated SDK. Distinct from the existing `refresh_metadata`/`refresh-metadata` job
  (§7.18 Stage B): that one only re-reads a file for an asset Immich **already knows about** — it
  does nothing for a genuinely new file, which is exactly what an import just created; a real
  Library Scan is the actual mechanism for Immich to discover brand-new files under an External
  Library. **Library-id auto-match** (`import/library_match.rs`, pure/testable) compares the
  configured `immich_root` against each library's `importPaths` by exact equality (trailing-slash
  tolerant) — re-resolved fresh each time rather than cached in config, so a later Immich-side
  library reconfiguration can't leave a stale id behind. Ambiguous (>1 match) or no-match results
  in a clear error surfaced to the user; the copy has already succeeded either way, this only
  affects how promptly the files show up in Immich. **Not yet smoke-tested against the user's
  actual server** — needs the same live-server verification discipline as §2.7's compatibility
  log before fully trusting it.
- ✅ **Commands** (`commands.rs`): `list_removable_volumes` (via `sysinfo`'s `disk` feature,
  newly enabled — already a direct dependency for `get_memory_usage`), `scan_import_source`
  (returns both aggregate counts *and* the full group plan, checked against the queue's own
  in-memory history rather than a fresh disk read, so `start_import` never needs a second
  scan/hash pass over what could be a slow card reader), `start_import`, `get_import_queue_status`,
  `clear_completed_import_jobs`, `save_import_settings`, `scan_immich_library`. `start_import` is
  gated by `read_only` like every other write, but **deliberately not** by
  `max_writes_per_batch` — that cap exists to catch a fat-fingered bulk edit/delete of *existing*
  assets (default 25), and applying it unmodified here would make importing an ordinary
  few-hundred-photo SD card impossible without raising the same cap that protects everything
  else. A real usability/safety trade-off, flagged rather than silently decided either way.
- 🐛 **Real bug found and fixed, reported live by the user**: loading a real source folder made
  the whole app appear to hang, with the OS surfacing a "not responding" notification —
  `scan_import_source` (the recursive walk + per-file partial-hash read, §7.22's scan/pairing
  step above) and `start_import` (whose `enqueue` does its own disk reads for collision
  resolution, §7.22's naming step) were both plain sync `fn`s running straight on the async
  runtime's worker thread instead of via `io_guard::guarded_spawn_blocking` — the one pattern
  every other I/O-heavy command in this codebase already uses (`check_sidecar_metadata`, every
  copy job in `queue.rs`). For a real SD card (hundreds of files, each read up to 4MB for its
  hash) that starved the IPC channel long enough for the OS to conclude the app had died. Fixed
  by making both commands `async fn` and routing their bodies through
  `io_guard::guarded_spawn_blocking`, same idiom as `check_sidecar_metadata`.
- ✅ **`ImportDialog.tsx`** — the "curated subset" v1 flow: pick a source (removable-volume
  quick-picks via `sysinfo`, or **Browse…** via `tauri-plugin-dialog`'s native folder picker) →
  scan summary (new/already-imported/paired/total counts, plus the Flat vs. Year/Month choice) →
  one **Import** button → closes immediately into the shared Activity UI for progress. No
  per-file thumbnail/checkbox grid — a clear, explicitly-scoped future add-on, not an oversight.
  Shows a "set up External Library local mount first" state (with a shortcut straight into
  Preferences → Library) if that mapping is empty, rather than letting the user scan with nowhere
  valid to copy to.
  - 🐛 **Real UX bugs found and fixed, reported live by the user**: (1) the "Flat"/"Year / Month"
    labels alone didn't make the actual naming convention legible — the summary step now also
    shows a live, monospace **destination example path** (e.g.
    `/mnt/nfs/Rob/Images/2026/2026_06/20260621_08-23-13.CR3`), computed from a real scanned
    group and updating as the folder-layout toggle changes, plus a plain-language caption
    explaining the `yyyymmdd_hh-mm-ss.ext` + `yyyy/yyyy_mm/` scheme — shown *before* the user
    confirms Import, not just implied by the button labels. (2) the source step's "Scanning…"
    state was just a disabled button label, easy to mistake for a frozen app (compounded by the
    hang bug above, but a real UX gap on its own even once that's fixed) — replaced with a
    full-width waiting panel (spinner + "this can take a while for a large card... please keep
    this window open, it hasn't frozen") that takes over the whole step while a scan is in
    flight, from either a quick-pick volume click or Browse.
- 🐛 **Real bug found and fixed, reported live by the user**: importing while the destination
  NFS mount was disconnected didn't just fail the import — the *whole app* went unresponsive
  (OS-level "not responding" dialog), and it stayed wedged on a second attempt even after the
  mount reconnected, leaving orphaned `.part-N` temp files behind. Root cause was worse than the
  §7.20-style "blocks the async runtime" bug above: `ImportQueue::enqueue()` was holding the job
  board's `Mutex` (`board: Mutex<VecDeque<ImportJob>>`) **while** doing the disk reads
  `naming::resolve_stem` needs for collision checking. `get_import_queue_status`/`snapshot`/
  `pending_count` (polled every second by the frontend) and the drain worker's own
  `set_status`/`finish` calls all briefly lock that same mutex — none of them do I/O themselves,
  but if `enqueue` hung inside a `fs::read_dir` against an unreachable hard NFS mount (an
  accepted, unrescuable-from-userspace kernel D-state wait, per §7.19's own prior finding), the
  lock never released, so every one of those once-a-second pollers piled up behind it forever
  too — enough accumulated blocked tasks starved the async runtime badly enough to stall the
  whole app, not just the Import dialog. Separately, a copy job stuck the same way in
  `copy_one` (during the actual file write) permanently occupied one of only
  `MAX_CONCURRENT_IMPORT_JOBS = 2` semaphore permits for the rest of the process's life, since
  nothing released it — explaining why a second import attempt in the same running session
  found the queue already wedged, independent of the mutex bug. Fixed three ways: (1)
  `enqueue()` now does all of `naming::resolve_stem`'s disk-touching work *before* acquiring
  `board`'s lock at all, so a stuck destination can only ever block that one call, never anyone
  else's; (2) each copy job in the drain worker is now bounded by `COPY_TIMEOUT` (10 minutes)
  via `tokio::time::timeout` around its `JoinHandle` — on timeout the job is marked `Failed`
  with a clear message and its semaphore permit releases immediately, even though the
  underlying blocking-pool thread itself is abandoned (leaked, not killed — a stuck kernel
  thread can't be cancelled from userspace, but a leaked blocking-pool thread is a cheap,
  elastic cost next to the tightly-capped semaphore); (3) `scan_import_source` and
  `start_import` got their own bounded waits (`IMPORT_SCAN_TIMEOUT` = 10 minutes, matching the
  copy timeout's reasoning since scanning also does substantial per-file reads;
  `IMPORT_ENQUEUE_TIMEOUT` = 2 minutes, since enqueueing is metadata-only and should be fast
  even over a *working* NFS mount) so the dialog surfaces a clear timeout error instead of
  "Starting…"/"Scanning…" hanging forever. `cargo test` (90/90), `cargo clippy` (no new
  warnings) both clean after the fix — not yet re-verified live against an actual NFS
  disconnect/reconnect cycle, since this sandbox has no NFS mount to reproduce it against.
- 🐛 **Second real bug found and fixed, reported live by the user right after the first**: with
  the mutex bug above fixed, a real 382-file import (all one month, Year/Month depth) still sat
  on "Starting…" for a long stretch with zero jobs appearing in Activity - not actually
  infinite-hung this time, just badly slow, and indistinguishable from a hang because nothing
  is pushed onto the queue until `enqueue()` returns as a whole. Root cause:
  `naming::resolve_stem` did a **fresh, full `fs::read_dir` of the destination folder on every
  single call**, and `enqueue()` calls it once per group - since Year/Month depth buckets by
  month, all 382 of that month's files shared one destination folder, so this was 382 separate
  full directory listings of the same folder in a row, each a real network round trip over
  NFS/Tailscale. Fixed with a new `naming::StemCache` - one real `fs::read_dir` per unique
  destination directory for the whole `enqueue()` call, cached in a `HashMap<PathBuf,
  HashSet<String>>`, instead of one per group. `resolve_stem`'s signature gained a `&mut
  StemCache` first parameter; behavior (which stems get chosen, collision suffixing) is
  unchanged, only the I/O cost. 1 new unit test confirming a cached listing doesn't see a file
  written to disk after the cache was populated (proof the second call reused the cache rather
  than re-reading) — `cargo test` (91/91), `cargo clippy` (no new warnings) both clean.
- ✅ **Robustness pass against a confirmed slow/flaky real link (real, not hypothetical)**: live
  diagnosis this session found the user's actual NFS destination sustains only **~432 kB/s**
  for synchronous writes (measured directly with `dd oflag=direct,sync`, bypassing ImmAture
  entirely - a `sync`-mounted NFS4 share over a ~100ms-latency Tailscale link with no fast write
  log on the far end's ZFS pool). Confirmed not an ImmAture bug (same speed via plain `dd`), but
  it exposed three real robustness gaps in the import queue, all fixed:
  1. **Flat total-time copy timeout → idle-based timeout.** The original `COPY_TIMEOUT` (10
     minutes flat) would have wrongly killed a large, genuinely-still-advancing file at this
     confirmed speed (a 500MB video alone needs ~19 minutes at 432 kB/s). Replaced with
     `COPY_IDLE_TIMEOUT` (3 minutes of **zero** byte-level progress, not total elapsed time) plus
     a generous `COPY_ABSOLUTE_CAP` backstop (4 hours) - `await_copy` in `queue.rs` polls a
     per-job `AtomicU64` progress counter (new `hash::copy_with_hash` parameter, updated every
     256KB chunk) every 10s via `tokio::select!`, resetting the idle clock on any movement at
     all. 2 new `#[tokio::test(start_paused = true)]` tests (dev-only `tokio` `test-util` feature
     added) prove both directions on a virtual clock, no real waiting: a stalled copy times out;
     a copy advancing once a minute for 50 simulated minutes - well past the old flat timeout -
     never does.
  2. **Temp-file cleanup gap on the most common failure mode.** Re-reading `copy_one` found it
     only cleaned up the `.part-N` temp file on a size-mismatch or rename failure - a raw
     read/write error (by far the most likely outcome of a link dropping mid-copy, and the exact
     thing the user hit earlier when they manually found and deleted leftover `.part-N` files)
     fell straight through with no cleanup at all. Restructured into `copy_one`/`copy_one_inner`
     so **any** failure path cleans up the temp file. New regression test uses a directory as the
     copy source (opens fine, fails on the first `read()` with EISDIR) specifically to reproduce
     "temp file already created, then a raw copy error" - a missing-source-file test wouldn't
     have caught this, since that fails before any temp file exists.
  3. **User-configurable concurrency.** `MAX_CONCURRENT_IMPORT_JOBS` was a hardcoded constant;
     promoted to `ImportSettings.max_concurrent_jobs` (1-4, default 2, `#[serde(default = ...)]`
     for backward compatibility with this session's already-saved `config.json`), read once at
     app startup to size `queue::run`'s semaphore (not live-adjustable mid-session - deliberately
     out of scope, since safely resizing a `Semaphore` with jobs already in flight is real added
     complexity with no clear payoff here). New "Concurrent copies" control in `ImportDialog.tsx`
     (next to Folder Layout), explicitly labeled as applying next launch.
  4. **Live per-job progress in the Activity panel**, as a direct consequence of (1)'s progress
     counter - `ImportJob` gained a `bytes_copied` field (polled the same way as status), and
     `ActivityPanel.tsx`'s Imports section now shows real numbers ("12.4 / 45.0 MB") for a
     `Copying` row instead of a static label that looks identical whether the transfer is
     genuinely advancing or fully stuck - which was itself part of what made this session's whole
     debugging thread so confusing in the first place. A `Failed` row also keeps its last-seen
     progress, showing how far a failed copy actually got.
  - Sleep/suspend mid-copy was checked, not just assumed fine: `guarded_spawn_blocking` only
    blocks *new* work from starting during an imminent suspend (§7.19); a copy already in flight
    when suspend hits keeps running, and if the NFS mount gets force-unmounted by the existing
    systemd-sleep hook (§7.19 Part A) while a write is in flight, that write fails with a real
    I/O error - which now correctly flows through `copy_one`'s cleanup path above instead of
    leaking a temp file, so no separate suspend-specific handling was needed beyond fixing (2).
  - `cargo test` (95/95 across the whole backend), `cargo clippy` (no new warnings), `tsc -b`,
    `oxlint` (no new warning categories) all clean. Not yet manually re-verified against the
    user's actual link under load (this sandbox can't reproduce a real multi-hundred-file import
    at ~432 kB/s) - the two idle-timeout tests exercise the logic on a virtual clock, which
    proves the mechanism but isn't a substitute for watching a real slow import run to
    completion.
- ✅ **Entry point**: a new **"Import from SD Card/Disk…"** File-menu item (`MenuBar.tsx`) —
  kept visually and semantically distinct from the existing, still-inert **"Upload…"** stub
  (which is scoped to uploading files *into* Immich, a different, still-unbuilt feature; not
  conflated with this one).
- ✅ **Activity UI merge** — `EditQueueProvider`/`editQueue.tsx` (§7.20) left completely
  untouched; a new, structurally identical `ImportQueueProvider`/`importQueue.tsx` is an
  independent second poll/context, additionally tracking a `pendingCount` transition from >0 to
  0 (a batch just fully drained) to fire the Immich nudge exactly once per batch, decoupled from
  the dialog's own lifecycle (which has usually already closed by then). A new
  `ActivityIndicator.tsx` reads both contexts for one combined TitleBar pill (superseding
  `EditQueueIndicator.tsx`, which stays as a file but is no longer mounted — see §7.20's note);
  `ActivityPanel.tsx` grew an **Edits** and an **Imports** section in one shared modal rather
  than two competing pills. The `lib.rs` close-block check (§7.20) now sums both queues'
  `pending_count()` into one warning, since an in-flight import copy is no less worth warning
  about on quit than an in-flight metadata edit.
- ✅ 21 new unit tests across `import/{scan,hash,capture_time,history,naming,queue,
  library_match}.rs` (RAW+JPEG pairing scoped per source directory, cross-card basename reuse
  not merging, EXIF-vs-mtime preference order, dedupe hit/miss and the whole-group-vs-partial-
  match rule, Flat/Year-Month path assembly, in-batch and on-disk collision suffixing, size-
  mismatch copy verification and cleanup, library-id exact/ambiguous/no-match resolution) —
  `cargo test` (90/90 across the whole backend), `cargo check`, `cargo clippy` (no new warnings),
  `tsc -b`, `oxlint` (no new warning categories) all clean.
- ⬜ Not yet manually verified against a real SD card/library/server — same sandbox limitation
  as §7.20/§7.21 (no display server, no live Immich server, no NFS mount, no real camera SD
  card). In particular still outstanding: the Immich Library Scan API against the user's actual
  server version, `kamadak-exif`'s real coverage on the user's own RAW formats (especially any
  CR3/RAF), and the full dialog → scan → import → Activity-panel → Immich-nudge flow end to end.

<!-- Paste further decisions, rationale, rejected ideas, or transcripts below; ask Claude to fold them in. -->
