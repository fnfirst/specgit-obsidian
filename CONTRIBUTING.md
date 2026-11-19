# Contributing to specgit for Obsidian

Thanks for helping make specgit for Obsidian better.

## Reporting a bug

- **Plugin issues:** open a GitHub issue with steps to reproduce, your Obsidian version, plugin version, and platform (macOS, Windows, Linux, iOS, or Android).
- **Private account, billing, or repository questions:** use **Report a problem** in **Settings → specgit**, or visit [specgit.com/support](https://specgit.com/support). Please keep tokens, private repository details, and personal note content out of public issues.

## Requesting a feature

Open a GitHub issue describing what you are trying to do and how you use specgit in Obsidian.

## How this repository is maintained

This repository is the public mirror of the `specgit` Obsidian plugin (MIT license). The plugin source is developed alongside the rest of specgit and mirrored here for releases.

Because changes are synced from upstream, please open an issue before starting a large pull request so we can coordinate. Small bug fixes and documentation improvements are welcome directly via pull request.

## Local setup

Requires Node.js 22 or later.

```bash
npm ci
npm run typecheck
npm run lint
npm run build
```

To test a local build in a vault, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/specgit/` and reload Obsidian.

## Security

If you find a security issue, please email [support@specgit.com](mailto:support@specgit.com) instead of opening a public issue.
