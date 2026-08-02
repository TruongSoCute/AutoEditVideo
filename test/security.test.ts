import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/core/project-store';
import type { ProjectDocument } from '../src/shared/types';
import { media, plan } from './fixtures';

describe('renderer boundary', () => {
  it('removes source, cache, output, FFmpeg and font paths from public project data', () => {
    const timestamp = new Date().toISOString();
    const project: ProjectDocument = {
      schemaVersion: 1, id: '123e4567-e89b-42d3-a456-426614174000', name: 'Test', createdAt: timestamp, updatedAt: timestamp,
      source: { path: 'C:\\secret\\source.mov', displayName: 'source.mov', fingerprint: 'abc', size: 42, modifiedAt: 1, missing: false }, media,
      settings: { model: 'gpt-5.6-sol', reasoning: 'medium', ffmpegPath: 'C:\\tools\\ffmpeg.exe', ffprobePath: 'C:\\tools\\ffprobe.exe', satoshiFontPath: 'C:\\fonts\\Satoshi.ttf' },
      stages: Object.fromEntries(['import', 'proxy', 'asr', 'editorial', 'subtitle', 'review', 'final', 'render'].map(stage => [stage, { state: 'idle', updatedAt: timestamp }])) as ProjectDocument['stages'],
      transcript: [], acceptedPlan: plan, proxyPath: 'C:\\cache\\proxy.mp4', outputPath: 'C:\\exports\\final.mp4',
    };
    const publicData = new ProjectStore('C:\\user-data').public(project);
    const serialized = JSON.stringify(publicData);
    expect(serialized).not.toContain('C:\\'); expect(publicData.outputAvailable).toBe(true); expect(publicData.proxyUrl).toBe(`media://project/${project.id}/proxy`);
  });
});
