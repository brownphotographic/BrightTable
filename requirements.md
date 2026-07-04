# ImAture / ImView — Requirements

> A desktop Digital Asset Management (DAM) client for an **Immich** server, focused on
> culling, rating, stacking, and round-tripping RAW files to external editors.
> Target stack: **Tauri + Rust** shell with a web UI. Visual language: GNOME/Adwaita-style
> dark desktop app (Cantarell, `#1c1c1c` canvas, `#3584e4` accent).
>
> This file is the living source of truth for scope. Paste context from any chat here.
> Status tags: ✅ built · 🟡 partial · ⬜ planned

---

## 1. Product Requirements

### 1.1 Library & navigation
- ✅ Left sidebar with Photos, Albums, People, Stacks, Folders, plus live asset counts and a
  connection-status indicator.
- ✅ **Photos** timeline grouped by day, with date / place / count headers, newest-first.
- ✅ **Folders** view: a filesystem-style tree (year → month) with its own thumbnail grid.
- ✅ Albums and People browse grids (placeholder data).
- ✅ Menu bar (File / Edit / View / Help) with working items + keyboard accelerators.
- ✅ Search field (visual; not yet wired to Immich search).

### 1.2 Selection, detail & viewing
- ✅ Single-click select, checkbox multi-select, selection action bar (Stack / Favorite / Add to Album).
- ✅ Detail view with zoomable preview, EXIF info panel, and a filmstrip of the current set.
- ✅ Adjustable thumbnail size, optional file-type badges, optional status bar (exposed as tweaks).

### 1.3 Ratings & favorites
- ✅ 1–5 star ratings, editable on thumbnails and in the detail info panel; 0 clears.
- ✅ Favorites (heart) with a favorites-only filter.
- ✅ Filter panel: minimum rating, favorites-only, file type (RAW / JPEG / both).
- ✅ Ratings & favorites can each be toggled off globally in Preferences.
- ✅ **Rating keyboard shortcuts**: keys `1`–`5` set the rating, `0` clears, applied to the
  open photo (detail) or the entire selection (grid), with a confirmation toast.
  Defaults map to the star value; fully rebindable.

### 1.4 Stacks
- ✅ Create a stack from any 2+ selected thumbnails (Edit menu, selection bar, context menu, or `S`).
- ✅ Dedicated **Stacks** tab to manage stacks, set the pick, and unstack.
- ✅ **Inline expand/collapse in the grid**: the stack badge is an expander.
  - Collapsed → shows the stack **pick** (cover) with a count badge.
  - Expanded → a full-width band reveals all members inline.
  - **Drag to reorder** members; the **leftmost = pick** unless the user assigns one manually
    (a manual pick persists through reordering).
  - Per-member ★ control sets the pick; Unstack / Collapse in the band header.
- ✅ **Smart Stack** — auto-grouping modes to generate stacks. Entry points: the selection
  action bar (next to "Stack N Photos"), the Edit menu ("Smart Stack…"), and the right-click
  context menu ("Smart Stack N Photos"). **Operates only on the current selection** (shift-click
  ranges + checkbox multi-select); already-stacked photos are skipped. Dialog shows a live
  preview of proposed groups; each created stack gets an auto-assigned pick (RAW / source /
  earliest frame).
  - ✅ **Name** — group images sharing a base filename but differing extension (e.g. `IMG_1234.ARW` + `IMG_1234.JPG`).
  - ✅ **Version** — group renditions of one source (see §1.6 round-trip). User-defined suffix
    (`-version`, `-edited`, `-converted`…). Presented to Immich as an ordinary stack.
  - ✅ **Time** — group by capture time within a tolerance; time slider in tenths of a second up
    to 1s, then whole seconds up to 10s.

### 1.5 Editing & metadata
- ✅ Open in **RAW Editor** (RAW formats) or **External Editor** (everything else), configurable
  per role; app picker detects Native / Flatpak / Snap / AppImage / Custom apps. The launch now
  resolves the asset to its **local filesystem path** via the Library share mapping (§2.3), so the
  editor opens the real file on the NFS/SMB share and can write a rendition back to it.
- ✅ **Metadata editing panel** — toggled by a **View Metadata** button on the right of the
  toolbar; an editable right-hand sidebar that targets the focused photo (selected in grid, or
  open in detail). Works in both browse and detail views.
  - ✅ IPTC: title, caption (multiline), keywords, creator, copyright.
  - ✅ EXIF core: make/model, lens, aperture, shutter, ISO, focal length, date, GPS.
  - ✅ Arbitrary EXIF tags via **ExifTool** — an "Extended · ExifTool" section plus an
    **Add custom tag** form (any tag name + value); custom tags get a Remove control.
  - ✅ **Bulk edit** via **Copy Settings → Paste Settings** (see below).
  - ✅ **Copy Settings** (`Ctrl+C`, Edit menu, context menu) — dialog to choose what to copy
    from the source photo: (1) **Image adjustments** (develop settings from the sidecar), (2)
    **Image metadata** with EXIF/IPTC group toggles and per-field checkboxes (All/None), (3)
    **Ratings / liked**. "Copy Settings" + "Cancel"; copying closes the dialog.
  - ✅ **Paste Settings** (`Ctrl+V`) applies the clipboard to the current selection from four
    entry points: selection action bar (left of "Stack N Photos"), right-click context menu,
    Edit menu, and the keyboard. Both shortcuts are rebindable in Preferences → Shortcuts.
  - 🟡 **Remaining work** (prototype gaps to close when wiring the Tauri/Rust + ExifTool layer):
    - Metadata edits live in **in-memory state only** (like ratings/stacks); not yet persisted to
      `localStorage` or the sidecar. Decide what persists in the prototype vs. the settings folder.
    - "Image adjustments" copy is represented as a **sidecar label** (e.g. `RawTherapee · .pp3`),
      not a real settings blob — pending the sidecar schema (§2.4) and per-editor format mapping.
    - No conflict/merge handling yet when pasting onto photos that already have overrides — current
      behavior is last-write-wins per field. Confirm desired bulk-merge semantics.
    - EXIF/IPTC field set is a representative default list; the real tag universe comes from
      ExifTool at runtime. Field labels → canonical ExifTool tag names still need mapping.

### 1.6 Versioning & round-trip
- ✅ **Create Version** from a RAW original (right-click “Create Version…”, Edit menu, or a
  **Create Version** button in the detail view). A dialog shows source→rendition, the RAW editor
  it opens in, a **version suffix** (presets `-version` / `-edited` / `-converted`, or free text),
  and a live preview of the resulting filename + destination folder.
- ✅ On create, the original is “opened” in the RAW editor at its resolved local path, and the
  pending export is tracked in **Activity** (no queue) — status goes Waiting for export →
  Indexing → Done as the rendition lands and Immich re-scans.
- ✅ Renditions are **auto-stacked with the original** (`20260629-version 1`, `… 2` join the same
  Immich stack; the original stays the pick). Version lineage (`versionOf`) is tracked in app state
  — the prototype stand-in for the sidecar.
- ✅ **Auto-load on landing**: when the export lands, the timeline refreshes so the new rendition
  appears (mirrors Immich re-indexing the external library). Manual **Refresh Timeline** / `F5`
  forces the same.
  - 🟡 **Remaining work**: the render/write and Immich re-index are simulated (timed); lineage
    lives in memory, not yet a real sidecar (§2.4). Suffix→filename and stack mapping are wired.
- Note: Immich has **stacks** (group + cover) but **no native “versions”** concept — version
  lineage is this app's own layer, mapped onto Immich stacks for display.

### 1.7 Sharing & export
- ✅ **Preferences → Sharing** pane to configure share targets: **Flickr, Mastodon, PixelFed, Loops**,
  each with an enable toggle + account/handle field, plus an **Add custom service…** form
  (name + endpoint URL) and a Remove control on custom services. Persists in `localStorage`.
- ✅ **Share** in the right-click context menu → opens a target picker listing the enabled
  services (with a "Manage share services…" shortcut to the Sharing pane); choosing one
  uploads each selected photo immediately.
- ✅ **Export to Folder** (context menu): dialog to export **JPG** (default, with size options
  Full / 2048 / 1024 / 640 px + a quality slider) or **Original**; destination folder field.
  Single **Export** action (no queue) — fires immediately.
- ✅ **Activity (recent writes)** replaced the earlier batch queue: a toolbar **Activity** button
  (amber spinner + count while work is in flight) and File → **Recent Activity…** open a panel
  listing each operation with a live status (Waiting for export / Writing / Indexing / Uploading
  / Done) and **Clear Completed**. Rationale: the app works one image at a time and the real
  rendering happens in the external editor, so a manual "process queue" step was fiction — the
  app just fires the op and tracks it.
  - 🟡 **Remaining work**: the write/upload/index are simulated (timed); real transcode, upload,
    and folder write land with the Tauri/Rust layer. Folder **Choose…** is still a stub.

### 1.8 Printing
- ✅ Print dialog (printer, copies, paper, orientation, color) with a preview; available from
  File menu, detail view, and context menu.

### 1.9 Preferences
- ✅ Tabs: **Library** (Immich endpoint + API key, test/connect), **Applications** (editor roles),
  **Sharing** (share targets + custom services, §1.7), **Configuration** (settings folder, filmstrip
  default, hide stacked children, ratings/favorites), **Shortcuts** (rebindable, reset to defaults).
- 🟡 Persists via `localStorage` (`immd.v1`) in the prototype; production target = settings folder.

---

## 2. System / Technical Requirements

### 2.1 Platform
- Desktop app, **Tauri + Rust** core with a web (HTML/JS) front end.
- Primary target: Linux desktop (GNOME-style chrome, Flatpak/Snap/AppImage app detection).

### 2.2 Immich integration
- Connect to an Immich server via **endpoint URL + API key**.
- Minimum scopes for a viewer/stacker client: `asset.read` and `stack.*`.
- Read assets/timeline; create, modify, and remove **stacks** (set primary/cover).
- ⬜ Wire Search field to Immich search.

### 2.3 Filesystem & round-trip
- 🟡 **Preferences → Library → “Originals on Disk”**: user specifies the **share type** (NFS/SMB),
  the **local mount path** where the share is mounted on this desktop (e.g. `/mnt/nfs/Rob/Images`),
  and the **Immich library path** — the parent prefix Immich reports in an asset's `originalPath`
  (e.g. `/photos`). A live **path-mapping preview** shows Immich path → resolved local path for a
  sample asset, plus a **Verify Access** check. Persists in `localStorage` (`library`).
- ✅ **Editor launch uses the resolved local path.** "Open in RAW/External Editor" (context menu
  + detail view) now hands the editor the *local filesystem path* (Immich prefix swapped for the
  local mount), not an asset id/download — and refuses with a prompt to Preferences if the mapping
  isn't configured. This is what makes round-trip possible: the editor opens the real file and
  saves the rendition back to the same folder.
- 🟡 Export/round-trip destination now derives from the local originals path (`<localRoot>/Exports`).
- ✅ **Auto-load when files land**: after a version/export write completes, the app shows an
  Activity indicator and refreshes the timeline so newly written files appear, mirroring Immich
  re-indexing the watched folder. (Real watcher/scan pending the Rust layer.)
- ⬜ Real filesystem access (mount detection, readability check, actual write-back) is still
  pending the Tauri/Rust layer — the mapping and launch are wired in-prototype but not yet hitting
  disk. **Verify Access** and folder **Choose…** currently toast.
- Note: round-trip realistically requires an **external/in-place** Immich library (stable paths),
  not the managed upload store where `originalPath` is hashed — surfaced in the pane's help text.

### 2.4 Sidecar & metadata compatibility
- ⬜ Store image metadata in **sidecars** (XMP, `.arp`, etc.) in addition to Immich's DB, for
  interoperability with **ART, RawTherapee, digiKam, darktable**.
- ⬜ Support **reading and writing all relevant sidecar types**.
- ⬜ Metadata edits go through **ExifTool** for arbitrary EXIF fields.

### 2.5 External applications
- ✅ Detect and launch native, Flatpak, Snap, and AppImage apps; allow a custom executable/AppImage.
- ✅ Separate "RAW editor" and "external editor" roles.

### 2.6 Persistence
- Settings (server endpoint, editor choices, shortcuts, prefs) stored in a user-chosen
  **settings folder**; prototype mirrors this in `localStorage`.

---

## 3. Open questions / notes
- Confirm Immich API surface for version-as-stack mapping and cover assignment.
- Define the sidecar schema for version lineage (which suffixes, ordering, pick).
- Decide conflict handling when Immich DB metadata and sidecar metadata disagree.

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

### 4.3 Suggested next steps (not yet started)
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

<!-- Paste further decisions, rationale, rejected ideas, or transcripts below; ask Claude to fold them in. -->
