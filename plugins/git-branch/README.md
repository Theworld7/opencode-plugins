# git-branch

Shows the checked-out git branch in the OpenCode footer. Clicking it opens the same picker dialog that `/skills` uses, so a branch switch is one click away from wherever you are.

```
⎇ feature/deep
```

## Where it shows

Appended to `home.footer.status` and `prompt.footer.status`, next to the other footer status items. It renders nothing when the working directory is not a git repository.

## Interactions

| Action | Result |
| --- | --- |
| Click the branch name | Branch picker: searchable, current branch marked |
| Pick a branch | `git switch <branch>` |
| `/git-branch` or `/gb` | Same picker, keyboard only |
| Command palette | "Git: 切换分支" |

Remote-tracking refs (`origin/main`) are listed too: `git switch origin/x` is rejected by git, so the plugin retries `git switch x`, which creates the tracking branch. Failures (uncommitted changes, branch checked out in another worktree) surface as a toast with git's own message.

## Following changes made outside OpenCode

Two paths, both cheap:

1. `vcs.branch.updated` — OpenCode's own event, applied immediately.
2. A 1s poll that reads `.git/HEAD` directly. No `git` process, so polling does not cost a spawn per second.

`gitDir` walks up from the working directory and understands the `gitdir:` pointer file used by worktrees and submodules, so the indicator works inside `git worktree` checkouts. Detached HEAD shows the 7-character short SHA.

## Notes

- Branch names longer than 28 characters are truncated with `…`.
- Switching runs `git switch` in the working directory, so normal git rules apply.
