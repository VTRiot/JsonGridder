# Changelog

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
