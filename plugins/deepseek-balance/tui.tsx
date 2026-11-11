import { Plugin } from "@opencode/plugin/tui"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const BASE_URL = "https://api.deepseek.com"
const REFRESH_MS = 5 * 60 * 1000
// ASCII spinner: braille/box glyphs need a font OpenCode can't rely on.
const FRAMES = ["-", "\\", "|", "/"]
const FRAME_MS = 200
// A click that resolves in 80ms would read as "nothing happened"; keep the spinner up.
const MIN_LOADING_MS = 1000

type Entry = { currency: string; total: string; granted: string; toppedUp: string }
type State = {
  status: "idle" | "loading" | "ok" | "error"
  available: boolean
  entries: Entry[]
  updated: number
  error: string
}

const symbol = (currency: string) =>
  currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `

const amount = (entry: Entry) => {
  const value = Number(entry.total)
  return `${symbol(entry.currency)}${Number.isFinite(value) ? value.toFixed(2) : entry.total}`
}

const dataDir = () => process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")

/** Blocks until the minimum loading window has elapsed. */
const holdFor = async (started: number) => {
  const left = MIN_LOADING_MS - (Date.now() - started)
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
}

/** Legacy OpenCode auth store (auth.json). */
async function authKey() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  for (const file of [join(dataDir(), "opencode", "auth.json"), join(config, "opencode", "auth.json")]) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, any>
      const key = parsed?.deepseek?.key
      if (typeof key === "string" && key.trim()) return key.trim()
    } catch {
      // No auth entry there; try the next location.
    }
  }
  return undefined
}

type SqliteDatabase = {
  query: (sql: string) => { get: (...params: string[]) => unknown }
  close: () => void
}
type SqliteModule = {
  Database: new (path: string, options?: { readonly?: boolean }) => SqliteDatabase
}

function isSqliteModule(value: unknown): value is SqliteModule {
  if (typeof value !== "object" || value === null || !("Database" in value)) return false
  const { Database } = value
  return typeof Database === "function"
}

/** Pulls the key out of a credential row's `{"type":"key","key":"sk-…"}` payload. */
function storedKey(row: unknown) {
  if (typeof row !== "object" || row === null || !("value" in row)) return undefined
  const raw = row.value
  if (typeof raw !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || !("key" in parsed)) return undefined
    const key = parsed.key
    return typeof key === "string" && key.trim() ? key.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Newer OpenCode keeps credentials in its SQLite store, not auth.json. Editing
 * the key in the app only updates that row, so auth.json goes stale and every
 * request 401s. bun:sqlite ships with the Bun runtime OpenCode embeds.
 */
async function dbKey() {
  try {
    const sqlite: unknown = await import("bun:sqlite")
    if (!isSqliteModule(sqlite)) return undefined
    const db = new sqlite.Database(join(dataDir(), "opencode", "opencode.db"), { readonly: true })
    try {
      const row = db
        .query(
          "select value from credential where integration_id = 'deepseek' and active = 1 order by time_updated desc limit 1",
        )
        .get()
      return storedKey(row)
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/** Every candidate key, most authoritative first: environment, credential DB, auth.json. */
async function candidateKeys() {
  const keys: string[] = []
  const add = (key: string | undefined) => {
    if (key && !keys.includes(key)) keys.push(key)
  }
  add(process.env.DEEPSEEK_API_KEY?.trim())
  add(await dbKey())
  add(await authKey())
  return keys
}

class Unauthorized extends Error {}

/** Calls the official balance endpoint: GET https://api.deepseek.com/user/balance */
async function fetchBalance(key: string) {
  const response = await fetch(`${BASE_URL}/user/balance`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  })

  const body = await response.text()
  let data: Record<string, any> | undefined
  try {
    data = body ? JSON.parse(body) : undefined
  } catch {
    data = undefined
  }
  if (response.status === 401) throw new Unauthorized(data?.error?.message ?? "HTTP 401")
  if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
  if (!data) throw new Error("Unexpected response from DeepSeek")

  const infos: any[] = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const entries = infos.flatMap((info): Entry[] => {
    const total = String(info?.total_balance ?? "")
    if (!total) return []
    return [
      {
        currency: info?.currency ?? "CNY",
        total,
        granted: String(info?.granted_balance ?? ""),
        toppedUp: String(info?.topped_up_balance ?? ""),
      },
    ]
  })

  return { available: data.is_available === true, entries }
}

/** Tries each candidate key, falling back on 401 so a stale auth.json can't mask a rotated key. */
async function loadBalance() {
  const keys = await candidateKeys()
  let failure = new Error("DeepSeek API key not found. Run `opencode auth login` or set DEEPSEEK_API_KEY.")
  for (const key of keys) {
    try {
      return await fetchBalance(key)
    } catch (error) {
      if (!(error instanceof Unauthorized)) throw error
      failure = error
    }
  }
  throw failure
}

/**
 * Shows the DeepSeek balance in additive footer slots, so nothing OpenCode
 * already renders is covered or replaced. /deepseek-balance opens the details.
 */
export default Plugin.define({
  id: "deepseek.balance",
  async setup(context) {
    const [state, setState] = context.storage.memory("state", {
      initial: {
        status: "idle" as State["status"],
        available: false,
        entries: [] as Entry[],
        updated: 0,
        error: "",
      },
    })

    let running = false
    const [spin, setSpin] = context.storage.memory("spin", { initial: { frame: 0 } })
    let spinner: ReturnType<typeof setInterval> | undefined
    const startSpinner = () => {
      if (spinner) return
      spinner = setInterval(() => {
        setSpin((draft) => {
          draft.frame = (draft.frame + 1) % FRAMES.length
        })
      }, FRAME_MS)
    }
    const stopSpinner = () => {
      if (!spinner) return
      clearInterval(spinner)
      spinner = undefined
    }

    const refresh = async (manual = false) => {
      if (running) return
      running = true
      const started = Date.now()
      setState((draft) => {
        draft.status = "loading"
      })
      startSpinner()
      try {
        const balance = await loadBalance()
        if (manual) await holdFor(started)
        setState((draft) => {
          draft.status = "ok"
          draft.available = balance.available
          draft.entries = balance.entries
          draft.updated = Date.now()
          draft.error = ""
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (manual) await holdFor(started)
        setState((draft) => {
          draft.status = "error"
          draft.error = message
        })
        if (manual) context.ui.toast.show({ title: "DeepSeek", message, variant: "error", duration: 6000 })
      } finally {
        stopSpinner()
        running = false
      }
    }

    const text = (short: boolean) => {
      const prefix = short ? "DS" : "DeepSeek"
      if (state.status === "loading") return `${prefix} ${FRAMES[spin.frame % FRAMES.length]}`
      if (state.updated === 0) return `${prefix} ${state.status === "error" ? "n/a" : "…"}`
      return `${prefix} ${state.entries.map(amount).join(" ") || "—"}`
    }

    const color = () => {
      if (state.status === "error") return context.theme.text.feedback.error.base
      if (state.updated > 0 && !state.available) return context.theme.text.feedback.warning.base
      return context.theme.text.muted
    }

    // Clicking the footer text re-queries the balance (the /deepseek-balance command does the same).
    // Built-in widgets use onMouseUp for click actions, so a drag-select doesn't fire it.
    const Indicator = (props: { short: boolean }) => (
      <text fg={color()} onMouseUp={() => void refresh(true)}>
        {text(props.short)}
      </text>
    )

    const detail = () => {
      const lines: string[] = []
      if (state.error) lines.push(`Unavailable: ${state.error}`)
      if (state.updated === 0) {
        if (lines.length === 0) lines.push("Fetching balance…")
        return lines.join("\n")
      }
      lines.push(`Available: ${state.available ? "yes" : "no"}`)
      for (const entry of state.entries) {
        lines.push(`Balance: ${amount(entry)} (${entry.currency})`)
        if (entry.granted) lines.push(`  Granted: ${entry.granted}`)
        if (entry.toppedUp) lines.push(`  Topped up: ${entry.toppedUp}`)
      }
      lines.push(`Updated: ${new Date(state.updated).toLocaleTimeString()}`)
      return lines.join("\n")
    }

    const dispose = [
      context.ui.slot({ append: "home.footer.status", render: () => <Indicator short={false} /> }),
      // The prompt footer renders on the home screen too; only the session view wants the short form.
      context.ui.slot({
        append: "prompt.footer.status",
        render: () => (context.ui.router?.current?.()?.type === "session" ? <Indicator short /> : null),
      }),
    ]

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "deepseek.balance",
          title: "DeepSeek: show balance",
          group: "DeepSeek",
          palette: true,
          slash: { name: "deepseek-balance", aliases: ["dsb"] },
          run: async () => {
            await refresh(true)
            await context.ui.dialog.alert({ title: "DeepSeek balance", message: detail() })
          },
        },
      ],
    }))

    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)

    return () => {
      clearInterval(timer)
      stopSpinner()
      for (const unregister of dispose) unregister()
    }
  },
})
