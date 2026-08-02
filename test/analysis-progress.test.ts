import { describe, expect, it } from 'vitest';
import { analysisOverallProgress } from '../src/core/analysis';

describe('analysis progress', () => {
  it('maps stage progress into a monotonic weighted overall estimate', () => {
    expect(analysisOverallProgress('proxy', 0)).toBe(0);
    expect(analysisOverallProgress('proxy', 1)).toBeCloseTo(0.34);
    expect(analysisOverallProgress('asr', 1)).toBeCloseTo(0.6);
    expect(analysisOverallProgress('editorial', 1)).toBeCloseTo(0.84);
    expect(analysisOverallProgress('subtitle', 1)).toBe(1);
  });

  it('bounds invalid stage ratios before mapping', () => {
    expect(analysisOverallProgress('proxy', -1)).toBe(0);
    expect(analysisOverallProgress('subtitle', 2)).toBe(1);
  });
});
