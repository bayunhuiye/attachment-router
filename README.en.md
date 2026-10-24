# Attachment Router

[简体中文](README.md) ｜ **English**

> **Author**: bayunhuiye ｜ **Version**: 1.0.0 ｜ **Min Obsidian version**: 1.0.0

An Obsidian plugin. It only handles **notes created after the plugin was enabled**: images, GIFs, videos and other files dragged or pasted into those notes are routed automatically into a mirrored path under the vault root, keeping the original filenames. The notes themselves stay where they are.

Notes that already existed before enabling, and the old attachments they reference (an `assets/` folder, for example), are left completely alone — the plugin does not migrate anything.

## Resulting structure

> The folder names below are the **defaults, in Chinese** (`所有笔记素材合集` = "all note assets", `图片`/`动图`/`视频`/`素材` = images / GIFs / videos / other). Every one of them is renameable in settings, including into English.

```
模板/
└── 火焰拖尾.md

所有笔记素材合集/
└── 模板/
    └── 火焰拖尾笔记素材-20261022-143012-123/
        ├── 图片/     png jpg jpeg webp bmp tga tif tiff avif svg
        ├── 动图/     gif apng
        ├── 视频/     mp4 mov webm avi mkv m4v wmv flv
        └── 素材/     everything else (zip psd shader pdf ...)
```

The asset folder mirrors however many subfolders deep the note sits: assets for `模板/特效/火焰拖尾.md` go to `所有笔记素材合集/模板/特效/火焰拖尾笔记素材-<timestamp>/图片/`. This way two notes with the same name in different folders (`模板/测试.md` and `草稿/测试.md`) never share one asset folder.

The root folder name is configurable. If a note with the same name already exists at the vault root (say `所有笔记素材合集.md`), the plugin stops routing and asks you to rename, avoiding a file/folder path collision.

## Installation

### Option 1: Manual install

Copy the whole `attachment-router` folder into your vault's `.obsidian/plugins/`. Three files are required:

```
<your vault>/.obsidian/plugins/attachment-router/manifest.json
<your vault>/.obsidian/plugins/attachment-router/main.js
<your vault>/.obsidian/plugins/attachment-router/styles.css
```

Then open Obsidian → Settings → Community plugins → turn off Safe mode → find **Attachment Router** under Installed plugins and enable it. If it is not listed, restart Obsidian once.

### Option 2: Download from GitHub

Download `main.js`, `manifest.json` and `styles.css` from the repository, put them in `<your vault>/.obsidian/plugins/attachment-router/`, then enable the plugin.

### Option 3: Install with BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then in BRAT settings use Add Beta plugin and enter `bayunhuiye/attachment-router`.

## Usage

Just drag or paste as usual — nothing else to do. Filenames **always keep their original name**; duplicates of the same name and extension get `_1`, `_2`; the timestamp appears only in the `... Note Assets-<timestamp>` folder name, never on files.

- Drag in `fire.png` → `…/模板/火焰拖尾笔记素材-20261022-143012-123/图片/fire.png`
- Drag in `fire.png` again → `…/图片/fire_1.png`, a third → `…/图片/fire_2.png`
- Drag in `clip.mp4` → `…/视频/clip.mp4`
- Drag in `pack.zip` → `…/素材/pack.zip`

Name collisions are checked **within the same category folder only**, case-insensitively (`Fire.png` and `fire.png` collide on Windows / macOS). Filenames get only the minimum sanitisation for illegal characters (`\ / : * ? " < > | # ^ [ ]` become `_`).

If you drop a file onto the file explorer rather than into a note body, no link is ever written, so the plugin skips it with a notice instead of moving it blindly.

## Settings

Settings → Community plugins → Attachment Router. A callout at the top of the page asks you to confirm two Obsidian settings first:

1. **Automatically update internal links** (Settings → Files and links): leave it on. The plugin relies on it to keep links in note text in sync when assets are moved or renamed; with it off, only the currently open note is corrected.
2. **Detect all file extensions** (Settings → Files and links): turn it on. Otherwise formats Obsidian cannot open natively — txt, zip and so on — stay hidden from the file explorer (the files were routed correctly, they are just invisible).

The plugin's own settings:

| Setting | Description |
|---|---|
| Enabled | Master switch; the cutoff time is shown underneath |
| Asset root folder name | Defaults to `所有笔记素材合集` |
| Category folder names | 图片 / 动图 / 视频 / 素材 (images / GIFs / videos / other) — all four editable |
| Extension lists | Three groups, comma-separated |
| Link-write timeout | Default 2500 ms, minimum 500 ms |
| Auto-clean interval | In days, default 7, set to 0 to disable |
| Safety switch | Only route files at the vault root or next to the note |

To reset the cutoff: disable the plugin → delete `.obsidian/plugins/attachment-router/data.json` → re-enable it. The side effect is that all settings return to their defaults.

## Cleaning up unreferenced assets

Three entry points with different scopes:

- The trash icon in the left sidebar, the note context menu item "Clean unreferenced assets", and the command "Clean unreferenced assets in current note" — these handle the selected notes (multi-select in the file explorer is supported)
- The "Clean unreferenced assets in all notes" button in settings — this scans the entire asset root

All of them list what will be removed for confirmation first, then move it to the trash and clean up empty category folders and empty mirrored parent folders.

The plugin also runs a periodic scan on the auto-clean interval, moving vault-wide unreferenced assets to the trash and removing empty folders. The scan runs while idle and shows a brief notice when it starts and finishes.

## When a note is renamed or moved

Its asset folder follows along:

- Note renamed → the asset folder segment takes the new note name; the timestamp and asset filenames stay unchanged
- Note moved to another folder → the whole segment moves under the new mirrored parent, and the old empty folders are reclaimed bottom-up
- Folder renamed or moved → the matching mirrored subtree under the asset root moves as a whole; if the destination already has a folder of that name, the two are merged case by case, and colliding segments stay put with a notice

## Known limitations

- Only `.md` notes are handled; dragging inside Canvas does nothing, and dragging a file from the vault's own file explorer does not trigger either (that is a move, not a creation).
- Notes created before enabling are never routed — by design; move them by hand if you need to.
- Cleanup only covers notes this plugin has handled (those with an asset-folder record); older notes get no automatic cleanup.
- Keeping original filenames means the same name (`fire.png`) can appear in several notes. The files live in different mirrored folders, but Obsidian's `![[fire.png]]` is **ambiguous** between same-named files — prefer `![[folder/fire.png]]`. When same-named files exist in the vault the plugin stops bulk-rewriting note links and leaves it to Obsidian's "Automatically update internal links".
- A note renamed while the plugin was disabled will not have its asset folder renamed: the next drag creates a new folder and the old segment becomes an orphan, to be removed manually.
- Routing depends on the link-write timing; on a very slow machine raise the timeout to around 4000 ms.
- Mirroring makes asset paths longer — watch the 260-character path limit on Windows with deeply nested notes.
- "Created after enabling" is decided by file creation time. On the rare filesystem that cannot report a creation time, editing an old note may make it look new.

## Uninstall

Turn the switch off, or delete the plugin folder. Assets already routed are not rolled back.
