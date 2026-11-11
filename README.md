# opencode-plugins

TUI plugins for [OpenCode](https://opencode.ai) v2. Each plugin is a single `tui.tsx` that OpenCode loads through the `tui` export of `@opencode/plugin`.

Tested against `opencode` 2.2.6.

## Plugins

| Plugin | What it does |
| --- | --- |
| [git-branch](plugins/git-branch) | Current git branch in the footer; click to switch branches, follows checkouts made outside OpenCode |
| [deepseek-balance](plugins/deepseek-balance) | DeepSeek account balance in the footer; click for details |

## Install

OpenCode loads plugins from `~/.config/opencode/plugins/<name>`, so keep this repo wherever you work and link the plugins you want:

```powershell
# Windows, no admin rights needed
New-Item -ItemType Junction `
  -Path   "$HOME\.config\opencode\plugins\git-branch" `
  -Target "$HOME\Projects\opencode-plugins\plugins\git-branch"
```

```sh
# macOS / Linux
ln -s ~/Projects/opencode-plugins/plugins/git-branch ~/.config/opencode/plugins/git-branch
```

Then register them in `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    "./plugins/git-branch",
    "./plugins/deepseek-balance"
  ]
}
```

Restart OpenCode. `opencode plugin list` should list them.

## Adding a plugin

1. Create `plugins/<name>/tui.tsx` with a default export from `Plugin.define({ id, setup })`.
2. Link the directory into `~/.config/opencode/plugins/<name>`.
3. Add `"./plugins/<name>"` to `cli.json`.
4. Restart OpenCode.

Available slots, commands and dialogs come from the `Context` type in `@opencode/plugin/tui`. Reading that `.d.ts` is faster than guessing: the slot tree is `app`, `home.footer[.status]`, `prompt.footer[.status|.file]`, `session.composer.top`, `session.panel`, `sidebar.content`, `sidebar.footer`.

## Notes

- Plugins run inside OpenCode's Bun runtime, so `bun:*` modules and TSX work, but anything that shells out costs a process spawn on every call — avoid it in render or polling paths.
- Keep `id` unique across plugins; OpenCode keys state and keymap layers by it.
