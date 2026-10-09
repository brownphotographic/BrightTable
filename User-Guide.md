# BrightTable User Guide

BrightTable is a light table for your photos. It sits between your [Immich](https://immich.app) photo library and your favourite open-source RAW editor (ART, RawTherapee, or darktable), so you can browse, rate, tag, edit, and export your photos without leaving one clean, simple app.

This guide walks through setup first, then every feature, in the order you'll actually meet them.

> **Before you start:** BrightTable needs a running Immich server — it has no library of its own. It's Linux-only, and it writes files directly to disk, so please back up your library before you dive in.

---

## 1. What you'll need

- A Linux desktop.
- A working **Immich server** you can reach (URL + API key).
- The **local file path** on your machine where Immich's photos actually live on disk (e.g. an NFS or SMB mount). BrightTable needs this to read/write sidecar files and hand photos to your RAW editor.
- One or more RAW editors installed, if you want to edit photos: **ART**, **RawTherapee**, or **darktable** (plus their command-line tools — `ART-cli`, `rawtherapee-cli`, or `darktable-cli` — if you want automatic processing and round-trip functionality).

---

## 2. Installing BrightTable

Visit the Readme file for installation instructions.

---

## 3. First-time setup

The first time you open BrightTable, head to **Preferences** (gear icon, or `Ctrl+,`). There are five tabs:

### Library tab

This connects BrightTable to your photos.

1. **Connection** — enter your Immich server URL and API key. Choose a connection mode (LAN, Tailscale, or Auto) and click **Test Connection** to confirm it works.
2. **Originals on Disk** — tell BrightTable where your Immich photos live on your local filesystem. Pick the share type (NFS or SMB) and map the local folder to the matching Immich library root. There's a separate mapping for an external library vs. Immich's own upload folder — fill in whichever applies to you. The reason for this is to allow for successful round-trip editing of your photos. Without it, BrightTable will not be able to read/write your photos on disk when you want edit them in your external editor or RAW editor.
3. **Read Only** — this is **on by default** for safety. Turn it off once you're happy with your setup and ready to let BrightTable write ratings, tags, and edits to your files.
4. There are also safety limits here (max writes per batch, max concurrent scans) — the defaults are sensible, no need to touch them unless you know why you want to.

### Applications tab

This is where you tell BrightTable which programs to use.

- **External Editor** — pick any general image editor you like (for quick touch-ups outside the RAW workflow).
- **RAW Converter** — pick ART, RawTherapee, or darktable, and point BrightTable at both the app itself and its command-line tool (e.g. `ART-cli`). Mark one converter as **active** — that's the one the round-trip buttons will use. Note: depending on how you installed these apps, how you access the CLI folders will vary. Rather than spelling this out here, please refer to the user guides for those apps for details of how to get access to that path.
- **exiftool** path — needed if you want exports to keep or selectively strip metadata like GPS.

Use the built-in **app picker** here — it finds apps installed as Flatpak, Snap, AppImage, or native packages automatically.

### Lenses tab

Settings for **Change Lens** (see [Changing the lens](#changing-the-lens) below):

- **Write original files** — also rewrite the lens inside the RAW/JPEG itself (needs exiftool). Off by default. Turn it on if you use darktable, or if your camera records a lens name that's wrong.
- **Keep a backup of originals** — exiftool leaves the untouched file next to it as `<name>_original`.
- **Update RawTherapee / ART profiles** — points an existing `.pp3`/`.arp` at the chosen lens. It never creates one.
- **My lenses** — add any lens by name. Most manual and adapted lenses aren't in lensfun, so type whatever name you want written to the photo.
- **Coded lens mappings** — "the camera says *Summicron-M 1:2/50*, but it's really a *Planar T\* 2/50 ZM*". You can list several real lenses per coded lens and choose the default action: keep the coded lens and add a note, or replace it.

### Sharing tab

Connect a Flickr account if you want to upload photos straight from BrightTable. See [Sharing to Flickr](#sharing-to-flickr) below.

(Mastodon, PixelFed, and Loops are shown here too, but they're "coming soon" — not usable yet.)

### Configuration tab

1. Cosmetic and housekeeping options: window control position (left/right), Dark or Light theme, and thumbnail cache size with a **Clear Cache** button.
2. Change the default location for storing the configuration file for the app. Useful if you distro-hop a lot - so you can keep your settings consistent across different distros. Note there is a separate checkbox for storing the sign in credentials / keys in the same folder.

### Shortcuts tab

Every keyboard shortcut can be rebound here — click a shortcut, then press your preferred key combo. There's a **Reset to Defaults** button if you want to start over.

---

## 4. A tour of the main window

- **Title bar** — window controls, an activity icon showing background jobs in progress (imports, exports, stacking, and more), and a connection status pill showing whether BrightTable can reach Immich and your local library mount. Click the pill for details, or a quick link into Library Settings.
- **Menu bar** — File, Edit, View, Help, a Filters button, a search box, a thumbnail zoom slider, and a row of tabs to jump between **Photos**, **Folders**, **Albums**, **People**, **Tags**, and **Trash**, each showing a live count.
- **Main grid** — your photos for whichever tab is selected.
- **Metadata panel** (right, toggle with `Ctrl+I`) — details for the selected photo.
- **Viewer** — opens full-screen when you open a photo (press `Enter`), with zoom, a filmstrip, and its own editing shortcuts.

---

## 5. Browsing your library

- **Photos** — your whole library, grouped by day, newest first.
- **Folders** — browse the real folder structure on your Immich server.
- **Albums** — view, create, rename, and delete albums.
- **People** — Immich's face-recognition groups.
- **Tags** — view and manage your tags.
- **Trash** — see anything you've deleted, restore it, or empty the trash for good.
- **Search** — type into the search box and press Enter for a smart search across your library.

Adjust thumbnail size with the slider in the menu bar or `Ctrl +` / `Ctrl -`. Turn on **Grid Loupe** to get a magnified preview when you hover over a thumbnail — handy for checking sharpness without opening the full viewer. Or just to get that nostalgic light table feel (sorry I can't provide any E6 processing chemical smell; maybe that will come in a future version). Choose how much of the window it takes up in **Preferences → Configuration → Thumbnail Loupe Size**: **Small** keeps the original grid/loupe split, **Large** shrinks the grid to a thin strip so the loupe fills most of the view.

---

## 6. Selecting and viewing photos

Click a thumbnail to select it, or use the checkboxes to select several. Once something's selected, a **Selection Bar** appears: Favourite and Rate stay as direct buttons, and everything else is grouped into dropdowns — **Organize** (Add to Album/Tag), **Stack**, **Edit** (Tweak/Headless Roundtrip, Open in Ext. Editor, Rotate), **Copy/Paste** (Image Processing and Metadata), and **Share** (Export to Folder, Share to Flickr) — with **Move to Trash** (and Remove from Album/Tag, where relevant) as trailing buttons. This same grouped bar, with the same actions, now appears consistently across every tab — Photos, Folders, Albums, People, Tags, and Search — not just Photos/Folders.

Right-click any photo for a context menu with the same options, grouped the same way.

Double-click or press `Enter` to open the full-screen **Viewer**. From there you can zoom, flip through the filmstrip, rate, rotate, launch editors, and reach the same Organize/Edit/Copy-Paste/Share menus — all without going back to the grid. Press `L` for a loupe, then scroll the mouse wheel over the photo to zoom it from 100% (actual pixels) up to 500%. For RAW files the loupe magnifies the full-size JPEG your camera embedded in the RAW; a label on the loupe shows while full resolution is loading, or if only preview resolution is available (some cameras only embed a small preview). Press `Ctrl+F` (or **More → View Fullscreen**) to show just the photo, fullscreen; `Esc` returns.

---

## 7. Rating, favourites and filters

- Press **1–5** to rate a photo, **0** to clear the rating, **9** to reject it.
- Press **F** to toggle Favourite.
- Click **Filters** in the menu bar to narrow the grid by minimum star rating, Favourites only, or media type (Photos/Videos/All).
- The Filters panel can also narrow by **Camera**, **Lens** (listing only lenses used on the chosen camera, plus **No lens** for shots with no lens recorded, e.g. manual or adapted glass) and **Focal Length** as shot (drag the slider or type a value in mm; matches within ±0.5mm). The slider spans the focal lengths of the lenses in scope, or of the chosen lens.

---

## 8. Stacking photos together

Stacks group related shots (like a RAW+JPEG pair, or a burst) into one tile in the grid — the same way on every tab (Photos, Folders, Albums, People, Tags, Search).

- **Stack Selected** — select 2+ photos, then use the Edit menu, context menu, or Selection Bar (or press `S`).
- **Smart Stack** — Edit menu → **Smart Stack…** automatically groups photos for you, by:
  - **Name** — same filename, different extension (e.g. a RAW and its JPEG). **Prefer as pick** lets you choose whether the RAW or the JPEG becomes the stack's cover photo (defaults to RAW).
  - **Version** — an original plus edited renditions matching a filename pattern. Tick **Automatically include unselected RAW/JPEG siblings** (on by default) to also pull in a matching RAW/JPEG sibling elsewhere in your library that you didn't explicitly select.
  - **Time** — photos taken within a chosen number of seconds of each other.

Expand a stack in the grid to see its members, and mark one as the "pick" (the cover photo). Unstack anytime from the context menu. Stacking and unstacking run in the background — track progress in the Activity panel alongside imports and exports.

---

## 9. Editing photos

This is BrightTable's main job: sending a RAW file out to a real editor and bringing the result back.

- **Tweak Roundtrip** (`Ctrl+Enter`) — opens the photo in your chosen RAW editor (ART, RawTherapee, or darktable). Works on RAW files and on JPEG/TIFF, since all three editors can also develop those directly. When you're done editing and close it, BrightTable automatically runs that editor's command-line tool to process your changes.
- **Headless Roundtrip** — from the context menu, this reprocesses one or more selected photos (RAW or JPEG/TIFF) through the RAW CLI directly, without opening the editor GUI. Great for batch-applying edits you've already made.
- **Open in External Editor** (`Ctrl+E`) — opens the photo in your general-purpose editor instead.
- **Copy/Paste Image Processing** (`Ctrl+C` / `Ctrl+V`) — copy the edit settings (sidecar) from one photo and apply them to others.
- **Sync Metadata from Sidecar** (Edit menu, or context menu) — re-reads the on-disk sidecar file so BrightTable's view matches what's actually saved.
- **Rotate Left/Right** (`Ctrl+[` / `Ctrl+]`).
- **Change Lens…** — see below.
- **Copy Lens / Paste Lens…** (`Ctrl+Alt+C` / `Ctrl+Alt+V`) — see below.

### Changing the lens

For a lens the camera couldn't identify (a manual lens with no contacts), or one it identified wrongly (e.g. a 6-bit coded Leica M lens that's really a Zeiss or Voigtländer). Select one or more photos, then choose **Change Lens…** from the context menu or the **Edit ▾** menu. It's also in the viewer's Edit menu, and on the pencil button next to **Lens** in the metadata panel.

The dialog has two side-by-side panels, **Lens entry** on the left and **Description note** on the right, each with its own toggle:

- **Lens entry: Keep / Replace.** *Replace* writes the chosen lens into the lens model, lens make, lens spec, max aperture and focal length fields (including the 35mm equivalent). For a zoom you enter the as-shot focal length. You can optionally enter the aperture too. *Keep* leaves the lens fields alone. This is useful for a coded lens whose correction profile is close enough.
- **Description note: Add note / No note.** *Add note* adds a `Lens: <actual lens>` line to the description. Re-applying replaces that line rather than adding another.

That gives four combinations. *Keep + No note* would change nothing, so Apply stays disabled for it.

Each switched-on panel has its own lens list. A switched-off one just says what stays as it is. The note uses the entry's lens until you pick a different one, so you can, for example, write the lensfun lens whose correction profile is close enough into the lens fields while the note records the lens you actually used. **Match lens entry** links them again. Whenever the lens being written is part of a coded-lens mapping, a **Write** switch appears above *Writes*. It flips between the coded lens and the lens it's mapped to in one click. The coded side is labelled *Camera's lens* when the photos already carry the coded lens, and *Coded lens* otherwise, for example on a photo with no lens recorded where you picked the mapped lens from the list. The **Description note** panel has the same switch (**Note: Coded lens / Mapped lens**), which starts on *Mapped lens* unless the dialog was filled in by a mapping or a paste. A lens chosen by either switch stays highlighted in its list, pinned at the top under *Selected* if the search would otherwise hide it. You can still pick any other lens from the list. The bottom bar sums up what Apply will do.
- The picker lists, in this order: your mapped lenses, your own lenses, lenses already in your library, and the whole [lensfun](https://github.com/lensfun/lensfun) database. That's the database RawTherapee, ART and darktable use for lens corrections. Lenses with a **profile** badge are in lensfun under exactly that name, so those editors will auto-correct them. For a lens that isn't listed, click **Open Lens Preferences…** at the bottom of the dialog and add it under **My lenses**. Preferences opens on top of the dialog, and the new lens shows up in the lists as soon as you close it.

Where the change shows up:

| What gets written | Immich & BrightTable | RawTherapee | ART | darktable |
|---|---|---|---|---|
| XMP sidecar (always) | ✓ if the camera recorded no lens | — | — | — |
| Existing `.pp3` / `.arp` (default on) | — | ✓ | ✓ | — |
| Original file (Preferences → Lenses, or ticked per edit) | ✓ | ✓ | ✓ | ✓ after *refresh EXIF* |

**Copy Lens / Paste Lens…** copies a lens from one photo to others. Copy Metadata doesn't include the lens because a lens change is more than a simple field copy. Right-click a photo whose lens is right and choose **Copy Lens**. Then select the other photos and choose **Paste Lens…**. This opens Change Lens already filled in with the copied lens and focal length, so you can check it and click **Apply**. The paste reproduces the source photo: its lens entry (as *Replace*) and its `Lens:` note, even when the note names a different lens. That works on photos with no lens recorded too. Only a source with a note but no lens pastes as note only. If the pasted lens is part of a coded-lens mapping, the **Write** switch appears as usual. The aperture isn't copied, because it changes from shot to shot.

RawTherapee, ART and darktable only ever read lens info from the original file, never from an XMP sidecar. If the camera already recorded a lens, Immich keeps showing it too unless the original is written. The dialog warns you and offers **Write the original files for this edit**. In darktable, run *selected images → metadata → refresh EXIF* on photos it already knows about. A lens-correction module already in a photo's darktable history keeps the lens it had.

---

## 10. Importing photos

Add new photos to your library:

1. **File → Import…**
2. Choose a source — BrightTable auto-detects removable drives like SD cards, or you can pick a folder manually.
3. BrightTable scans it and flags anything that looks like a duplicate of what's already in your library.
4. Choose how to organise the destination (e.g. by Year/Month).
5. Start the import.

The dialog closes once the import is queued — track its progress in the **Activity panel** (title bar icon, or File → Recent Activity…).

---

## 11. Exporting and sharing

### Export to Folder

Select photos, then **File → Export to Folder…** (or from the context menu). Choose:

- Output size and quality.
- What metadata to keep: everything, strip GPS only, or strip all metadata.

### Sharing to Flickr

First, connect your account: **Preferences → Sharing → Connect Flickr**. You'll need your own Flickr API key and secret; BrightTable walks you through authorising in your browser and pasting back a verification code.

Once connected, select photos and use **File → Share to Flickr…** (or the context menu). Pick an existing album or create a new one, set the privacy level (Public / Friends & Family / Private), and choose your size/quality/metadata options — just like exporting to a folder.

All exports and uploads run in the background — check progress in the Activity panel.

---

## 12. Printing

Select a photo, then **File → Print…** (or `Ctrl+P`). Pick your printer, paper size, orientation, fit mode, and resolution. There's also a test-pattern option if you want to check your printer's calibration before committing real photos.

---

## 13. Organising with Albums and Tags

- **Add to Album** — select photos, then use the Selection Bar or context menu → **Add to Album…**. Pick an existing album or type a new name to create one on the spot.
- **Add to Tag** (`Ctrl+T`) — context menu → **Add to Tag…**. Assign existing tags or create a new one with a colour swatch.

---

## 14. Deleting photos

- **Move to Trash** — select photos and press `Delete`, or use the Selection Bar. This doesn't delete permanently.
- **Trash tab** — restore anything you didn't mean to delete, or **Empty Trash** to remove it for good.

---

## 15. Keyboard shortcuts

All of these can be changed in **Preferences → Shortcuts**.

| Action                   | Shortcut                        |
| ------------------------ | ------------------------------- |
| Open photo               | `Enter`                         |
| Select all               | `Ctrl+A`                        |
| Deselect / close         | `Esc`                           |
| Move to Trash            | `Delete`                        |
| Previous / next photo    | `←` / `→`                       |
| Previous / next in stack | `↑` / `↓`                       |
| Toggle metadata panel    | `Ctrl+I`                        |
| Toggle filmstrip         | `M`                             |
| Toggle favourite         | `F`                             |
| Toggle loupe             | `L`                             |
| Clear rating             | `0`                             |
| Rate 1–5 stars           | `1`–`5`                         |
| Reject                   | `9`                             |
| Stack selected           | `S`                             |
| Refresh timeline         | `Ctrl+R`                        |
| Open Preferences         | `Ctrl+,`                        |
| Tweak Roundtrip (RAW editor) | `Ctrl+Enter`                |
| Open in External Editor  | `Ctrl+E`                        |
| Print                    | `Ctrl+P`                        |
| Copy / Paste Processing  | `Ctrl+C` / `Ctrl+V`             |
| Copy / Paste Metadata    | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| Copy / Paste Lens        | `Ctrl+Alt+C` / `Ctrl+Alt+V`     |
| Rotate Left / Right      | `Ctrl+[` / `Ctrl+]`             |
| Add to Tag               | `Ctrl+T`                        |
| Zoom grid in / out       | `Ctrl++` / `Ctrl+-`             |
| Fullscreen image         | `Ctrl+F` (`Esc` exits)          |
| Quit                     | `Ctrl+Q`                        |

Shortcuts are disabled while you're typing in a text field.

---

## 16. Troubleshooting

### "Permission denied" writing metadata over NFS

This is common if your Immich server runs on Unraid and BrightTable connects over NFS. It's a UID/GID mismatch, not a real permissions problem — the fix is to reset ownership on the underlying disk path (not the `/mnt/user/...` union path):

```bash
chown -R nobody:users /path/to/your/immich/library
chmod -R 777 /path/to/your/immich/library
```

Because new files created by Immich will reset to the default owner again, set this up as a recurring **User Script** in Unraid (e.g. nightly) rather than a one-off fix. See the project's `README.md` for the full walkthrough.

### Connection status pill shows "local mount unreachable"

The title bar's connection pill checks two separate things: whether BrightTable can reach your Immich server, and whether the local library path(s) configured in Preferences → Library are actually reachable on disk right now. If it turns red with "local mount unreachable," your NFS/SMB share has likely dropped even though Immich itself is still reachable — reconnect the share, then click the pill to re-check. This also means actions that need local disk access (Copy Image Processing, Tweak/Headless Roundtrip, Show in File Manager, rotate) may fail or lag behind while the mount is down.

### Not sure if your Immich server version is supported?

Check `COMPATIBILITY.md` in the project repo for which Immich versions each BrightTable release has been tested against. The **About** dialog (Help menu) also shows the version your build was tested against.

---
