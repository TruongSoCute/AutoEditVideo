import type { EditPlan, MediaInfo } from '../src/shared/types';

export const media: MediaInfo = { duration: 180, width: 3840, height: 2160, fps: 30, videoCodec: 'hevc', audioCodec: 'aac', hasAudio: true, rotation: 90, hdr: true, dolbyVision: true };
export const plan: EditPlan = {
  revision: 1, targetDuration: 70, voiceCleanup: true,
  exportPreset: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', crf: 18 },
  segments: [
    { id: 's1', sourceStart: 2, sourceEnd: 37, transcriptCueIds: ['c1'], hook: 'Hook', rationale: 'Strong open', framingOffset: 0, motion: 'punch-in' },
    { id: 's2', sourceStart: 50, sourceEnd: 85, transcriptCueIds: ['c2'], rationale: 'Payoff', framingOffset: 0, motion: 'none' },
  ],
  subtitles: [{ id: 'sub1', segmentId: 's1', sourceStart: 3, sourceEnd: 6, english: 'A clear idea', vietnamese: 'Một ý tưởng rõ ràng' }],
};
