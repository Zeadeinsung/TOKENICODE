import { t } from './i18n';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Human-readable (Chinese by default) descriptions of what the agent is doing
 * right now.
 *
 * The chat header and the floating strip both need the same sentence, and the
 * floating strip runs in its own webview (no i18n there), so the string is
 * formatted in the main window and shipped over IPC as plain text.
 */

/** Tools whose activity is best described by one of the activity.* verbs. */
const ACTION_KEYS: Record<string, string> = {
  Bash: 'activity.runningCommand',
  PowerShell: 'activity.runningCommand',
  Shell: 'activity.runningCommand',
  Read: 'activity.readingFile',
  Write: 'activity.writingFile',
  Edit: 'activity.editingFile',
  MultiEdit: 'activity.editingFile',
  NotebookEdit: 'activity.editingFile',
  Grep: 'activity.searching',
  Glob: 'activity.findingFiles',
  WebFetch: 'activity.webFetch',
  WebSearch: 'activity.webSearch',
  Task: 'activity.subAgent',
  Agent: 'activity.subAgent',
  SendMessage: 'activity.subAgent',
  TodoWrite: 'activity.updatingTodo',
  TaskCreate: 'activity.creatingTodo',
  TaskUpdate: 'activity.updatingTodo',
  TaskList: 'activity.readingTodo',
  TaskGet: 'activity.readingTodo',
};

const MAX_DETAIL = 90;
const MAX_THINKING = 48;

/** Last two path segments, matching the tool card's own preview. */
export function shortPath(filePath: string): string {
  const parts = String(filePath || '').split(/[\\/]/);
  return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || filePath;
}

function clip(value: unknown, max = MAX_DETAIL): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ================================================================
   Shell command explanation.

   A raw command line is unreadable to someone watching the agent work:
   `timeout 180 ./node_modules/.bin/tsc --noEmit > log 2>&1` says nothing
   about intent. Map the common commands to a short Chinese sentence and
   keep the concrete bits (what file, what limit) as parenthetical notes.
   Unknown commands fall back to the raw text.
   ================================================================ */

function basename(part: string): string {
  return String(part || '')
    .split(/[\\/]/)
    .pop()!
    .replace(/^["']|["']$/g, '')
    .replace(/\.(cmd|exe|bat|ps1|js|mjs|cjs|sh)$/i, '')
    .toLowerCase();
}

/** Pull the first output redirection target and drop all of them from the text. */
function splitRedirect(command: string): { cleaned: string; redirect: string } {
  let redirect = '';
  const withoutFd = command.replace(/\d*>&\d*/g, ' ');
  const cleaned = withoutFd.replace(
    /(?:^|\s)(?:\d?>>?|&>)\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g,
    (_match, target: string) => {
      const path = target.replace(/^["']|["']$/g, '');
      if (!redirect && !/^(\/dev\/null|nul|\$null)$/i.test(path)) redirect = path;
      return ' ';
    },
  );
  return { cleaned, redirect };
}

function tokenize(text: string): string[] {
  return text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/** Strip wrappers (timeout / sudo / npx / npm exec …) down to the real command. */
function unwrapCommand(tokens: string[]): { base: string; args: string[]; timeoutSec: number | null } {
  let rest = tokens.slice();
  let timeoutSec: number | null = null;

  while (rest.length > 0) {
    const base = basename(rest[0]);

    if (base === 'timeout') {
      let i = 1;
      while (i < rest.length && /^-/.test(rest[i])) {
        i += /^-(?:k|--kill-after)$/i.test(rest[i]) ? 2 : 1;
      }
      const maybe = rest[i];
      if (maybe && /^\d+(?:\.\d+)?[smhd]?$/.test(maybe)) {
        const value = Number(maybe.replace(/[smhd]$/i, ''));
        // `timeout 2m cmd` — convert the suffix to seconds.
        const unit = maybe.match(/([smhd])$/i)?.[1]?.toLowerCase();
        timeoutSec = Math.round(unit === 'm' ? value * 60 : unit === 'h' ? value * 3600 : value);
        i += 1;
      }
      rest = rest.slice(i);
      continue;
    }

    if (['nohup', 'sudo', 'command', 'exec', 'env', 'time'].includes(base)) {
      rest = rest.slice(1);
      continue;
    }

    if (['npx', 'pnpx', 'bunx'].includes(base)) {
      const idx = rest.findIndex((token, i) => i > 0 && !token.startsWith('-'));
      rest = idx > 0 ? rest.slice(idx) : rest.slice(1);
      continue;
    }

    if (['npm', 'pnpm', 'yarn', 'bun'].includes(base)
      && ['exec', 'dlx', 'x'].includes((rest[1] || '').toLowerCase())) {
      const idx = rest.findIndex((token, i) => i > 2 && !token.startsWith('-'));
      rest = idx > 0 ? rest.slice(idx) : rest.slice(2);
      continue;
    }

    return { base, args: rest.slice(1), timeoutSec };
  }

  return { base: '', args: [], timeoutSec };
}

function scriptSummary(script: string): string {
  const s = script.toLowerCase();
  if (/^(build|bld|compile)/.test(s)) return '构建项目';
  if (/test|spec/.test(s)) return '运行测试';
  if (/lint|eslint/.test(s)) return '代码检查';
  if (/typecheck|type-check|tsc/.test(s)) return '类型检查 TypeScript 项目';
  if (/format|prettier/.test(s)) return '格式化代码';
  if (/dev|start|serve/.test(s)) return '启动开发服务器';
  return `执行 ${script} 脚本`;
}

function packageManagerSummary(args: string[]): string {
  const sub = (args[0] || '').toLowerCase();
  if ((sub === 'run' || sub === 'run-script') && args[1]) return scriptSummary(args[1]);
  if (sub === 'test' || sub === 't') return '运行测试';
  if (sub === 'install' || sub === 'i' || sub === 'add' || sub === 'ci') return '安装依赖';
  if (sub === 'build') return '构建项目';
  if (sub === 'start' || sub === 'dev') return '启动开发服务器';
  if (sub === 'lint') return '代码检查';
  return `执行 ${sub || '包管理器'} 命令`;
}

function gitSummary(args: string[]): string {
  const sub = (args.find((arg) => !arg.startsWith('-')) || '').toLowerCase();
  switch (sub) {
    case 'status': return '查看 git 状态';
    case 'diff': return '查看代码改动';
    case 'log': case 'show': return '查看提交历史';
    case 'add': return '暂存改动';
    case 'commit': return '提交代码';
    case 'push': return '推送代码';
    case 'pull': case 'fetch': return '拉取代码';
    case 'checkout': case 'switch': return '切换分支';
    case 'branch': return '查看或创建分支';
    case 'stash': return '暂存当前改动';
    case 'merge': case 'rebase': return '合并分支';
    case 'reset': case 'restore': return '撤销改动';
    case 'clone': return '克隆仓库';
    default: return '执行 git 命令';
  }
}

function commandSummary(base: string, args: string[]): string | null {
  switch (base) {
    case 'tsc': return '类型检查 TypeScript 项目';
    case 'vitest': case 'jest': case 'mocha': case 'ava':
      return '运行测试';
    case 'pytest': case 'py.test':
      return '运行 Python 测试';
    case 'eslint': case 'biome': case 'oxlint':
      return '代码检查';
    case 'prettier': case 'dprint':
      return '格式化代码';
    case 'vite': case 'next': case 'nuxt': case 'astro':
      return args[0] === 'build' ? '构建项目' : '启动开发服务器';
    case 'webpack': case 'rollup': case 'esbuild': case 'turbo': case 'parcel':
      return '构建项目';
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
      return packageManagerSummary(args);
    case 'python': case 'python3': case 'py': {
      if (args[0] === '-m' && /^pytest$/.test(args[1] || '')) return '运行 Python 测试';
      const script = args.find((arg) => !arg.startsWith('-'));
      return script ? `运行 Python 脚本 ${shortPath(script)}` : '运行 Python 脚本';
    }
    case 'node': case 'tsx': case 'ts-node': {
      const script = args.find((arg) => !arg.startsWith('-'));
      return script ? `运行 Node 脚本 ${shortPath(script)}` : '运行 Node 脚本';
    }
    case 'go': {
      const sub = (args.find((arg) => !arg.startsWith('-')) || '').toLowerCase();
      if (sub === 'test') return '运行 Go 测试';
      if (sub === 'build') return '构建 Go 项目';
      if (sub === 'run') return '运行 Go 程序';
      return '执行 Go 命令';
    }
    case 'cargo': {
      const sub = (args.find((arg) => !arg.startsWith('-')) || '').toLowerCase();
      if (sub === 'build') return '构建 Rust 项目';
      if (sub === 'check') return '检查 Rust 代码';
      if (sub === 'test') return '运行 Rust 测试';
      if (sub === 'run') return '运行 Rust 程序';
      return '执行 cargo';
    }
    case 'git': return gitSummary(args);
    case 'grep': case 'rg': case 'ag': case 'ack': case 'findstr':
      return '搜索文本';
    case 'find': case 'fd': case 'dir': case 'ls': case 'where': case 'get-childitem':
      return '查找文件';
    case 'cat': case 'head': case 'tail': case 'more': case 'less': case 'type': case 'get-content':
      return '查看文件内容';
    case 'curl': case 'wget': case 'invoke-webrequest': case 'iwr':
      return '请求网络资源';
    case 'mkdir': case 'md': case 'new-item':
      return '创建目录或文件';
    case 'rm': case 'del': case 'erase': case 'remove-item': case 'rmdir':
      return '删除文件';
    case 'cp': case 'copy': case 'copy-item': case 'xcopy':
      return '复制文件';
    case 'mv': case 'move': case 'move-item':
      return '移动或重命名文件';
    case 'touch': return '创建空文件';
    case 'sed': case 'awk': case 'cut': case 'sort': case 'uniq': case 'tr': case 'jq':
      return '处理文本';
    case 'echo': case 'write-output': case 'printf':
      return '输出文本';
    case 'chmod': case 'chown': return '修改文件权限';
    case 'ps': case 'tasklist': case 'get-process': return '查看进程';
    case 'kill': case 'taskkill': case 'stop-process': return '结束进程';
    case 'docker': return '操作 Docker';
    case 'ssh': case 'scp': return '连接远程服务器';
    case 'tar': case 'zip': case 'unzip': case '7z': case 'compress': return '打包或解压文件';
    default: return null;
  }
}

/**
 * Turn a shell command line into a sentence describing its purpose, e.g.
 * `timeout 180 ./node_modules/.bin/tsc --noEmit > log` → 类型检查 TypeScript 项目（限时 180 秒，结果写入 …/tsc_label.log）.
 * Returns '' for non-Chinese UI so those users keep seeing the raw command.
 */
export function explainShellCommand(raw: string): string {
  const command = String(raw || '').trim();
  if (!command) return '';
  if (useSettingsStore.getState().locale !== 'zh') return '';

  const { cleaned, redirect } = splitRedirect(command);
  const segments = cleaned.split(/&&|\|\||;/).map((part) => part.trim()).filter(Boolean);
  const target = segments.find((part) => !/^(cd|pwd|echo|set|export|source)\b/i.test(part))
    ?? segments[0]
    ?? '';

  const { base, args, timeoutSec } = unwrapCommand(tokenize(target));
  const summary = commandSummary(base, args);
  if (!summary) return '';

  const notes: string[] = [];
  if (timeoutSec && timeoutSec > 0) notes.push(`限时 ${timeoutSec} 秒`);
  if (redirect) notes.push(`结果写入 ${shortPath(redirect)}`);

  return notes.length > 0 ? `${summary}（${notes.join('，')}）` : summary;
}

export interface ToolActionText {
  /** Localized verb, e.g. 运行命令 / 读取文件. */
  verb: string;
  /** Concrete target: the command, file, pattern or URL. May be empty. */
  detail: string;
}

/** Localized verb for a tool, e.g. 运行命令 / 读取文件. */
export function toolVerb(toolName: string): string {
  return t(ACTION_KEYS[toolName] ?? 'activity.tool');
}

export function describeToolAction(toolName: string, input?: any): ToolActionText {
  const key = ACTION_KEYS[toolName];
  const verb = toolVerb(toolName);

  let detail = '';
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
    case 'Shell': {
      const command = String(input?.command ?? input?.script ?? '');
      // Explain the intent in Chinese; fall back to the raw command (clipped)
      // for commands the explainer does not recognise.
      detail = explainShellCommand(command) || clip(command);
      break;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = clip(input?.file_path ? shortPath(input.file_path) : '', 60);
      break;
    case 'Grep':
      detail = clip(input?.pattern);
      break;
    case 'Glob':
      detail = clip(input?.pattern);
      break;
    case 'WebFetch':
      detail = clip(input?.url);
      break;
    case 'WebSearch':
      detail = clip(input?.query);
      break;
    case 'Task':
    case 'Agent':
      detail = clip(input?.description);
      break;
    case 'TodoWrite': {
      const count = Array.isArray(input?.todos) ? input.todos.length : 0;
      detail = count > 0 ? `${count}` : '';
      break;
    }
    case 'TaskCreate':
      detail = clip(input?.subject);
      break;
    case 'TaskUpdate': {
      const status = input?.status;
      detail = status === 'completed' ? '标记为已完成'
        : status === 'in_progress' ? '标记为进行中'
        : status === 'deleted' ? '删除一项'
        : clip(input?.subject);
      break;
    }
    default:
      // Unknown tools: show the raw tool name so the line is never blank.
      detail = key ? '' : toolName;
  }

  return { verb, detail };
}

/** "运行命令：npm run build" — omits the colon when there is no detail. */
export function formatToolAction(toolName: string, input?: any): string {
  const { verb, detail } = describeToolAction(toolName, input);
  return detail ? `${verb}：${detail}` : verb;
}

/**
 * The newest tool call that has not produced a result yet, looking only at the
 * tail of the transcript. Background tabs never enter the 'tool' activity phase,
 * so this is what keeps their strip row concrete.
 */
export function latestPendingTool(messages: Array<{ type?: string; toolName?: string; toolInput?: any; toolCompleted?: boolean; toolResultContent?: string }>): { name: string; input: any } | null {
  const start = Math.max(0, messages.length - 12);
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (message?.type !== 'tool_use' || !message.toolName) continue;
    if (message.toolCompleted || message.toolResultContent) return null;
    return { name: message.toolName, input: message.toolInput };
  }
  return null;
}

/** Last readable clause of the thinking stream, collapsed to one line. */
export function thinkingSummary(text?: string, maxChars = MAX_THINKING): string {
  if (!text) return '';
  // Only the tail matters and this runs on every token of a long stream, so
  // avoid splitting tens of kilobytes just to keep the last line.
  const tail = text.length > 4000 ? text.slice(-4000) : text;
  const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const last = lines[lines.length - 1]
    .replace(/^[-*>#\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!last) return '';
  return last.length > maxChars ? `…${last.slice(-maxChars)}` : last;
}

/** Tail of the streaming answer, for the "输出中：…" line. */
export function writingSummary(text?: string, maxChars = MAX_THINKING): string {
  return thinkingSummary(text, maxChars);
}

export interface ActivitySnapshot {
  phase: string;
  toolName?: string;
  detail?: string;
  partialThinking?: string;
  partialText?: string;
  pendingTool?: { name: string; input: any } | null;
}

/**
 * One line describing the current activity, localized. Returns '' for phases
 * that have nothing worth showing (idle / completed / error).
 */
export function describeActivity(snapshot: ActivitySnapshot): string {
  const { phase } = snapshot;

  if (phase === 'tool') {
    if (snapshot.detail && snapshot.toolName) {
      const verb = t(ACTION_KEYS[snapshot.toolName] ?? 'activity.tool');
      return `${verb}：${snapshot.detail}`;
    }
    if (snapshot.pendingTool) {
      return formatToolAction(snapshot.pendingTool.name, snapshot.pendingTool.input);
    }
    return snapshot.toolName ? t(ACTION_KEYS[snapshot.toolName] ?? 'activity.tool') : t('activity.tool');
  }

  if (phase === 'thinking') {
    const summary = thinkingSummary(snapshot.partialThinking);
    return summary
      ? t('activity.thinkingWith').replace('{text}', summary)
      : t('activity.thinking');
  }

  if (phase === 'writing') {
    const summary = writingSummary(snapshot.partialText);
    return summary
      ? t('activity.writingWith').replace('{text}', summary)
      : t('activity.writing');
  }

  if (phase === 'awaiting') return t('activity.awaiting');

  return '';
}
