# deepseek-balance

Shows the DeepSeek account balance in the OpenCode footer, so a run that is quietly draining credit is visible without leaving the editor.

```
DeepSeek ¥12.34
```

## Where it shows

Appended to `home.footer.status` and `prompt.footer.status`. The prompt footer shows the short form (`DS ¥12.34`) and only in the session view.

## Interactions

| Action | Result |
| --- | --- |
| Click the balance | Re-query and open a dialog with per-currency totals, granted vs topped-up split, and the last update time |
| `/deepseek-balance` or `/dsb` | Same as clicking |
| Idle | Refreshes every 5 minutes |

A manual click keeps a spinner up for at least 1s so a fast response still reads as "something happened". Errors turn the footer red and toast the message; an account that is out of credit turns it amber.

## Credentials

Looked up in this order, first working key wins:

1. `DEEPSEEK_API_KEY`
2. OpenCode's SQLite credential store (`opencode.db`, read-only via `bun:sqlite`)
3. The legacy `auth.json` (`~/.local/share/opencode` or `~/.config/opencode`)

Rotated keys normally live in the SQLite store while `auth.json` goes stale, so a 401 on a key falls through to the next candidate instead of failing outright.

## Notes

- Calls `GET https://api.deepseek.com/user/balance` with a 10s timeout.
