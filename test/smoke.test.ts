import { describe, it, expect } from 'vitest';
import { PROTOCOL_ID, SPEC_VERSION } from '../src/index';

describe('package smoke', () => {
  it('exposes protocol identity', () => {
    expect(PROTOCOL_ID).toBe('agent-bus/0');
    expect(SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
