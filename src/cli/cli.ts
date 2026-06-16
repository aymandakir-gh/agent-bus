#!/usr/bin/env node
/**
 * agent-bus CLI — coordinate agents over a shared folder, or serve the same
 * protocol over HTTP. Zero runtime deps (uses node:util.parseArgs). File
 * commands talk directly to the folder; `serve` exposes the HTTP transport.
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

import { FileBus } from '../core/file-bus';
import { BusError } from '../core/errors';
import { PROTOCOL_ID, SPEC_VERSION } from '../version';
import { MESSAGE_TYPES, TASK_STATES } from '../core/types';
import type { Message, MessageInput, MessageType, TaskView } from '../core/types';

const OPTIONS = {
  dir: { type: 'string' },
  agent: { type: 'string' },
  task: { type: 'string' },
  title: { type: 'string' },
  text: { type: 'string' },
  reason: { type: 'string' },
  desc: { type: 'string' },
  priority: { type: 'string' },
  tags: { type: 'string' },
  type: { type: 'string' },
  result: { type: 'string' },
  input: { type: 'string' },
  id: { type: 'string' },
  from: { type: 'string' },
  limit: { type: 'string' },
  state: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const HELP = `agent-bus ${SPEC_VERSION} — multi-agent coordination over a shared folder (${PROTOCOL_ID})

Usage: agent-bus <command> [options]

Bus location:  --dir <path>   (default: $AGENT_BUS_DIR or ./.agentbus)

Commands:
  init [dir]                         Initialize a bus directory
  create-task --title <t> --agent <a> [--task <id>] [--desc <d>]
                                     [--priority low|normal|high] [--tags a,b]
  tasks [--state <s>] [--json]       List tasks (optionally filter by state)
  claim <taskId> --agent <a> [--id <key>]   Claim a task (exit 0 = won, 1 = lost;
                                     --id is a stable idempotency key for retries)
  complete <taskId> --agent <a> [--result <json>]
  block <taskId> --agent <a> --reason <r>
  release <taskId> --agent <a>
  cancel <taskId> --agent <a> [--reason <r>]
  post --type <t> --agent <a> [--task <id>] [--text <s>] [--title <s>]
       [--reason <s>] [--input <json>]   Post any message
  messages [--type <t>] [--task <id>] [--from <seq>] [--limit <n>] [--json]
  watch [--from <seq>]               Stream messages as they arrive (Ctrl-C to stop)
  serve [--port 7777] [--host 127.0.0.1]   Start the HTTP transport

Examples:
  agent-bus --dir ./shared init
  agent-bus --dir ./shared create-task --title "Write tests" --agent lead
  agent-bus --dir ./shared tasks
  agent-bus --dir ./shared claim <taskId> --agent worker-1
`;

type Values = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends { type: 'boolean' } ? boolean : string;
};

function resolveDir(values: Values): string {
  return resolve(values.dir ?? process.env.AGENT_BUS_DIR ?? '.agentbus');
}

/** Validate a flag is one of an allowed set; throw a clear error otherwise. */
function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw as T;
}

/** Parse a non-negative integer flag; throw a clear error (caught at top level). */
function intFlag(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}

/** JSON.parse with a clear, flag-attributed error message. */
function parseJsonFlag(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    throw new Error(`${name} must be valid JSON: ${(e as Error).message}`);
  }
}

function out(values: Values, human: string, data: unknown): void {
  if (values.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write(human + '\n');
}

function summarize(m: Message): string {
  const taskId = (m as { taskId?: string }).taskId;
  const text = (m as { text?: string }).text ?? (m as { title?: string }).title ?? '';
  const tail = [taskId ? `task=${taskId}` : '', text].filter(Boolean).join(' ');
  return `#${m.seq} ${m.type} ${m.agent}${tail ? ' ' + tail : ''}`;
}

function renderTasks(tasks: TaskView[]): string {
  if (tasks.length === 0) return '(no tasks)';
  const rows = tasks.map((t) => [t.state, t.id, t.title.slice(0, 40), t.claimer ?? '-']);
  const head = ['STATE', 'TASK', 'TITLE', 'CLAIMER'];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [fmt(head), ...rows.map(fmt)].join('\n');
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });
  const v = values as Values;

  if (v.version) {
    process.stdout.write(`agent-bus ${SPEC_VERSION} (${PROTOCOL_ID})\n`);
    return 0;
  }
  const cmd = positionals[0];
  if (!cmd || v.help) {
    process.stdout.write(HELP);
    return cmd ? 0 : v.help ? 0 : 1;
  }

  switch (cmd) {
    case 'init': {
      const dir = positionals[1] ? resolve(positionals[1]) : resolveDir(v);
      await FileBus.init(dir);
      out(v, `initialized bus at ${dir}`, { dir });
      return 0;
    }

    case 'serve': {
      const { startServer } = await import('../http/server');
      const port = intFlag(v.port, '--port');
      if (port !== undefined && port > 65535) throw new Error('--port must be 0-65535');
      const { url } = await startServer({
        dir: resolveDir(v),
        ...(port !== undefined ? { port } : {}),
        ...(v.host ? { host: v.host } : {}),
      });
      process.stdout.write(`agent-bus serving ${resolveDir(v)} at ${url}\n`);
      process.stdout.write('press Ctrl-C to stop\n');
      await new Promise<void>((res) => process.on('SIGINT', () => res()));
      return 0;
    }

    case 'watch': {
      const bus = await FileBus.init(resolveDir(v));
      const fromSeq = intFlag(v.from, '--from') ?? 0;
      process.stdout.write(`watching ${resolveDir(v)} (from seq ${fromSeq})\n`);
      await new Promise<void>((res) => {
        const sub = bus.subscribe(
          (m) => out(v, summarize(m), m),
          { fromSeq },
        );
        process.on('SIGINT', () => {
          sub.close();
          res();
        });
      });
      return 0;
    }

    case 'create-task': {
      const bus = await FileBus.init(resolveDir(v));
      if (!v.title || !v.agent) return fail('create-task requires --title and --agent');
      const msg = await bus.createTask({
        title: v.title,
        agent: v.agent,
        ...(v.task ? { taskId: v.task } : {}),
        ...(v.desc ? { description: v.desc } : {}),
        ...(v.priority ? { priority: v.priority as 'low' | 'normal' | 'high' } : {}),
        ...(v.tags ? { tags: v.tags.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(v.id ? { id: v.id } : {}),
      });
      out(v, `created task ${msg.taskId} (${msg.title})`, msg);
      return 0;
    }

    case 'tasks': {
      const state = oneOf(v.state, TASK_STATES, '--state');
      const bus = await FileBus.init(resolveDir(v));
      const tasks = await bus.getTasks(state ? { state } : {});
      out(v, renderTasks(tasks), tasks);
      return 0;
    }

    case 'messages': {
      const type = oneOf(v.type, MESSAGE_TYPES, '--type');
      const fromSeq = intFlag(v.from, '--from');
      const limit = intFlag(v.limit, '--limit');
      const bus = await FileBus.init(resolveDir(v));
      const msgs = await bus.getMessages({
        ...(type ? { type } : {}),
        ...(v.task ? { taskId: v.task } : {}),
        ...(fromSeq !== undefined ? { fromSeq } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      out(v, msgs.map(summarize).join('\n') || '(no messages)', msgs);
      return 0;
    }

    case 'claim': {
      const bus = await FileBus.init(resolveDir(v));
      const taskId = positionals[1] ?? v.task;
      if (!taskId || !v.agent) return fail('claim requires <taskId> and --agent');
      const res = await bus.claim(taskId, v.agent, v.id ? { id: v.id } : {});
      if (res.ok) {
        out(v, `claimed ${taskId} as ${v.agent}`, res);
        return 0;
      }
      out(v, `could not claim ${taskId}: ${res.reason}`, res);
      return 1;
    }

    case 'complete':
    case 'block':
    case 'release':
    case 'cancel': {
      const bus = await FileBus.init(resolveDir(v));
      const taskId = positionals[1] ?? v.task;
      if (!taskId || !v.agent) return fail(`${cmd} requires <taskId> and --agent`);
      let msg: Message;
      if (cmd === 'complete') {
        const result = v.result ? parseJsonFlag(v.result, '--result') : undefined;
        msg = await bus.complete(taskId, v.agent, result);
      } else if (cmd === 'block') {
        if (!v.reason) return fail('block requires --reason');
        msg = await bus.block(taskId, v.agent, v.reason);
      } else if (cmd === 'release') {
        msg = await bus.release(taskId, v.agent, v.reason);
      } else {
        msg = await bus.cancel(taskId, v.agent, v.reason);
      }
      out(v, `${cmd} ${taskId} by ${v.agent}`, msg);
      return 0;
    }

    case 'post': {
      const bus = await FileBus.init(resolveDir(v));
      let input: MessageInput;
      if (v.input) {
        input = parseJsonFlag(v.input, '--input') as MessageInput;
      } else {
        if (!v.type || !v.agent) return fail('post requires --type and --agent (or --input <json>)');
        input = {
          type: v.type as MessageType,
          agent: v.agent,
          ...(v.task ? { taskId: v.task } : {}),
          ...(v.text ? { text: v.text } : {}),
          ...(v.title ? { title: v.title } : {}),
          ...(v.reason ? { reason: v.reason } : {}),
          ...(v.id ? { id: v.id } : {}),
        } as MessageInput;
      }
      const msg = await bus.post(input);
      out(v, summarize(msg), msg);
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof BusError) {
      process.stderr.write(`error (${e.code}): ${e.message}\n`);
    } else {
      process.stderr.write(`error: ${(e as Error).message}\n`);
    }
    process.exit(1);
  });
