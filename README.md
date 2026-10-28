# Better Logs Reader

Lens / OpenLens / Freelens extension that replaces the log list of the built-in pod logs tab with the same Monaco editor used to edit resources.

- Select and copy (`Ctrl+A`, `Ctrl+C`) across the **whole** log, not just what fits on screen.
- Selection stays inside the editor and no longer spills onto the app UI.
- Search with `Ctrl+F` inside the editor (the built-in search box is hidden).
- Highlights timestamps, log levels (`ERROR`, `WARN`, `INFO`, `DEBUG`), `[logger.names]`, UUIDs and URLs.
- Follows new lines while you are scrolled to the bottom; scroll up and it stays put.

## Compatibility

Freelens `1.x` and Lens / OpenLens `6.x` (their loaders only accept a `^major.minor` range in `engines`). The plugin only uses the extension API shared by all three (`MonacoEditor`, `podsApi.getLogs`), which I checked against the type definitions and the built-in logs tab's DOM in `@k8slens/core` 6.5.2 and `@freelensapp/core` 1.10.3. It has not been run in the apps themselves.

## Install

`Extensions` → enter `@maksimkurb/lens-better-logs-plugin` → **Install**.

## How it works

The extension API has no hook for the logs dock tab, so the built-in tab is kept (pod/container selectors, tab handling) and only its virtualized `.LogList` is hidden and replaced by a Monaco editor. Logs are fetched with `podsApi.getLogs` for the pod and container selected in the built-in tab: the last 1000 lines first, then only lines newer than the last one seen (every 2s). Scrolling to the top loads earlier lines (the tail grows 4x each time, up to 200000). The built-in tab keeps asking for the same logs in the background; while the editor shows that pod and container, the plugin answers those calls from its own copy, so the API server is queried once. The built-in "Show timestamps", "Word wrap" and "Show previous terminated container" checkboxes keep working and drive the Monaco view. The view follows the tail only if it was already scrolled to the bottom.

Timestamps are always fetched and stripped locally when the checkbox is off, so toggling them (and word wrap) is instant.

Limitation: it relies on the built-in tab's DOM, and on reading the Monaco editor instance off the `MonacoEditor` component in the React tree (the component exposes no handle), so it may need updates after Lens/Freelens UI changes.

## Development

```bash
npm install
npm run build
```

## Publishing

Releases use npm Trusted Publishing (no token). On npmjs.com, open the package → Settings → Trusted Publisher, and add GitHub Actions with repository `maksimkurb/lens-better-logs-reader` and workflow `publish.yml`. Then bump `version` in `package.json`, then push a matching tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```
