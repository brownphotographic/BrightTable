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
- ✅ **Folders** view: a Year → Month tree (not a real filesystem tree — Immich has no
  filesystem-folder concept for camera-imported assets) with its own thumbnail grid (§7.10).
- ⬜ Albums and People are pure placeholders in the real app (no fake grid data like the
  prototype shows — just a "not built yet" message). Prototype only.
- 🟡 Menu bar (File / Edit / View / Help) is real, but only some items are wired: Select
  All / Deselect All, Refresh Timeline, Preferences, Quit, Stack Selected (§7.13), Smart
  Stack… (§7.14), and the Filters dropdown (§7.11) are real; Upload…, Print…, Recent
  Activity, Copy/Paste Settings, Zoom In/Out, and Sort Photos By are present but do nothing
  yet (§7.15).
- 🟡 Search field exists visually; not wired to Immich search in the real app either.

### 1.2 Selection, detail & viewing
- 🟡 Single-click select and checkbox multi-select are real (grid + Folders view). There's
  no floating **selection action bar** in the real app — no Stack / Favorite / Add to Album
  buttons; bulk favorite/rating happens via keyboard shortcuts instead (§7.8), and Move to
  Trash is a link in the bottom status bar. The action bar itself is prototype only.
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
- ⬜ Open in RAW Editor / External Editor, app picker, local-path resolution — **prototype
  only**. Preferences → Applications (editor role config) is still a placeholder in the
  real app (§7.15); there's no app picker and nothing launches an external editor.
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
> **Prototype only — none of this exists in the real app**, and the prototype itself later
> simplified this away too (§6: "let's simplify and comment this out for now").
- ⬜ Create Version, RAW-editor round-trip, auto-stacked renditions, version lineage.

### 1.7 Sharing & export
> **Prototype only — none of this exists in the real app.** No Sharing preferences content,
> no Share context-menu action, no Export to Folder, no Activity/recent-writes system.
- ⬜ Preferences → Sharing (Flickr/Mastodon/PixelFed/Loops + custom services).
- ⬜ Share via context menu; Export to Folder dialog.
- ⬜ Activity (recent writes) panel.

### 1.8 Printing
- ⬜ Print dialog — prototype only; no printing anywhere in the real app.

### 1.9 Preferences
- 🟡 Tabs: **Library** and **Shortcuts** are real and fully functional (§7.2, §7.8).
  **Applications**, **Sharing**, and **Configuration** exist as tabs in the UI shell but
  each renders the same literal placeholder message (§7.15).
- ✅ Library and Shortcuts config now persist to a real `config.json` in the app's config
  directory via `serde_json` (§7.2) — not `localStorage`. A user-**chosen** settings folder
  (rather than the fixed app config dir) is still ⬜ (§2.6).

---

## 2. System / Technical Requirements

### 2.1 Platform
- ✅ Desktop app, **Tauri + Rust** core with a web (React/TypeScript) front end — this is
  the real app's actual architecture (§7.1).
- ⬜ Flatpak/Snap/AppImage app detection is prototype only — the real app has no app-picker
  at all (§2.5).

### 2.2 Immich integration
- ✅ Connect to an Immich server via endpoint URL + API key (§7.2).
- ✅ `stack.*` scope: create/read/update/delete stacks are real (§7.13).
- ✅ Read assets/timeline (§7.3); real writes so far are asset metadata (rating/favorite/
  description, §7.6), delete/restore/trash (§7.7), and stacks (§7.13).
- ⬜ Wire Search field to Immich search.

### 2.3 Filesystem & round-trip
> Everything below is prototype only — the real app has no filesystem round-trip at all.
- ⬜ Preferences → Library → "Originals on Disk" (share type, local mount, path mapping,
  Verify Access).
- ⬜ Editor launch using a resolved local path.
- ⬜ Export/round-trip destination from a local originals path.
- ⬜ Auto-load timeline refresh tied to a version/export write landing (the real app *does*
  have a manual Refresh Timeline, §7.8 — just not an automatic one, since there's no write
  of that kind to trigger it).

### 2.4 Sidecar & metadata compatibility
- ⬜ Sidecar storage (XMP, `.arp`), read/write, ExifTool-backed arbitrary fields — all
  still planned, matching the prototype's own status here.

### 2.5 External applications
- ⬜ Detect/launch native, Flatpak, Snap, AppImage apps; custom executable — prototype only.
- ⬜ Separate RAW editor / external editor roles — prototype only (Preferences →
  Applications is a placeholder, §7.15).

### 2.6 Persistence
- 🟡 Library and Shortcuts settings are real, persisted to `config.json` in the app's
  config directory (§7.2, §7.8) — not `localStorage`. Editor choices and other prefs
  aren't real yet (nothing to persist — those panes are placeholders). A user-**chosen**
  settings folder (vs. the fixed OS config dir) is still ⬜.

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
  prioritized): Tags (view + add/remove), People (view-only), Location (view + edit
  GPS/place), Date/time (view + edit capture time). Rating/favorite/description are
  already done (§7.6) — this would extend the same metadata panel to the remaining
  fields Immich's API exposes.

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
- ✅ **Folders tab** (`FoldersBrowser.tsx`) is now real. Immich has no filesystem-folder
  concept for camera-imported assets, so — matching the design prototype's synthetic
  `folder` grouping — this reinterprets "Folders" as a **Year → Month tree** over the
  same timeline buckets the Photos view uses (`get_time_buckets`), rather than real
  filesystem paths.
- ✅ Left tree pane: **All Originals** (every bucket), expandable **year** nodes (chevron
  toggles expand/collapse; only the most recent year is expanded by default), and
  **month** leaf nodes — each row shows a live count. Selecting a node loads a flat grid
  (no day/month headers, unlike Photos) of just that node's assets.
- ✅ Bucket-level virtualization (`@tanstack/react-virtual`, same approach as Photos)
  scoped to whichever buckets feed the selected node — selecting "All Originals" windows
  across every bucket exactly like the Photos timeline does, so a large library doesn't
  render everything at once.
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
- **Preferences** — **Library** and **Shortcuts** are real; Applications / Sharing /
  Configuration each render the same literal placeholder as before.
- **Sharing, printing, versions/round-trip** — all still only exist in the `.dc.html`
  prototype (manual Stacks and Smart Stack are now both real, §7.13/§7.14).
- **Menu bar stubs** (`MenuBar.tsx`): Upload…, Print…, Recent Activity, Copy/Paste
  Settings, View → Zoom In/Out, View → Sort Photos By (Newest/Oldest/Name/Rating) are
  present in the menu but not wired to anything real yet. **Refresh Timeline** (`F5`),
  **Select All / Deselect All** (`Ctrl+A` / Edit menu), **Stack Selected** (`S`, §7.13),
  **Smart Stack…** (§7.14), **Quit**, **Preferences** (`Ctrl+,`), and the **Filters**
  dropdown (§7.11) are real.
- Next real-app milestone: pick one of the above (Albums/People, sharing/printing, or
  versions/round-trip) to wire up the same way Library + Photos + Folders + Viewer +
  Delete/Trash + Filters + Stacks were done so far.

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

<!-- Paste further decisions, rationale, rejected ideas, or transcripts below; ask Claude to fold them in. -->
