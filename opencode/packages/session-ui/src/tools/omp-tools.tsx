// Oh My Pi tool presentation.
//
// OMP names its own tools (bash, task, eval, web_search, todo, wait, lsp, ...)
// and ships a lot of them. Without a renderer here every one of them fell back
// to the generic "called <tool>" card, which reads as one undifferentiated blob
// and hides the tool's output. Registering them by name gives each one a title,
// a sensible icon, its arguments, and its result in the transcript.
import { For, Show, createMemo, type JSX } from "solid-js"
import type { IconProps } from "@opencode/ui/icon"
import { useI18n, type UiI18n, type UiI18nOrdinaryKey } from "@opencode/ui/context/i18n"
import { BasicTool } from "../components/basic-tool"
import { Markdown } from "../components/markdown"
import type { ToolProps } from "./tool-renderer"

type Render = (props: ToolProps) => JSX.Element

interface Registry {
  register(input: { name: string; render: Render }): unknown
  render(name: string): Render | undefined
}

type Args = (input: Record<string, unknown>) => string[]

function strings(input: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.flatMap((key) => {
    const value = input[key]
    return typeof value === "string" && value ? [value] : []
  })
}

interface OmpToolSpec {
  icon: IconProps["name"]
  title: UiI18nOrdinaryKey
  args?: Args
}

// OMP built-ins that do not already map onto one of OpenCode's renderers.
// `bash`, `task`, `eval` and `web_search` keep their own renderers through the
// aliases below, and `read`/`write`/`edit`/`glob`/`grep` are already native.
const specs: Record<string, OmpToolSpec> = {
  todo: { icon: "checklist", title: "ui.tool.todo" },
  wait: { icon: "outline-rotate-clockwise", title: "ui.tool.wait" },
  find: { icon: "magnifying-glass", title: "ui.tool.find", args: (input) => strings(input, ["query", "task", "description"]) },
  lsp: { icon: "code-lines", title: "ui.tool.lsp", args: (input) => strings(input, ["operation", "query", "file"]) },
  ast_grep: { icon: "code", title: "ui.tool.astGrep", args: (input) => strings(input, ["pattern", "path"]) },
  ast_edit: { icon: "code", title: "ui.tool.astEdit", args: (input) => strings(input, ["pattern", "path"]) },
  github: { icon: "github", title: "ui.tool.github", args: (input) => strings(input, ["operation", "query", "repo"]) },
  checkpoint: { icon: "outline-reset", title: "ui.tool.checkpoint", args: (input) => strings(input, ["label", "name"]) },
  rewind: { icon: "arrow-undo-down", title: "ui.tool.rewind", args: (input) => strings(input, ["label", "id"]) },
  context_notes: { icon: "file-document", title: "ui.tool.contextNotes" },
  new_context: { icon: "new-session", title: "ui.tool.newContext" },
  security_scan: { icon: "shield", title: "ui.tool.securityScan", args: (input) => strings(input, ["target", "path"]) },
  debug: { icon: "monitor", title: "ui.tool.debug", args: (input) => strings(input, ["operation", "program"]) },
  ida: { icon: "cube", title: "ui.tool.ida", args: (input) => strings(input, ["operation", "database"]) },
  memory_edit: { icon: "brain", title: "ui.tool.memoryEdit", args: (input) => strings(input, ["operation", "query"]) },
  retain: { icon: "brain", title: "ui.tool.retain", args: (input) => strings(input, ["content", "fact"]) },
  recall: { icon: "brain", title: "ui.tool.recall", args: (input) => strings(input, ["query"]) },
  reflect: { icon: "brain", title: "ui.tool.reflect", args: (input) => strings(input, ["query", "question"]) },
  learn: { icon: "graduation-cap", title: "ui.tool.learn", args: (input) => strings(input, ["lesson", "title"]) },
  manage_skill: { icon: "graduation-cap", title: "ui.tool.manageSkill", args: (input) => strings(input, ["operation", "name"]) },
  browser: { icon: "window-cursor", title: "ui.tool.browser", args: (input) => strings(input, ["action", "url"]) },
  computer: { icon: "monitor", title: "ui.tool.computer", args: (input) => strings(input, ["action", "query"]) },
  image_gen: { icon: "outline-photo", title: "ui.tool.imageGenerate", args: (input) => strings(input, ["prompt"]) },
  report_tool_issue: { icon: "warning", title: "ui.tool.reportIssue", args: (input) => strings(input, ["tool", "title"]) },
  ask: { icon: "bubble-5", title: "ui.tool.ask" },
  run_code: { icon: "code-slash", title: "ui.tool.runCode" },
  eval: { icon: "code-slash", title: "ui.tool.eval" },
  python: { icon: "code-slash", title: "ui.tool.python" },
  notebook: { icon: "file-document", title: "ui.tool.notebook", args: (input) => strings(input, ["path"]) },
  bg: { icon: "status", title: "ui.tool.bg" },
  detach: { icon: "split", title: "ui.tool.detach" },
  report_issue: { icon: "warning", title: "ui.tool.reportIssue", args: (input) => strings(input, ["tool", "title"]) },
}

function ToolOutput(props: { output?: string }) {
  const i18n = useI18n()

  return (
    <Show when={props.output}>
      {(text) => (
        <div
          data-component="tool-output"
          data-scrollable
          tabIndex={0}
          role="region"
          aria-label={i18n.t("ui.scrollView.ariaLabel")}
        >
          <Markdown text={text()} />
        </div>
      )}
    </Show>
  )
}

function OmpTool(props: ToolProps) {
  const i18n = useI18n()
  const spec = createMemo(() => specs[props.tool])
  const input = createMemo(() => (props.input ?? {}) as Record<string, unknown>)
  const args = createMemo(() => spec()?.args?.(input()) ?? [])

  // eval and python carry the code they ran; an xdev device call carries its
  // JSON args as `content` on the write that dispatched it.
  const code = createMemo(() => {
    const value = input().code
    if (typeof value !== "string" || !value) return undefined
    const language = input().language
    return `\`\`\`${typeof language === "string" ? language : ""}\n${value}\n\`\`\``
  })

  const device = createMemo(() => {
    const value = input().content
    return typeof value === "string" && value ? `\`\`\`json\n${value}\n\`\`\`` : undefined
  })

  return (
    <BasicTool
      {...props}
      icon={spec()?.icon ?? "mcp"}
      hasContent={!!code() || !!device() || !!props.output}
      trigger={{ title: spec() ? i18n.t(spec()!.title) : props.tool, args: args() }}
    >
      <Show when={code() || device() || props.output}>
        <div
          data-component="tool-output"
          data-scrollable
          tabIndex={0}
          role="region"
          aria-label={i18n.t("ui.scrollView.ariaLabel")}
        >
          <Show when={code()}>{(text) => <Markdown text={text()} />}</Show>
          <Show when={device()}>{(text) => <Markdown text={text()} />}</Show>
          <Show when={props.output}>{(text) => <Markdown text={text()} />}</Show>
        </div>
      </Show>
    </BasicTool>
  )
}

interface OmpTodoTask {
  content: string
  status: string
}

interface OmpTodoPhase {
  name?: string
  tasks: OmpTodoTask[]
}

function todoPhases(metadata: Record<string, unknown>): OmpTodoPhase[] {
  const phases = metadata.phases

  if (!Array.isArray(phases)) return []

  return phases.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const phase = entry as Record<string, unknown>
    const tasks = Array.isArray(phase.tasks)
      ? phase.tasks.flatMap((task) => {
          if (!task || typeof task !== "object") return []
          const value = task as Record<string, unknown>
          if (typeof value.content !== "string") return []
          return [{ content: value.content, status: typeof value.status === "string" ? value.status : "pending" }]
        })
      : []

    return [{ name: typeof phase.name === "string" ? phase.name : undefined, tasks }]
  })
}

const todoMarker: Record<string, string> = {
  completed: "\u2713",
  in_progress: "\u25B8",
  abandoned: "\u2715",
  pending: "\u2022",
}

function TodoTool(props: ToolProps) {
  const i18n = useI18n()
  const phases = createMemo(() => todoPhases((props.metadata ?? {}) as Record<string, unknown>))

  return (
    <BasicTool
      {...props}
      icon="checklist"
      hasContent={phases().length > 0 || !!props.output}
      trigger={{ title: i18n.t("ui.tool.todo") }}
    >
      <Show when={phases().length > 0} fallback={<ToolOutput output={props.output} />}>
        <div data-component="tool-output" data-scrollable tabIndex={0} role="region" aria-label={i18n.t("ui.scrollView.ariaLabel")}>
          <For each={phases()}>
            {(phase) => (
              <div>
                <Show when={phase.name}>
                  <div data-slot="todo-phase">{phase.name}</div>
                </Show>
                <For each={phase.tasks}>
                  {(task) => (
                    <div data-slot="todo-item" data-status={task.status}>
                      <span data-slot="todo-marker">{todoMarker[task.status] ?? todoMarker.pending}</span>
                      <span data-slot="todo-content">{task.content}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </BasicTool>
  )
}

// Group headers name each tool once; without this the OMP tools would read as
// their raw snake_case names.
export function ompToolTitle(name: string, i18n: UiI18n): string | undefined {
  const spec = specs[name]
  return spec ? i18n.t(spec.title) : undefined
}

export function registerOmpTools(registry: Registry): void {
  for (const name of Object.keys(specs)) {
    registry.register({ name, render: name === "todo" ? TodoTool : OmpTool })
  }

  // Raw OMP names that the UI already renders under a different name.
  const aliases: Record<string, string> = {
    bash: "shell",
    task: "subagent",
    web_search: "websearch",
  }

  for (const [alias, target] of Object.entries(aliases)) {
    const render = registry.render(target)
    if (render) registry.register({ name: alias, render })
  }
}
