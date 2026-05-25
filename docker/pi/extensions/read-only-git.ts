import { spawnSync } from "node:child_process";
import process from "node:process";

type GitOperation =
  | "status"
  | "diff"
  | "diff_stat"
  | "diff_name_only"
  | "log"
  | "show"
  | "branch"
  | "rev_parse"
  | "ls_files"
  | "root";

type ReadOnlyGitParams = {
  operation: GitOperation;
  base?: string;
  ref?: string;
  path?: string;
  limit?: number;
  maxChars?: number;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type ExtensionAPI = {
  registerTool: (definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: ReadOnlyGitParams,
      signal?: AbortSignal,
    ) => Promise<ToolResult> | ToolResult;
  }) => void;
};

const OPERATIONS: GitOperation[] = [
  "status",
  "diff",
  "diff_stat",
  "diff_name_only",
  "log",
  "show",
  "branch",
  "rev_parse",
  "ls_files",
  "root",
];

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const DEFAULT_MAX_CHARS = 20000;
const MAX_CHARS = 100000;
const SAFE_REVISION = /^[A-Za-z0-9._/@+~^-]+$/;
const BASE_GIT_ARGS = [
  "-c",
  "core.pager=cat",
  "-c",
  "color.ui=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
];

function assertSafeRevision(name: string, value: string): string {
  const ref = value.trim();
  if (ref.includes("..")) {
    throw new Error(
      `${name} must be one git ref or revision, not a range: ${value}. ` +
        "Use base and ref separately, for example base=main and ref=HEAD.",
    );
  }
  if (!ref || ref.startsWith("-") || !SAFE_REVISION.test(ref)) {
    throw new Error(
      `${name} is not an allowed git ref or revision: ${value}. ` +
        "Use values like main, HEAD, HEAD~1, a branch name, or a commit hash.",
    );
  }
  return ref;
}

function optionalRevision(name: string, value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : assertSafeRevision(name, value);
}

function assertSafePath(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const normalized = value.replace(/^@/, "").replace(/\\/g, "/").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`path must be a workspace-relative path: ${value}`);
  }
  return normalized;
}

function boundedInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`numeric option must be an integer from 1 to ${max}`);
  }
  return value;
}

function rangeArgs(base: string | undefined, ref: string): string[] {
  return base ? [`${base}...${ref}`] : ref === "HEAD" ? [] : [ref];
}

function withPath(args: string[], path: string | undefined): string[] {
  return path ? [...args, "--", path] : args;
}

function buildGitArgs(params: ReadOnlyGitParams): string[] {
  if (!OPERATIONS.includes(params.operation)) {
    throw new Error(`Unsupported read_only_git operation: ${params.operation}`);
  }

  const base = optionalRevision("base", params.base);
  const ref = optionalRevision("ref", params.ref) ?? "HEAD";
  const path = assertSafePath(params.path);
  const limit = boundedInt(params.limit, DEFAULT_LIMIT, MAX_LIMIT);

  switch (params.operation) {
    case "status":
      return withPath(["status", "--short", "--branch"], path);
    case "diff":
      return withPath(["diff", "--no-ext-diff", "--no-textconv", ...rangeArgs(base, ref)], path);
    case "diff_stat":
      return withPath(["diff", "--no-ext-diff", "--stat", ...rangeArgs(base, ref)], path);
    case "diff_name_only":
      return withPath(["diff", "--no-ext-diff", "--name-only", ...rangeArgs(base, ref)], path);
    case "log":
      return withPath(
        base
          ? ["log", "--oneline", "--decorate", "--max-count", String(limit), `${base}..${ref}`]
          : ["log", "--oneline", "--decorate", "--max-count", String(limit)],
        path,
      );
    case "show":
      return withPath(
        ["show", "--no-ext-diff", "--no-textconv", "--stat", "--oneline", "--decorate", ref],
        path,
      );
    case "branch":
      return ["branch", "--all", "--no-color"];
    case "rev_parse":
      return ["rev-parse", "--short", ref];
    case "ls_files":
      return withPath(["ls-files"], path);
    case "root":
      return ["rev-parse", "--show-toplevel"];
  }
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  return {
    text: `${text.slice(0, maxChars)}\n\n[read_only_git output truncated at ${maxChars} characters]`,
    truncated: true,
    originalChars: text.length,
  };
}

function runGit(params: ReadOnlyGitParams, signal?: AbortSignal): ToolResult {
  if (signal?.aborted) {
    throw new Error("read_only_git cancelled");
  }

  const maxChars = boundedInt(params.maxChars, DEFAULT_MAX_CHARS, MAX_CHARS);
  const gitArgs = buildGitArgs(params);
  const args = [...BASE_GIT_ARGS, ...gitArgs];
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_ASKPASS: "/bin/false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXTERNAL_DIFF: "",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: "/bin/false",
    },
    maxBuffer: Math.max(maxChars * 2, 1024 * 1024),
    timeout: 15000,
  });

  if (result.error) {
    throw new Error(`git failed to start: ${result.error.message}`);
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    throw new Error(output || `git exited with status ${result.status}`);
  }

  const rendered = output || "(no output)";
  const truncated = truncate(rendered, maxChars);
  const command = ["git", ...args].join(" ");
  return {
    content: [{ type: "text", text: `$ ${command}\n${truncated.text}` }],
    details: {
      command,
      operation: params.operation,
      truncated: truncated.truncated,
      originalChars: truncated.originalChars,
    },
  };
}

export default function activate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_only_git",
    label: "Read-Only Git",
    description: "Run one constrained read-only git inspection operation in the mounted workspace.",
    promptSnippet: "Inspect local git state with constrained read-only operations.",
    promptGuidelines: [
      "Use read_only_git instead of bash for git inspection.",
      "read_only_git is read-only; do not ask it to mutate refs, files, remotes, index, or working tree.",
      "Use read_only_git with operation=status before drawing conclusions about uncommitted work.",
      "A git ref is a branch, tag, commit, or revision expression. Use HEAD for the current branch.",
      "For branch comparisons, pass base and ref separately, for example base=main and ref=HEAD. Do not pass main...HEAD as one value.",
      "Prefer small read_only_git calls, then inspect specific files with read/grep/find/ls as needed.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: OPERATIONS,
          description:
            "Read-only git operation: status, diff, diff_stat, diff_name_only, log, show, branch, rev_parse, ls_files, or root.",
        },
        base: {
          type: "string",
          description:
            "Optional base branch/ref for branch comparisons, such as main. Do not include ranges like main...HEAD.",
        },
        ref: {
          type: "string",
          description:
            "Optional target ref or revision. Defaults to HEAD, which means the current branch. Examples: HEAD, HEAD~1, a branch name, or a commit hash.",
        },
        path: {
          type: "string",
          description: "Optional workspace-relative path filter. Absolute paths and '..' are rejected.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description: "Maximum commits for operation=log. Default: 30.",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CHARS,
          description: "Maximum returned output characters. Default: 20000.",
        },
      },
    },
    async execute(toolCallId, params, signal) {
      return runGit(params, signal);
    },
  });
}
