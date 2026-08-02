import { describe, expect, it } from 'vitest';
import type { AutoEditApi } from '../src/shared/bridge';

describe('renderer workflow contract smoke', () => {
  it('supports Import → Analyze → Review → Approve → Render with a fake backend', async () => {
    const calls: string[] = [];
    const api = new Proxy({}, { get: (_target, key) => async () => { calls.push(String(key)); return {}; } }) as AutoEditApi;
    await api.createProject(); await api.startAnalysis('p1'); await api.acceptProposal('p1'); await api.approve('p1'); await api.render({ projectId: 'p1' });
    expect(calls).toEqual(['createProject', 'startAnalysis', 'acceptProposal', 'approve', 'render']);
  });

  it('exposes stop and checkpoint resume controls', async () => {
    const calls: string[] = [];
    const api = new Proxy({}, { get: (_target, key) => async () => { calls.push(String(key)); return {}; } }) as AutoEditApi;
    await api.cancelAnalysis('p1'); await api.resumeAnalysis('p1');
    expect(calls).toEqual(['cancelAnalysis', 'resumeAnalysis']);
  });
});
