/**
 * The transport contract. A `BusTransport` is anything that speaks the
 * `agent-bus/0` protocol — the file transport ({@link FileBus}), the HTTP client
 * ({@link HttpBusClient}), or any future implementation in any language.
 *
 * This interface is what the transport-conformance suite (`test/conformance/`)
 * is written against: every transport must pass the *same* suite, so behaviour
 * cannot drift between them. The shared option/result types live here (not in
 * any one implementation) so the contract owns its own vocabulary.
 */
import type { TransitionReason } from './errors';
import type {
  Message,
  MessageInput,
  MessageType,
  Priority,
  TaskClaimedMessage,
  TaskCreatedMessage,
  TaskState,
  TaskView,
} from './types';

export interface BusMeta {
  protocol: string;
  version: string;
  created?: string;
}

export type ClaimResult =
  | { ok: true; message: TaskClaimedMessage }
  | { ok: false; reason: TransitionReason; from: TaskState | undefined };

export interface MessageFilter {
  /** Only messages with `seq` strictly greater than this. */
  fromSeq?: number;
  type?: MessageType | MessageType[];
  taskId?: string;
  agent?: string;
  /** Return at most this many (after other filters), keeping the latest. */
  limit?: number;
}

export interface TaskFilter {
  state?: TaskState | TaskState[];
}

export interface SubscribeOptions {
  /** Start after this `seq` (default 0 = from the beginning). */
  fromSeq?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface Subscription {
  close(): void;
}

export interface CreateTaskInput {
  title: string;
  agent: string;
  taskId?: string;
  description?: string;
  priority?: Priority;
  tags?: string[];
  id?: string;
  meta?: Record<string, unknown>;
}

export interface ClaimOptions {
  note?: string;
  id?: string;
  meta?: Record<string, unknown>;
}

/**
 * Everything a conformant `agent-bus/0` transport exposes. Reads are lock-free
 * and totally-ordered by `seq`; writes are atomic and single-claimer (the
 * guarantees in PROTOCOL.md §6 are upheld by each transport's own machinery).
 */
export interface BusTransport {
  /** Bus identity: protocol id + spec version (+ creation time where known). */
  readMeta(): Promise<BusMeta | undefined>;

  /** Append any message; assigns `id`/`seq`/`ts`, enforces schema + FSM. */
  post(input: MessageInput): Promise<Message>;

  createTask(input: CreateTaskInput): Promise<TaskCreatedMessage>;
  /** Attempt to claim a task; never throws on a lost race (returns a result). */
  claim(taskId: string, agent: string, opts?: ClaimOptions): Promise<ClaimResult>;
  complete(taskId: string, agent: string, result?: unknown, note?: string): Promise<Message>;
  block(taskId: string, agent: string, reason: string, note?: string): Promise<Message>;
  release(taskId: string, agent: string, reason?: string): Promise<Message>;
  cancel(taskId: string, agent: string, reason?: string): Promise<Message>;

  getMessages(filter?: MessageFilter): Promise<Message[]>;
  getTasks(filter?: TaskFilter): Promise<TaskView[]>;
  getTask(taskId: string): Promise<TaskView | undefined>;

  /** Deliver every message with `seq` > `fromSeq`, in order, at least once. */
  subscribe(handler: (msg: Message) => void | Promise<void>, options?: SubscribeOptions): Subscription;
}
