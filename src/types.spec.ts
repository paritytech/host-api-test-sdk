import { describe, expect, it } from 'vitest';
import { decideResource, parseResourceAllocationBehavior } from './types.js';

const auto = { tag: 'AutoSigning', productId: 'p.dot' } as const;
const statements = { tag: 'StatementStoreAllowance', productId: 'p.dot' } as const;

describe('decideResource', () => {
  it('allocates everything under the default mode', () => {
    expect(decideResource('approve-all', auto)).toBe(true);
    expect(decideResource('approve-all', statements)).toBe(true);
  });

  it('refuses everything under reject-all', () => {
    expect(decideResource('reject-all', auto)).toBe(false);
    expect(decideResource('reject-all', statements)).toBe(false);
  });

  // The common case: withhold auto-signing so signing stays observable, while
  // leaving the allowances a product needs to function.
  it('grants what a record does not mention', () => {
    const behavior = { AutoSigning: false } as const;
    expect(decideResource(behavior, auto)).toBe(false);
    expect(decideResource(behavior, statements)).toBe(true);
  });

  it('honours an explicit true in a record', () => {
    expect(decideResource({ AutoSigning: true }, auto)).toBe(true);
  });

  it('asks the function form, which sees the resource and the product', () => {
    const seen: string[] = [];
    const behavior = (resource: { tag: string; productId: string }) => {
      seen.push(`${resource.productId}:${resource.tag}`);
      return resource.tag !== 'AutoSigning';
    };
    expect(decideResource(behavior, auto)).toBe(false);
    expect(decideResource(behavior, statements)).toBe(true);
    expect(seen).toEqual(['p.dot:AutoSigning', 'p.dot:StatementStoreAllowance']);
  });
});

describe('parseResourceAllocationBehavior', () => {
  it('passes the two named modes through', () => {
    expect(parseResourceAllocationBehavior('approve-all')).toBe('approve-all');
    expect(parseResourceAllocationBehavior('reject-all')).toBe('reject-all');
  });

  it('accepts a record of known resources', () => {
    expect(parseResourceAllocationBehavior({ AutoSigning: false })).toEqual({ AutoSigning: false });
  });

  // A misspelling would silently grant the resource it meant to withhold, which
  // is the exact bug the option exists to prevent.
  it('throws on an unknown resource, naming it', () => {
    expect(() => parseResourceAllocationBehavior({ AutoSignin: false })).toThrow(
      'invalid resourceAllocation resource: "AutoSignin"',
    );
  });

  it('throws on a non-boolean verdict', () => {
    expect(() => parseResourceAllocationBehavior({ AutoSigning: 'no' })).toThrow(
      'resourceAllocation."AutoSigning" must be a boolean',
    );
  });

  it('throws on a mode it does not know', () => {
    expect(() => parseResourceAllocationBehavior('approve-once')).toThrow(
      'invalid resourceAllocation behavior',
    );
    expect(() => parseResourceAllocationBehavior(null)).toThrow(
      'invalid resourceAllocation behavior',
    );
  });
});
