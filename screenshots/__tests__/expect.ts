import assert from 'node:assert/strict';

// The few matchers these tests use, over node:assert, so the tool needs no test runner.
export function expect(actual: unknown) {
  const matchers = {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toContain: (expected: string) => assert.ok(String(actual).includes(expected), `expected to contain ${expected}`),
  };
  return {
    ...matchers,
    not: {
      toContain: (expected: string) => assert.ok(!String(actual).includes(expected), `expected not to contain ${expected}`),
    },
  };
}
