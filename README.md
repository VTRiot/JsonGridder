![JsonGridder](docs/images/banner.png)

🇯🇵 [日本語版 README はこちら / Japanese README](README.ja.md)

# JsonGridder

**View and edit JSON files in an Excel-like table.** A free, portable app for Windows, in English and Japanese.

![JsonGridder in the dark theme](docs/images/dark-en.png)

## Features
- **Table, tree, and text views** of the same document. Arrays of objects open as a table, and you can pick which inner array to show as the table.
- **Edit like a spreadsheet**: click a cell and type, press Enter to commit, Ctrl+Z / Ctrl+Y to undo and redo.
- **Search and replace** (Ctrl+F, Ctrl+H), one match at a time or all at once. One Ctrl+Z undoes a whole Replace All.
- **Sort, filter, and transform** with queries.
- **Your file stays as it was where you did not edit it**: the indentation, line endings, and number formats such as `1.0` or long IDs are kept. Saving is atomic, and the app asks before overwriting a file that changed on disk.
- **Unsaved changes are never lost silently**: closing, opening another file, or exiting asks you first.
- **Dark and light themes**, and **English and Japanese** (Options menu). The app starts in English; choose Japanese in the Options menu.
- **Wrap at Window Edge** (Options menu): long text in a table cell wraps onto more lines within the column width, so you can read it without scrolling sideways. The last column reaches the right edge of the window. Drag the border between column headers to change a column's width. This changes only the display, not your file.
- **Portable**: one EXE, no installer. Settings are stored next to the EXE.
- **No network access** by the app itself.

![JsonGridder in the light theme](docs/images/light-en.png)

See the [user guide](docs/guide.md) for step-by-step instructions with screenshots.

## Download
1. Open the [Releases](../../releases) page and download `JsonGridder-<version>-windows-x64.zip`.
2. The ZIP contains `JsonGridder.exe`, this README, `LICENSE`, and `THIRD_PARTY_NOTICES.md`.
3. Extract the ZIP to any folder and run `JsonGridder.exe`. There is no installer, and you do not need administrator rights.

The EXE is not code-signed, so Windows SmartScreen may show "Windows protected your PC" the first time. Click **More info**, then **Run anyway**. On PCs with Smart App Control turned on, the app cannot start.

To check that the download is intact, compare its SHA-256 hash with the one published on the release page. In PowerShell:

```powershell
Get-FileHash .\JsonGridder-<version>-windows-x64.zip -Algorithm SHA256
```

## Getting started
1. Run `JsonGridder.exe`. It starts in English. To use Japanese, choose **Options > Language > 日本語**.
2. Open a file with **File > Open**, by dropping a file on the window, or from the command line:

   ```text
   JsonGridder.exe "C:\path\to\file.json"
   ```

Windows 11 includes the WebView2 runtime that the app needs. If it is missing, the app shows the reason and exits.

### Open .json files with JsonGridder
The app does not change your file associations. To choose it yourself, right-click a `.json` file, select **Open with > Choose another app**, and browse to `JsonGridder.exe`.

## Settings
`JsonGridder.settings.json` is created next to the EXE. It holds the theme, the language, the recent files, and the window position, as readable JSON that you can edit. Move it together with the EXE and your settings move too. Recent files are stored as plain paths. If the folder is not writable, the app still works and tells you that settings cannot be saved.

`language` (optional, `"en"` or `"ja"`, default `"en"`) is **Options > Language**. If it is missing or not one of these values, the app uses English, whatever the Windows display language is.

`splashMs` (optional, default `1500`) is the minimum time in milliseconds the start-up screen stays up when you launch the app directly. Set it to `0` to turn the start-up screen off. It is not shown when a file is opened by double-click or passed as an argument.

`splashCeremony` (optional, default `true`) controls whether the start-up screen is shown on the next launch. When the start-up screen is shown, the app rewrites it to `false`, so normally it appears only on the first launch. Set it back to `true` to see it again on the next launch. If start-up preparation is still pending, the start-up screen is shown even when it is `false`.

`wrapLines` (optional, default `false`) is **Options > Wrap at Window Edge**.

## Uninstall
1. Delete `JsonGridder.exe` and `JsonGridder.settings.json`.
2. Delete the WebView2 working folder `%LOCALAPPDATA%\io.github.vtriot.jsongridder`.

## Known limitations
- If the app or the PC crashes, or Windows shuts down or signs out, unsaved edits are lost. There is no automatic recovery.
- After you edit in the table or the tree, the whole document is written again in a consistent style. Values and key order are kept, but inline layout and how escapes were written are not.
- In documents with numeric keys such as `"1"`, `"10"`, the key order changes when edited, as in JavaScript.
- Saving breaks hard links.
- Sorting by a column header sorts the data itself, and it does not sort numbers numerically.
- Transform keeps numbers exactly as written, and stops with a reason instead of rounding: for example, calculations with numbers too large to hold exactly, or queries whose result keys collide. Decimal calculations use standard floating point (`0.1 + 0.2` gives `0.30000000000000004`).
- Documents with duplicate keys, or with the keys `__proto__` or `constructor`, can be opened only in the text view.
- Typing `[` or `{` in a cell starts typing text. To insert an array or object, use the menu.
- WebView2 may send diagnostic data to Microsoft according to its own settings. The app cannot turn this off.

## Built with
JsonGridder is built with [Tauri](https://tauri.app/) and the editor of [svelte-jsoneditor](https://github.com/josdejong/svelte-jsoneditor) by Jos de Jong, the engine behind JSON Editor Online.

## License
JsonGridder is released under the [MIT License](LICENSE).

The app includes third-party components, each under its own license. Their names, versions, copyright notices, and license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
