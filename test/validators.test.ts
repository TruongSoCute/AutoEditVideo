import { describe, expect, it } from 'vitest';
import { planDuration, validateEditPlan, ValidationError } from '../src/core/validators';
import { applyOperations } from '../src/core/review';
import { media, plan } from './fixtures';

describe('edit plan validation', () => {
  it('accepts a chronological edit and computes duration', () => { expect(() => validateEditPlan(plan, media)).not.toThrow(); expect(planDuration(plan)).toBe(70); });
  it('rejects overlap and a duration over 120 seconds', () => {
    const overlap = structuredClone(plan); overlap.segments[1].sourceStart = 30;
    expect(() => validateEditPlan(overlap, media)).toThrow(ValidationError);
    const long = structuredClone(plan); long.segments[1].sourceEnd = 180;
    expect(() => validateEditPlan(long, media)).toThrow(/120/);
  });
  it('stages typed operations without mutating the accepted plan', () => {
    const next = applyOperations(plan, [{ type: 'update-motion', segmentId: 's2', motion: 'slow-zoom' }, { type: 'set-voice-cleanup', enabled: false }], media);
    expect(next.revision).toBe(2); expect(next.segments[1].motion).toBe('slow-zoom'); expect(next.voiceCleanup).toBe(false);
    expect(plan.segments[1].motion).toBe('none'); expect(plan.voiceCleanup).toBe(true);
  });
  it('validates the whole plan after a trim', () => {
    expect(() => applyOperations(plan, [{ type: 'update-trim', segmentId: 's2', sourceStart: 30, sourceEnd: 60 }], media)).toThrow(/chronological/);
  });
});
