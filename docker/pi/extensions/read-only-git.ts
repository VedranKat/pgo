import { spawn } from "node:child_process";
import process from "node:process";

type GitOperation =
  | "status"
  | "diff"
  | "diff_stat"
  | "diff_shortstat"
  | "diff_name_only"
  | "diff_name_status"
  | "diff_numstat"
  | "diff_summary"
  | "diff_dirstat"
  | "log"
  | "rev_list"
  | "show"
  | "branch"
  | "refs"
  | "grep"
  | "rev_parse"
  | "merge_base"
  | "ls_files"
  | "ls_tree"
  | "root";

type ComparisonMode = "merge-base" | "direct";
type GrepMode = "fixed" | "regex";

type ReadOnlyGitParams = {
  operation: GitOperation;
  base?: string;
  ref?: string;
  path?: string;
  pattern?: string;
  limit?: number;
  offset?: number;
  maxChars?: number;
  comparison?: ComparisonMode;
  diffFilter?: string;
  grepMode?: GrepMode;
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
  "diff_shortstat",
  "diff_name_only",
  "diff_name_status",
  "diff_numstat",
  "diff_summary",
  "diff_dirstat",
  "log",
  "rev_list",
  "show",
  "branch",
  "refs",
  "grep",
  "rev_parse",
  "merge_base",
  "ls_files",
  "ls_tree",
  "root",
];

const DEFAULT_LOG_LIMIT = 30;
const MAX_LOG_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 1000;
const MAX_OFFSET = 1_000_000;
const DEFAULT_MAX_CHARS = 20000;
const MAX_CHARS = 100000;
const MAX_PATTERN_CHARS = 1000;
const SAFE_REVISION = /^[A-Za-z0-9._/@+~^-]+$/;
const SAFE_DIFF_FILTER = /^[ACDMRTUXB*]+$/;
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
const BASE_DIFF_ARGS = ["diff", "--no-ext-diff", "--find-renames"];
const LINE_PAGED_OPERATIONS = new Set<GitOperation>([
  "status",
  "diff_name_only",
  "diff_name_status",
  "diff_numstat",
  "diff_summary",
  "diff_dirstat",
  "log",
  "rev_list",
  "branch",
  "refs",
  "grep",
  "ls_files",
  "ls_tree",
]);

type BuiltGitCommand = {
  operation: GitOperation;
  args: string[];
  command: string;
  linePaged: boolean;
  limit: number;
  offset: number;
  streamOffset: number;
  maxChars: number;
  successStatuses: Set<number>;
};

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
  if (value === undefined) {
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

function boundedInt(
  name: string,
  value: number | undefined,
  fallback: number,
  max: number,
  min = 1,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function diffRangeArgs(
  base: string | undefined,
  ref: string,
  comparison: ComparisonMode,
): string[] {
  if (!base) {
    return ref === "HEAD" ? [] : [ref];
  }
  return [comparison === "direct" ? `${base}..${ref}` : `${base}...${ref}`];
}

function optionalComparison(value: ComparisonMode | undefined): ComparisonMode {
  if (value === undefined) {
    return "merge-base";
  }
  if (value !== "merge-base" && value !== "direct") {
    throw new Error('comparison must be "merge-base" or "direct"');
  }
  return value;
}

function optionalDiffFilter(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const filter = value.trim();
  if (!SAFE_DIFF_FILTER.test(filter)) {
    throw new Error(
      `diffFilter is not allowed: ${value}. Use Git status letters like A, C, D, M, R, T, U, X, B, or *.`,
    );
  }
  return filter;
}

function requiredPattern(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.includes("\0")) {
    throw new Error("pattern is required for operation=grep and must not be empty");
  }
  if (value.length > MAX_PATTERN_CHARS) {
    throw new Error(`pattern must be ${MAX_PATTERN_CHARS} characters or fewer`);
  }
  return value;
}

function optionalGrepMode(value: GrepMode | undefined): GrepMode {
  if (value === undefined) {
    return "fixed";
  }
  if (value !== "fixed" && value !== "regex") {
    throw new Error('grepMode must be "fixed" or "regex"');
  }
  return value;
}

function diffFilterArgs(diffFilter: string | undefined): string[] {
  return diffFilter ? [`--diff-filter=${diffFilter}`] : [];
}

function withPath(args: string[], path: string | undefined): string[] {
  return path ? [...args, "--", path] : args;
}

function defaultLimit(operation: GitOperation): number {
  return operation === "log" ? DEFAULT_LOG_LIMIT : DEFAULT_PAGE_LIMIT;
}

function maxLimit(operation: GitOperation): number {
  return operation === "log" ? MAX_LOG_LIMIT : MAX_PAGE_LIMIT;
}

function buildGitCommand(params: ReadOnlyGitParams): BuiltGitCommand {
  if (!OPERATIONS.includes(params.operation)) {
    throw new Error(`Unsupported read_only_git operation: ${params.operation}`);
  }

  const base = optionalRevision("base", params.base);
  const explicitRef = optionalRevision("ref", params.ref);
  const ref = explicitRef ?? "HEAD";
  const path = assertSafePath(params.path);
  const limit = boundedInt(
    "limit",
    params.limit,
    defaultLimit(params.operation),
    maxLimit(params.operation),
  );
  const offset = boundedInt("offset", params.offset, 0, MAX_OFFSET, 0);
  const maxChars = boundedInt("maxChars", params.maxChars, DEFAULT_MAX_CHARS, MAX_CHARS);
  const comparison = optionalComparison(params.comparison);
  const diffFilter = optionalDiffFilter(params.diffFilter);
  const linePaged = LINE_PAGED_OPERATIONS.has(params.operation);
  const pageProbeLimit = linePaged ? limit + 1 : limit;
  const streamOffset = params.operation === "log" || params.operation === "rev_list" ? 0 : offset;
  const range = diffRangeArgs(base, ref, comparison);
  let gitArgs: string[];
  let successStatuses = new Set([0]);

  switch (params.operation) {
    case "status":
      gitArgs = withPath(["status", "--short", "--branch"], path);
      break;
    case "diff":
      gitArgs = withPath(
        [...BASE_DIFF_ARGS, "--no-textconv", ...diffFilterArgs(diffFilter), ...range],
        path,
      );
      break;
    case "diff_stat":
      gitArgs = withPath(
        [...BASE_DIFF_ARGS, "--stat", ...diffFilterArgs(diffFilter), ...range],
        path,
      );
      break;
    case "diff_shortstat":
      gitArgs = withPath(
        [...BASE_DIFF_ARGS, "--shortstat", ...diffFilterArgs(diffFilter), ...range],
        path,
      );
      break;
    case "diff_name_only":
      gitArgs = withPath(
        [...BASE_DIFF_ARGS, "--name-only", ...diffFilterArgs(diffFilter), ...range],
        path,
      );
      break;
    case "diff_name_status":
      gitArgs = withPath(
        [...BASE_DIFF_ARGS, "--name-status", ...diffFilterArgs(diffFilter), ...range],
        path,
      );
      break;
    case "diff_numstat":
      gitArgs = withPath(
        [...BASE_DIFF_ARGS, "--numstat", ...diffFilterArgs(diffFilter), ...range],
        path,
      );
      break;
    case "diff_summary":
      gitArgs = withPath(
        [...BASE_DIFF_ARGS, "--summary", ...diffFilterArgs(diffFilter), ...range],
        path,
      );
      break;
    case "diff_dirstat":
      gitArgs = withPath(
        [
          ...BASE_DIFF_ARGS,
          "--dirstat=files,10,cumulative",
          ...diffFilterArgs(diffFilter),
          ...range,
        ],
        path,
      );
      break;
    case "log":
      gitArgs = withPath(
        base
          ? [
              "log",
              "--oneline",
              "--decorate",
              "--skip",
              String(offset),
              "--max-count",
              String(pageProbeLimit),
              `${base}..${ref}`,
            ]
          : [
              "log",
              "--oneline",
              "--decorate",
              "--skip",
              String(offset),
              "--max-count",
              String(pageProbeLimit),
              ...(ref === "HEAD" ? [] : [ref]),
            ],
        path,
      );
      break;
    case "rev_list":
      gitArgs = withPath(
        base
          ? [
              "rev-list",
              "--topo-order",
              "--date-order",
              "--parents",
              "--skip",
              String(offset),
              "--max-count",
              String(pageProbeLimit),
              `${base}..${ref}`,
            ]
          : [
              "rev-list",
              "--topo-order",
              "--date-order",
              "--parents",
              "--skip",
              String(offset),
              "--max-count",
              String(pageProbeLimit),
              ref,
            ],
        path,
      );
      break;
    case "show":
      gitArgs = withPath(
        ["show", "--no-ext-diff", "--no-textconv", "--stat", "--oneline", "--decorate", ref],
        path,
      );
      break;
    case "branch":
      gitArgs = ["branch", "--all", "--no-color"];
      break;
    case "refs":
      gitArgs = [
        "for-each-ref",
        "--sort=-creatordate",
        "--format=%(refname:short)%09%(objectname:short)%09%(objecttype)%09%(creatordate:short)%09%(contents:subject)",
        "refs/heads",
        "refs/tags",
        "refs/remotes",
      ];
      break;
    case "grep": {
      const pattern = requiredPattern(params.pattern);
      const grepMode = optionalGrepMode(params.grepMode);
      gitArgs = withPath(
        [
          "grep",
          "--line-number",
          "--column",
          "--full-name",
          "-I",
          "--no-color",
          grepMode === "regex" ? "-E" : "-F",
          "-e",
          pattern,
          ...(explicitRef ? [explicitRef] : []),
        ],
        path,
      );
      successStatuses = new Set([0, 1]);
      break;
    }
    case "rev_parse":
      gitArgs = ["rev-parse", "--short", ref];
      break;
    case "merge_base":
      if (!base) {
        throw new Error("base is required for operation=merge_base");
      }
      gitArgs = ["merge-base", base, ref];
      break;
    case "ls_files":
      gitArgs = withPath(["ls-files"], path);
      break;
    case "ls_tree":
      gitArgs = withPath(["ls-tree", "-r", "--full-tree", "--long", ref], path);
      break;
    case "root":
      gitArgs = ["rev-parse", "--show-toplevel"];
      break;
  }

  const args = [...BASE_GIT_ARGS, ...gitArgs];
  return {
    operation: params.operation,
    args,
    command: ["git", ...args].join(" "),
    linePaged,
    limit,
    offset,
    streamOffset,
    maxChars,
    successStatuses,
  };
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

function runProcess(
  args: string[],
  signal: AbortSignal | undefined,
  onStdout: (chunk: string, stop: () => void) => void,
  onStderr: (chunk: string, stop: () => void) => void,
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stoppedEarly: boolean;
  timedOut: boolean;
  cancelled: boolean;
}> {
  return new Promise((resolve, reject) => {
    let stoppedEarly = false;
    let timedOut = false;
    let cancelled = false;
    let stderr = "";
    let settled = false;

    const child = spawn("git", args, {
      cwd: process.cwd(),
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
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stop = () => {
      stoppedEarly = true;
      child.kill("SIGTERM");
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 15000);
    const abort = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };

    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => onStdout(chunk, stop));
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      onStderr(chunk, stop);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        reject(new Error(`git failed to start: ${error.message}`));
      }
    });
    child.on("close", (status, exitSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        resolve({ status, signal: exitSignal, stderr, stoppedEarly, timedOut, cancelled });
      }
    });
  });
}

async function runGitText(command: BuiltGitCommand, signal?: AbortSignal): Promise<ToolResult> {
  let output = "";
  let seenChars = 0;
  let truncatedByChars = false;

  const result = await runProcess(
    command.args,
    signal,
    (chunk, stop) => {
      seenChars += chunk.length;
      if (output.length < command.maxChars) {
        output += chunk.slice(0, command.maxChars - output.length);
      }
      if (seenChars > command.maxChars && !truncatedByChars) {
        truncatedByChars = true;
        stop();
      }
    },
    (chunk, stop) => {
      seenChars += chunk.length;
      if (output.length < command.maxChars) {
        output += chunk.slice(0, command.maxChars - output.length);
      }
      if (seenChars > command.maxChars && !truncatedByChars) {
        truncatedByChars = true;
        stop();
      }
    },
  );

  if (result.cancelled) {
    throw new Error("read_only_git cancelled");
  }
  if (result.timedOut) {
    throw new Error("git timed out after 15s");
  }
  if (!truncatedByChars && !command.successStatuses.has(result.status ?? -1)) {
    throw new Error(output.trim() || result.stderr.trim() || `git exited with status ${result.status}`);
  }

  const rendered = output.trim() || "(no output)";
  const truncated = truncate(rendered, command.maxChars);
  const text = truncatedByChars
    ? `${truncated.text}\n\n[read_only_git output truncated at ${command.maxChars} characters]`
    : truncated.text;

  return {
    content: [{ type: "text", text: `$ ${command.command}\n${text}` }],
    details: {
      command: command.command,
      operation: command.operation,
      truncated: truncated.truncated || truncatedByChars,
      originalChars: truncatedByChars ? `>${command.maxChars}` : truncated.originalChars,
    },
  };
}

async function runGitLines(command: BuiltGitCommand, signal?: AbortSignal): Promise<ToolResult> {
  const lines: string[] = [];
  let pending = "";
  let lineIndex = 0;
  let hasMore = false;

  const pushLine = (line: string, stop: () => void) => {
    if (lineIndex >= command.streamOffset + command.limit) {
      hasMore = true;
      stop();
      return;
    }
    if (lineIndex >= command.streamOffset) {
      lines.push(line);
    }
    lineIndex += 1;
  };

  const result = await runProcess(
    command.args,
    signal,
    (chunk, stop) => {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        pending = pending.slice(newlineIndex + 1);
        pushLine(line, stop);
        if (hasMore) {
          return;
        }
        newlineIndex = pending.indexOf("\n");
      }
    },
    () => {},
  );

  if (!hasMore && pending.length > 0) {
    pushLine(pending.replace(/\r$/, ""), () => {});
    pending = "";
  }

  if (result.cancelled) {
    throw new Error("read_only_git cancelled");
  }
  if (result.timedOut) {
    throw new Error("git timed out after 15s");
  }
  if (!hasMore && !command.successStatuses.has(result.status ?? -1)) {
    throw new Error(result.stderr.trim() || `git exited with status ${result.status}`);
  }

  const rendered = lines.length > 0 ? lines.join("\n") : "(no output)";
  const truncated = truncate(rendered, command.maxChars);
  const nextOffset = command.offset + command.limit;
  const pageNote = hasMore
    ? `\n\n[read_only_git has more lines; call again with offset=${nextOffset} to continue this page sequence]`
    : "";

  return {
    content: [
      {
        type: "text",
        text: `$ ${command.command}\n${truncated.text}${pageNote}`,
      },
    ],
    details: {
      command: command.command,
      operation: command.operation,
      truncated: truncated.truncated,
      originalChars: truncated.originalChars,
      offset: command.offset,
      limit: command.limit,
      nextOffset: hasMore ? nextOffset : undefined,
      hasMore,
      linesReturned: lines.length,
    },
  };
}

async function runGit(params: ReadOnlyGitParams, signal?: AbortSignal): Promise<ToolResult> {
  if (signal?.aborted) {
    throw new Error("read_only_git cancelled");
  }

  const command = buildGitCommand(params);
  return command.linePaged ? runGitLines(command, signal) : runGitText(command, signal);
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
      "For large comparisons, start with diff_shortstat, diff_dirstat, diff_name_status, or diff_numstat before requesting full diff output.",
      "Use rev_list to page commit topology, refs to list local refs, ls_tree to inspect tracked tree contents at a ref, and grep to search tracked content.",
      "If a line-paged result reports hasMore/nextOffset, continue with the same parameters and the next offset only when more of that listing is needed.",
      "If a result is truncated by maxChars, narrow by path or switch to a summary operation; do not repeat the same call with the same parameters.",
      'If a result is "(no output)", do not repeat the same operation with the same parameters. Treat it as empty and broaden once or report no findings.',
      'Use comparison="direct" for exact release/tag-to-ref comparisons; use the default comparison="merge-base" for branch review.',
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
            "Read-only git operation: status, diff, diff_stat, diff_shortstat, diff_name_only, diff_name_status, diff_numstat, diff_summary, diff_dirstat, log, rev_list, show, branch, refs, grep, rev_parse, merge_base, ls_files, ls_tree, or root.",
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
        pattern: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PATTERN_CHARS,
          description: "Required search pattern for operation=grep. Defaults to a fixed-string match.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PAGE_LIMIT,
          description:
            "Maximum rows for line-paged operations, or commits for operation=log. Defaults: log=30, line pages=200. Max: log=200, line pages=1000.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: MAX_OFFSET,
          description:
            "Zero-based row offset for line-paged operations. Use details.nextOffset when hasMore is true; do not repeat the same offset.",
        },
        maxChars: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CHARS,
          description: "Maximum returned output characters. Default: 20000.",
        },
        comparison: {
          type: "string",
          enum: ["merge-base", "direct"],
          description:
            "How diff operations compare base and ref. merge-base uses base...ref for branch review. direct uses base..ref for exact release/tag comparisons.",
        },
        diffFilter: {
          type: "string",
          description:
            "Optional Git diff-filter letters for diff operations, such as A, D, M, R, AM, or ACMRT. Use to narrow large comparisons.",
        },
        grepMode: {
          type: "string",
          enum: ["fixed", "regex"],
          description:
            "How operation=grep interprets pattern. fixed is the default. regex uses Git extended regular expressions.",
        },
      },
    },
    async execute(toolCallId, params, signal) {
      return runGit(params, signal);
    },
  });
}
