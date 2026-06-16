/**
 * agent-bus — a message bus + task board for teams of agents.
 *
 * Public entry point. The wire contract lives in `PROTOCOL.md`; the canonical
 * JSON Schemas in `schemas/`. This module re-exports the reference
 * implementation: message model, task FSM, the file transport, and helpers.
 */

/** Wire-protocol identifier. Bumped to `agent-bus/1` on a breaking change. */
export const PROTOCOL_ID = 'agent-bus/0' as const;

/** Spec version (semver of the protocol document). */
export const SPEC_VERSION = '0.1.0' as const;
