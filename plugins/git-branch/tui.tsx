import { Plugin } from "@opencode/plugin/tui"
import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const POLL_MS = 1000
const MAX_LABEL = 28
const ICON = "⎇"

type View = { branch: string; repo: boolean; busy: boolean }
type GitResult = { code: number; stdout: string; stderr: string }

function exitCode(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error
    if (typeof code === "number") return code
  }
  return -1
}

function git(cwd: string, args: string[]) {
  return new Promise<GitResult>((done) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) => {
      done({ code: error ? exitCode(error) : 0, stdout, stderr })
    })
  })
}

/** Walks up from `start` to find the git dir; `.git` is a pointer file inside worktrees. */
async function gitDir(start: string) {
  let current = resolve(start)
  for (let depth = 0; depth < 40; depth += 1) {
    const dotGit = join(current, ".git")
    try {
      const info = await stat(dotGit)
      if (info.isDirectory()) return dotGit
      const text = await readFile(dotGit, "utf8")
      const match = /^gitdir:\s*(.+)$/m.exec(text)
      if (match) return resolve(current, match[1].trim())
      return undefined
    } catch {
      // Not here; keep walking towards the filesystem root.
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** Reads the checked-out branch straight from HEAD: no git process, so polling stays cheap. */
async function headBranch(directory: string) {
  let head: string
  try {
    head = await readFile(join(directory, "HEAD"), "utf8")
  } catch {
    return undefined
  }
  const line = head.trim()
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(line)
  if (branch) return branch[1].trim()
  const other = /^ref:\s*(.+)$/.exec(line)
  if (other) return other[1].trim()
  if (/^[0-9a-f]{7,40}$/i.test(line)) return line.slice(0, 7)
  return undefined
}

function unique(names: readonly string[]) {
  const seen = new Set<string>()
  const list: string[] = []
  for (const name of names) {
    if (!name || seen.has(name)) continue
    seen.add(name)
    list.push(name)
  }
  return list
}

const failure = (result: GitResult) => {
  const lines = (result.stderr || result.stdout).split("\n").filter((line) => line.trim())
  return lines.length > 0 ? lines[lines.length - 1].trim() : `git switch 失败 (${result.code})`
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Branch indicator for the footer status bars. Clicking opens the branch picker;
 * the current branch is polled from .git/HEAD so a checkout outside OpenCode shows up.
 */
export default Plugin.define({
  id: "git.branch",
  async setup(context) {
    let start: string | undefined
    try {
      start = context.location?.directory ?? context.data.location.default().directory
    } catch {
      start = undefined
    }
    const directory = start ?? process.cwd()

    const [view, setView] = context.storage.memory<View>("state", {
      initial: { branch: "", repo: false, busy: false },
    })

    let repo: string | undefined
    let stopped = false
    let timer: ReturnType<typeof setInterval> | undefined

    const refresh = async () => {
      if (!repo) repo = await gitDir(directory)
      const branch = repo ? await headBranch(repo) : undefined
      if (stopped) return
      setView((draft) => {
        draft.repo = branch !== undefined
        draft.branch = branch ?? ""
      })
    }

    const switchTo = async (branch: string) => {
      setView((draft) => {
        draft.busy = true
      })
      try {
        let result = await git(directory, ["switch", branch])
        // `origin/main` is a remote-tracking ref; git infers the local branch from it.
        const slash = branch.indexOf("/")
        if (result.code !== 0 && slash > 0) {
          const retry = await git(directory, ["switch", branch.slice(slash + 1)])
          if (retry.code === 0) result = retry
        }
        if (result.code !== 0) throw new Error(failure(result))
        context.data.location.vcs.invalidate()
        await refresh()
        context.ui.toast.show({ title: "Git", message: `已切换到 ${view.branch || branch}`, variant: "success" })
      } catch (error) {
        context.ui.toast.show({ title: "Git", message: reason(error), variant: "error" })
      } finally {
        setView((draft) => {
          draft.busy = false
        })
      }
    }

    const open = async () => {
      if (view.busy) return
      await refresh()
      if (!view.repo) {
        context.ui.toast.show({ title: "Git", message: `${directory} 不是 git 仓库`, variant: "warning" })
        return
      }
      let branches: string[]
      try {
        const listed = await context.client.vcs.branch.list({ location: { directory } })
        branches = unique(listed.data)
      } catch (error) {
        context.ui.toast.show({ title: "Git", message: reason(error), variant: "error" })
        return
      }
      if (branches.length === 0) {
        context.ui.toast.show({ title: "Git", message: "没有可切换的分支", variant: "warning" })
        return
      }
      const picked = await context.ui.dialog.select<string>({
        title: "切换 git 分支",
        placeholder: "搜索分支",
        current: view.branch,
        options: branches.map((name) => ({ title: name, value: name })),
      })
      if (picked === undefined || picked === view.branch) return
      await switchTo(picked)
    }

    const label = () => {
      if (view.busy) return `${ICON} …`
      const name = view.branch
      return `${ICON} ${name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name}`
    }

    const Indicator = () => {
      if (!view.repo) return null
      return (
        <text fg={context.theme.text.muted} onMouseUp={() => void open()}>
          {label()}
        </text>
      )
    }

    const dispose = [
      context.data.on("vcs.branch.updated", () => void refresh()),
      context.ui.slot({ append: "home.footer.status", render: () => <Indicator /> }),
      // The prompt footer renders on the home screen too; only the session view wants it there.
      context.ui.slot({
        append: "prompt.footer.status",
        render: () => (context.ui.router.current().type === "session" ? <Indicator /> : null),
      }),
    ]

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "git.branch.switch",
          title: "Git: 切换分支",
          group: "Git",
          palette: true,
          slash: { name: "git-branch", aliases: ["gb"] },
          run: () => open(),
        },
      ],
    }))

    void refresh()
    timer = setInterval(() => void refresh(), POLL_MS)

    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      for (const unregister of dispose) unregister()
    }
  },
})
