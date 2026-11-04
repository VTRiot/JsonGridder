# Changelog

## 0.2.0 (2026-11-05)

A redesign of the window, and translation of text values.

### Changed

- Files open in the Tree view. Switch to the Table view with the Tree and Table buttons at the right of the menu bar.
- The left pane lists the arrays that can be shown as a table, with their item counts. Options > Hide Table Targets in Tree View hides it while the Tree view is shown.
- Columns of nested objects have two-level headers.
- A command row with Undo, Redo, Search / Replace, Sort, Filter / Transform, Expand, and Collapse.
- The light theme uses muted colors that are easier on the eyes.

### Added

- An Edit menu. Open in Text Editor opens the file in the Windows default app for `.txt` files.
- Files changed by another app are reloaded when you return to the window; with unsaved changes, the app asks first.
- A status row with the character encoding, the line endings, the number of rows, and whether the document is saved.
- Documents that the table and tree cannot hold open as plain text, with a warning band that gives the reason and the line.
- Translation of text values with Google Gemini, off by default. Save a free-tier key, a paid key, or both, and choose which one to use each time you translate from the right-click menu (Translate to English > Paid / Free); on the free tier, Google uses what you send to improve its products. The API keys are stored in the Windows Credential Manager. Results are shown in a side panel, and can be added as a new column in one undoable edit.
- When the chosen Gemini model is busy or has reached its rate limit, translation can switch to the next model automatically (Options > Translation Settings). Errors say what went wrong, such as an invalid key, a reached rate limit, or a busy model.
- The confirmation before translating and the note that translations are machine guesses can be hidden.

### Network

- The app itself makes no network access unless you enable translation. (The Microsoft Edge WebView2 Runtime may contact Microsoft services on its own.)

### Security

- Lint markers in the text view are drawn with CSS, and the Content Security Policy allows images only from the app itself.

## 0.1.0

The first release.

- View and edit JSON files in table, tree, and text views. Arrays of objects open as a table, and you can pick which inner array to show as the table.
- Edit cells like a spreadsheet, with undo and redo.
- Search and replace, one match at a time or all at once. One undo reverts a whole Replace All.
- Sort, filter, and transform with queries.
- Parts of the file that you did not edit stay as they were: indentation, line endings, and number formats such as `1.0` or long IDs. Saving is atomic, and the app asks before overwriting a file that changed on disk.
- Closing, opening another file, or exiting asks first when there are unsaved changes.
- Dark and light themes. English and Japanese; the app starts in English.
- Wrap at Window Edge: long text in a table cell wraps within the column width.
- Portable: one EXE with no installer. Settings are stored next to the EXE.
- The app itself makes no network access.
