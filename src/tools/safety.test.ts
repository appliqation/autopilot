import { describe, it, expect } from 'vitest';
import { READONLY_CONTEXT_TOOLS } from './safety.js';

describe('READONLY_CONTEXT_TOOLS', () => {
  it('includes get_test_set — the seed message and system prompt both instruct the model to call it for test-set scope, so it must actually be reachable', () => {
    expect(READONLY_CONTEXT_TOOLS.has('get_test_set')).toBe(true);
  });

  it('includes get_scenario for the same reason — used in both single-TC and scenario/test-set scope', () => {
    expect(READONLY_CONTEXT_TOOLS.has('get_scenario')).toBe(true);
  });

  it('has zero write tools — this agent never calls an appq write tool directly', () => {
    const writeToolNamePattern = /^(create_|update_|add_|remove_|delete_|submit_)/;
    for (const tool of READONLY_CONTEXT_TOOLS) {
      expect(tool).not.toMatch(writeToolNamePattern);
    }
  });
});
