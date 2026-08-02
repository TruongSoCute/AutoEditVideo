import { describe, expect, it } from 'vitest';
import { classifyCodexError } from '../src/core/codex';
import { buildFilterGraph, createAss, mapSourceToOutput } from '../src/core/render';
import { media, plan } from './fixtures';

describe('Codex boundary', () => {
  it('classifies authentication, model and malformed JSON failures', () => {
    expect(classifyCodexError('HTTP 401 unauthorized login')).toMatch(/sign/i);
    expect(classifyCodexError('selected model not found')).toMatch(/unavailable/i);
    expect(classifyCodexError('output JSON schema mismatch')).toMatch(/schema/i);
  });
  it('redacts filesystem paths from diagnostics', () => { expect(classifyCodexError('failed C:\\Users\\person\\secret.txt')).not.toContain('secret.txt'); });
});

describe('render planning', () => {
  it('maps source subtitle time into the concatenated output timeline', () => {
    expect(mapSourceToOutput(plan, 3)).toBe(1); expect(mapSourceToOutput(plan, 52)).toBe(37); expect(mapSourceToOutput(plan, 44)).toBeUndefined();
  });
  it('creates bilingual ASS styles in the safe lower-middle region', () => {
    const ass = createAss(plan); expect(ass).toContain('Satoshi'); expect(ass).toContain('Be Vietnam Pro SemiBold'); expect(ass).toContain('Một ý tưởng rõ ràng');
  });
  it('creates chronological trim/concat, tone-map and cleanup filters', () => {
    const graph = buildFilterGraph(plan, media, 'C:\\tmp\\subtitles.ass', 'C:\\tmp\\fonts');
    expect(graph).toContain('trim=start=2:end=37'); expect(graph).toContain('concat=n=2:v=1:a=1'); expect(graph).toContain('tonemap'); expect(graph).toContain('loudnorm'); expect(graph).toContain('subtitles=');
  });
});
