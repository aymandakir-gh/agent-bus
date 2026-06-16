/**
 * Runtime validation. The reference bus validates against the exact JSON Schema
 * it publishes (`schemas.ts`), so the implementation can never drift from the
 * contract.
 */
// Deep import needs the explicit .js extension to resolve under Node ESM once
// bundled (ajv ships no "exports" map).
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { messageSchema, messageInputSchema } from './schemas';
import { ValidationError } from './errors';
import type { Message, MessageInput } from './types';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validateStoredFn: ValidateFunction = ajv.compile(messageSchema);
const validateInputFn: ValidateFunction = ajv.compile(messageInputSchema);

function formatErrors(fn: ValidateFunction): string[] {
  return (fn.errors ?? []).map((e) => {
    const path = e.instancePath || '(root)';
    return `${path} ${e.message ?? 'is invalid'}`.trim();
  });
}

/** Does `x` satisfy the stored-message schema? */
export function isValidMessage(x: unknown): x is Message {
  return validateStoredFn(x) as boolean;
}

/** Validate a stored message; returns the typed message or a list of errors. */
export function validateMessage(
  x: unknown,
): { ok: true; value: Message } | { ok: false; errors: string[] } {
  if (validateStoredFn(x)) return { ok: true, value: x as Message };
  return { ok: false, errors: formatErrors(validateStoredFn) };
}

/** Does `x` satisfy the post-payload schema? */
export function isValidInput(x: unknown): x is MessageInput {
  return validateInputFn(x) as boolean;
}

/** Validate a post payload; throws {@link ValidationError} on failure. */
export function assertValidInput(x: unknown): asserts x is MessageInput {
  if (!validateInputFn(x)) {
    throw new ValidationError(
      'message input failed schema validation',
      formatErrors(validateInputFn),
    );
  }
}

/** Validate a stored message; throws {@link ValidationError} on failure. */
export function assertValidMessage(x: unknown): asserts x is Message {
  if (!validateStoredFn(x)) {
    throw new ValidationError(
      'message failed schema validation',
      formatErrors(validateStoredFn),
    );
  }
}
