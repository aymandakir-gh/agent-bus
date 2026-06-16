/**
 * File transport: a bus is a directory containing an append-only `log.jsonl`,
 * a `lock` file, and `meta.json`. All mutations run under the exclusive lock
 * (PROTOCOL.md §7), giving gapless `seq` (total order) and single-winner claims
 * across uncoordinated OS processes. Reads are lock-free and skip any in-flight
 * partial trailing line.
 *
 * The bus only ever touches files inside its own directory.
 */
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { PROTOCOL_ID, SPEC_VERSION } from '../version';
import { acquireLock, type LockOptions } from './lock';
import { classifyTransition, reduce } from './fsm';
import { newId } from './ids';
import { assertValidInput, assertValidMessage } from './validate';
import { BusError, TransitionError } from './errors';
import type {
  Message,
  MessageInput,
  TaskClaimedMessage,
  TaskCreatedMessage,
  TaskView,
} from './types';
import type {
  BusMeta,
  BusTransport,
  ClaimOptions,
  ClaimResult,
  CreateTaskInput,
  MessageFilter,
  SubscribeOptions,
  Subscription,
  TaskFilter,
} from './transport';

// Re-exported so existing importers (and `index.ts`) keep their paths; the
// canonical home of these contract types is now `transport.ts`.
export type {
  BusMeta,
  ClaimResult,
  MessageFilter,
  TaskFilter,
  SubscribeOptions,
  Subscription,
} from './transport';

const LOG_FILE = 'log.jsonl';
const LOCK_FILE = 'lock';
const META_FILE = 'meta.json';
const NEWLINE = 0x0a;

export interface FileBusOptions {
  /** The bus directory. The bus reads and writes only inside it. */
  dir: string;
  lock?: LockOptions;
  /** Default poll interval for subscriptions (ms). */
  pollIntervalMs?: number;
  /**
   * Test-only: sleep up to this many ms inside the critical section (after
   * reading state, before appending) to widen race windows. Defaults to the
   * `AGENT_BUS_CHAOS` env var.
   */
  criticalSectionDelayMs?: number;
}

interface BusState {
  messages: Message[];
  tasks: Map<string, TaskView>;
  ids: Set<string>;
  lastSeq: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function taskIdOf(msg: Message): string | undefined {
  return msg.type.startsWith('task.')
    ? (msg as { taskId: string }).taskId
    : undefined;
}

export class FileBus implements BusTransport {
  readonly dir: string;
  readonly logPath: string;
  readonly lockPath: string;
  readonly metaPath: string;
  private readonly lockOptions: LockOptions | undefined;
  private readonly pollIntervalMs: number;
  private readonly chaosMs: number;

  constructor(options: FileBusOptions) {
    this.dir = options.dir;
    this.logPath = join(this.dir, LOG_FILE);
    this.lockPath = join(this.dir, LOCK_FILE);
    this.metaPath = join(this.dir, META_FILE);
    this.lockOptions = options.lock;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    const envChaos = Number.parseInt(process.env.AGENT_BUS_CHAOS ?? '', 10);
    this.chaosMs = options.criticalSectionDelayMs ?? (Number.isFinite(envChaos) ? envChaos : 0);
  }

  /** Initialize a bus directory (idempotent — never overwrites existing data). */
  static async init(dir: string, options?: Omit<FileBusOptions, 'dir'>): Promise<FileBus> {
    await mkdir(dir, { recursive: true });
    const bus = new FileBus({ dir, ...options });
    // Create an empty log only if absent.
    try {
      const fh = await open(bus.logPath, 'wx');
      await fh.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const meta: BusMeta = {
      protocol: PROTOCOL_ID,
      version: SPEC_VERSION,
      created: new Date().toISOString(),
    };
    try {
      await writeFile(bus.metaPath, JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    return bus;
  }

  async readMeta(): Promise<BusMeta | undefined> {
    try {
      return JSON.parse(await readFile(this.metaPath, 'utf8')) as BusMeta;
    } catch {
      return undefined;
    }
  }

  // ---- writes (under lock) -------------------------------------------------

  /** Append any message. Validates the payload, enforces idempotency and the
   *  task FSM, assigns `id`/`seq`/`ts`, and appends one line — atomically. */
  async post(input: MessageInput): Promise<Message> {
    assertValidInput(input);
    const maxAttempts = 50;
    for (let attempt = 1; ; attempt++) {
      const handle = await acquireLock(this.lockPath, this.lockOptions);
      try {
        const state = await this.readState();

        // Idempotency: a re-posted id is a no-op returning the existing record.
        // Records in our snapshot were committed before we acquired the lock, so
        // returning one is safe regardless of any ownership race below.
        if (input.id && state.ids.has(input.id)) {
          const existing = state.messages.find((m) => m.id === input.id);
          if (existing) return existing;
        }

        const msg = this.materialize(input, state.lastSeq + 1);
        assertValidMessage(msg);

        const taskId = taskIdOf(msg);
        const current = taskId !== undefined ? state.tasks.get(taskId) : undefined;
        const result = classifyTransition(current, msg);

        if (this.chaosMs > 0) await sleep(Math.floor(Math.random() * this.chaosMs));

        // Confirm we held the lock continuously from readState() to here. A lost
        // token means we were stolen (judged dead, or a cross-host steal), so our
        // snapshot — and thus seq and the FSM decision — may be stale. Discard and
        // retry under a fresh lock rather than commit a duplicate seq / double-claim.
        if (!(await handle.isOwned())) {
          if (attempt >= maxAttempts) {
            throw new BusError('lost the write lock repeatedly while posting', 'bus');
          }
          continue;
        }

        if (!result.ok) {
          throw new TransitionError(result.reason, taskId ?? '', result.from);
        }

        await this.appendLine(JSON.stringify(msg));
        return msg;
      } finally {
        await handle.release();
      }
    }
  }

  /** Atomically attempt to claim a task. Returns a result (never throws on a
   *  lost race). For at-least-once safety, pass a stable `id`. */
  async claim(taskId: string, agent: string, opts: ClaimOptions = {}): Promise<ClaimResult> {
    try {
      const msg = await this.post({
        type: 'task.claimed',
        agent,
        taskId,
        ...(opts.note !== undefined ? { note: opts.note } : {}),
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
      });
      return { ok: true, message: msg as TaskClaimedMessage };
    } catch (e) {
      if (e instanceof TransitionError) {
        return { ok: false, reason: e.reason, from: e.from };
      }
      throw e;
    }
  }

  async createTask(input: CreateTaskInput): Promise<TaskCreatedMessage> {
    const taskId = input.taskId ?? newId('task');
    const msg = await this.post({
      type: 'task.created',
      agent: input.agent,
      taskId,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    });
    return msg as TaskCreatedMessage;
  }

  async complete(taskId: string, agent: string, result?: unknown, note?: string): Promise<Message> {
    return this.post({
      type: 'task.completed',
      agent,
      taskId,
      ...(result !== undefined ? { result } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  }

  async block(taskId: string, agent: string, reason: string, note?: string): Promise<Message> {
    return this.post({
      type: 'task.blocked',
      agent,
      taskId,
      reason,
      ...(note !== undefined ? { note } : {}),
    });
  }

  async release(taskId: string, agent: string, reason?: string): Promise<Message> {
    return this.post({
      type: 'task.released',
      agent,
      taskId,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async cancel(taskId: string, agent: string, reason?: string): Promise<Message> {
    return this.post({
      type: 'task.cancelled',
      agent,
      taskId,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  // ---- reads (lock-free) ---------------------------------------------------

  async getMessages(filter: MessageFilter = {}): Promise<Message[]> {
    const { messages } = await this.readState();
    const types = filter.type
      ? new Set(Array.isArray(filter.type) ? filter.type : [filter.type])
      : undefined;
    let out = messages.filter((m) => {
      if (filter.fromSeq !== undefined && m.seq <= filter.fromSeq) return false;
      if (types && !types.has(m.type)) return false;
      if (filter.agent !== undefined && m.agent !== filter.agent) return false;
      // Match the `taskId` field on any message that carries it — including
      // status.update / request.help that *reference* a task without driving it.
      if (filter.taskId !== undefined && (m as { taskId?: string }).taskId !== filter.taskId)
        return false;
      return true;
    });
    if (filter.limit !== undefined && out.length > filter.limit) {
      out = out.slice(out.length - filter.limit);
    }
    return out;
  }

  async getTasks(filter: TaskFilter = {}): Promise<TaskView[]> {
    const { tasks } = await this.readState();
    const states = filter.state
      ? new Set(Array.isArray(filter.state) ? filter.state : [filter.state])
      : undefined;
    const out = [...tasks.values()].filter((t) => !states || states.has(t.state));
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  async getTask(taskId: string): Promise<TaskView | undefined> {
    const { tasks } = await this.readState();
    return tasks.get(taskId);
  }

  // ---- subscriptions -------------------------------------------------------

  /** Deliver every message with `seq` > `fromSeq`, in order, at least once.
   *  Polls the log (and nudges on `fs.watch` where available). */
  subscribe(
    handler: (msg: Message) => void | Promise<void>,
    options: SubscribeOptions = {},
  ): Subscription {
    let cursor = options.fromSeq ?? 0;
    let closed = false;
    let running = false;
    const interval = options.intervalMs ?? this.pollIntervalMs;

    const tick = async (): Promise<void> => {
      if (closed || running) return;
      running = true;
      try {
        const { messages } = await this.readState();
        for (const m of messages) {
          if (closed) break;
          if (m.seq > cursor) {
            // Advance the cursor only after the handler succeeds, so a throwing
            // handler is retried on the next tick (at-least-once delivery, G5).
            await handler(m);
            cursor = m.seq;
          }
        }
      } catch {
        // transient read error; next tick retries
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), interval);
    timer.unref?.();

    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(this.logPath, () => void tick());
      watcher.unref?.();
    } catch {
      // watch unsupported here; polling still covers it.
    }

    void tick();

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      watcher?.close();
    };
    options.signal?.addEventListener('abort', close, { once: true });
    return { close };
  }

  async close(): Promise<void> {
    // No long-lived handles; method exists for API symmetry and future use.
  }

  // ---- internals -----------------------------------------------------------

  private materialize(input: MessageInput, seq: number): Message {
    const { id, ...rest } = input as MessageInput & { id?: string };
    return {
      id: id ?? newId('msg'),
      seq,
      ts: new Date().toISOString(),
      ...rest,
    } as Message;
  }

  /** Full read of the log → parsed, ordered messages + derived state. Skips
   *  blank/corrupt/partial lines defensively. O(n) per call (see roadmap). */
  private async readState(): Promise<BusState> {
    let text = '';
    try {
      text = await readFile(this.logPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const messages: Message[] = [];
    const ids = new Set<string>();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // partial or corrupt line; ignore
      }
      if (!isStoredShape(obj)) continue;
      messages.push(obj);
      ids.add(obj.id);
    }
    messages.sort((a, b) => a.seq - b.seq);
    const tasks = reduce(messages);
    const lastSeq = messages.length ? (messages[messages.length - 1] as Message).seq : 0;
    return { messages, tasks, ids, lastSeq };
  }

  /** Append one line, first repairing a crashed partial line if present. */
  private async appendLine(line: string): Promise<void> {
    await this.ensureTrailingNewline();
    await appendFile(this.logPath, line + '\n', 'utf8');
  }

  private async ensureTrailingNewline(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.logPath)).size;
    } catch {
      return; // missing log; appendFile will create it
    }
    if (size === 0) return;
    const fh = await open(this.logPath, 'r');
    try {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      if (buf[0] !== NEWLINE) {
        // Previous writer crashed mid-line; terminate it so it parses as one
        // (invalid, skipped) line instead of merging with our append.
        await appendFile(this.logPath, '\n', 'utf8');
      }
    } finally {
      await fh.close();
    }
  }
}

/** Cheap structural check used on the hot read path (full schema validation
 *  happens on write). */
function isStoredShape(x: unknown): x is Message {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.seq === 'number' &&
    typeof m.ts === 'string' &&
    typeof m.type === 'string' &&
    typeof m.agent === 'string'
  );
}
