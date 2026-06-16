/**
 * `HttpBusClient` — a {@link BusTransport} that speaks to a running agent-bus
 * HTTP server (see `server.ts`). It is a real reference client *and* the second
 * transport the conformance suite runs against, so the file and HTTP paths are
 * held to the exact same behaviour.
 *
 * HTTP error bodies are mapped back into the same typed errors the core throws
 * (`ValidationError`, `TransitionError`, …) so callers — and the conformance
 * suite — cannot tell which transport raised them.
 */
import {
  BusError,
  LockTimeoutError,
  NotFoundError,
  TransitionError,
  ValidationError,
  type BusErrorCode,
} from '../core/errors';
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
} from '../core/transport';
import type { Message, MessageInput, TaskCreatedMessage, TaskView } from '../core/types';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpBusClientOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:7777`. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: FetchLike;
}

const BUS_ERROR_CODES: ReadonlySet<string> = new Set([
  'validation',
  'transition',
  'lock_timeout',
  'not_found',
  'bus',
]);

interface ErrorBody {
  error?: string;
  message?: string;
  errors?: string[];
  reason?: TransitionError['reason'];
  taskId?: string;
  from?: TransitionError['from'];
}

export class HttpBusClient implements BusTransport {
  readonly baseUrl: string;
  private readonly doFetch: FetchLike;

  constructor(options: HttpBusClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  // ---- helpers -------------------------------------------------------------

  private url(path: string, query?: Record<string, string | string[] | number | undefined>): string {
    const u = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, item);
        else u.searchParams.append(k, String(v));
      }
    }
    return u.toString();
  }

  /** Read a non-OK response and throw the matching typed error. */
  private async fail(res: Response): Promise<never> {
    let body: ErrorBody = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      // non-JSON body
    }
    const message = body.message ?? `HTTP ${res.status}`;
    switch (body.error) {
      case 'validation':
        throw new ValidationError(message, body.errors ?? []);
      case 'transition':
        throw new TransitionError(body.reason!, body.taskId ?? '', body.from, message);
      case 'not_found':
        throw new NotFoundError(message);
      case 'lock_timeout':
        throw new LockTimeoutError(message);
      default:
        throw new BusError(
          message,
          body.error && BUS_ERROR_CODES.has(body.error) ? (body.error as BusErrorCode) : 'bus',
        );
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.doFetch(this.url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await this.fail(res);
    return (await res.json()) as T;
  }

  private async getJson<T>(path: string, query?: Parameters<HttpBusClient['url']>[1]): Promise<T> {
    const res = await this.doFetch(this.url(path, query));
    if (!res.ok) await this.fail(res);
    return (await res.json()) as T;
  }

  // ---- BusTransport --------------------------------------------------------

  async readMeta(): Promise<BusMeta | undefined> {
    return this.getJson<BusMeta>('/meta');
  }

  async post(input: MessageInput): Promise<Message> {
    return this.postJson<Message>('/messages', input);
  }

  async createTask(input: CreateTaskInput): Promise<TaskCreatedMessage> {
    return this.postJson<TaskCreatedMessage>('/tasks', input);
  }

  async claim(taskId: string, agent: string, opts: ClaimOptions = {}): Promise<ClaimResult> {
    const res = await this.doFetch(this.url(`/tasks/${encodeURIComponent(taskId)}/claim`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, ...opts }),
    });
    // The claim endpoint reports the race outcome as the status (201 won / 409
    // lost) with a ClaimResult body — both are "successful" HTTP exchanges.
    if (res.status === 201 || res.status === 409) {
      return (await res.json()) as ClaimResult;
    }
    return this.fail(res);
  }

  async complete(taskId: string, agent: string, result?: unknown, note?: string): Promise<Message> {
    return this.postJson<Message>(`/tasks/${encodeURIComponent(taskId)}/complete`, { agent, result, note });
  }

  async block(taskId: string, agent: string, reason: string, note?: string): Promise<Message> {
    return this.postJson<Message>(`/tasks/${encodeURIComponent(taskId)}/block`, { agent, reason, note });
  }

  async release(taskId: string, agent: string, reason?: string): Promise<Message> {
    return this.postJson<Message>(`/tasks/${encodeURIComponent(taskId)}/release`, { agent, reason });
  }

  async cancel(taskId: string, agent: string, reason?: string): Promise<Message> {
    return this.postJson<Message>(`/tasks/${encodeURIComponent(taskId)}/cancel`, { agent, reason });
  }

  async getMessages(filter: MessageFilter = {}): Promise<Message[]> {
    return this.getJson<Message[]>('/messages', {
      fromSeq: filter.fromSeq,
      type: filter.type,
      taskId: filter.taskId,
      agent: filter.agent,
      limit: filter.limit,
    });
  }

  async getTasks(filter: TaskFilter = {}): Promise<TaskView[]> {
    return this.getJson<TaskView[]>('/tasks', { state: filter.state });
  }

  async getTask(taskId: string): Promise<TaskView | undefined> {
    const res = await this.doFetch(this.url(`/tasks/${encodeURIComponent(taskId)}`));
    if (res.status === 404) return undefined;
    if (!res.ok) await this.fail(res);
    return (await res.json()) as TaskView;
  }

  subscribe(
    handler: (msg: Message) => void | Promise<void>,
    options: SubscribeOptions = {},
  ): Subscription {
    const controller = new AbortController();
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      controller.abort();
    };
    options.signal?.addEventListener('abort', close, { once: true });

    const fromSeq = options.fromSeq ?? 0;
    void this.streamSse(fromSeq, handler, controller.signal, () => closed);
    return { close };
  }

  /**
   * Consume the SSE stream and deliver in `seq` order, **reconnecting from the
   * cursor** on a dropped stream, a network error, or a handler that throws —
   * so delivery is at-least-once (PROTOCOL.md §6 G5), matching the file
   * transport. The cursor advances only after a handler resolves; a throw leaves
   * it put, and the next connection replays that message. Persistent connect
   * failures (e.g. a bad `fromSeq`) give up after a few tries rather than
   * hot-looping.
   */
  private async streamSse(
    fromSeq: number,
    handler: (msg: Message) => void | Promise<void>,
    signal: AbortSignal,
    isClosed: () => boolean,
  ): Promise<void> {
    let cursor = fromSeq;
    let hardFailures = 0;
    const RECONNECT_MS = 100;
    const MAX_HARD_FAILURES = 5;

    while (!isClosed()) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const res = await this.doFetch(this.url('/subscribe', { fromSeq: cursor }), {
          headers: { accept: 'text/event-stream' },
          signal,
        });
        if (!res.ok || !res.body) {
          if (++hardFailures >= MAX_HARD_FAILURES) return; // persistent error — stop
          await this.sleep(RECONNECT_MS);
          continue;
        }
        hardFailures = 0;
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        readLoop: for (;;) {
          if (isClosed()) return;
          const { value, done } = await reader.read();
          if (done) break; // server closed the stream → reconnect from cursor
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            let obj: unknown;
            try {
              obj = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            const seq = (obj as { seq?: unknown }).seq;
            if (typeof seq !== 'number' || seq <= cursor) continue; // ready frame / replay
            try {
              await handler(obj as Message);
              cursor = seq;
            } catch {
              // Handler failed: leave the cursor put and reconnect so the server
              // replays this message — at-least-once, like the file transport.
              break readLoop;
            }
          }
        }
        await reader.cancel().catch(() => {});
        reader = undefined;
        if (isClosed()) return;
        await this.sleep(RECONNECT_MS);
      } catch {
        // Aborted (close) or a transient network error.
        if (reader) await reader.cancel().catch(() => {});
        if (isClosed()) return;
        await this.sleep(RECONNECT_MS);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
