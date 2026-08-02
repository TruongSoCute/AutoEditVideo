import { describe, expect, it } from 'vitest';
import { parseByteRange, RangeNotSatisfiableError } from '../src/core/byte-range';

describe('media byte ranges', () => {
  it('parses open, bounded and suffix ranges', () => {
    expect(parseByteRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999, length: 900 });
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199, length: 100 });
    expect(parseByteRange('bytes=-250', 1000)).toEqual({ start: 750, end: 999, length: 250 });
  });

  it('returns null for a normal full request and clamps its end', () => {
    expect(parseByteRange(null, 1000)).toBeNull();
    expect(parseByteRange('bytes=900-2000', 1000)).toEqual({ start: 900, end: 999, length: 100 });
  });

  it('rejects multi-range and out-of-bounds requests', () => {
    expect(() => parseByteRange('bytes=0-1,4-5', 1000)).toThrow(RangeNotSatisfiableError);
    expect(() => parseByteRange('bytes=1000-', 1000)).toThrow(RangeNotSatisfiableError);
    expect(() => parseByteRange('bytes=300-200', 1000)).toThrow(RangeNotSatisfiableError);
  });
});

