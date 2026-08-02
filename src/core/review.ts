import { randomUUID } from 'node:crypto';
import type { EditPlan, MediaInfo, Proposal, ReviewOperation } from '../shared/types.js';
import { validateEditPlan } from './validators.js';

export function applyOperations(plan: EditPlan, operations: ReviewOperation[], media: MediaInfo): EditPlan {
  const next = structuredClone(plan);
  for (const operation of operations) {
    switch (operation.type) {
      case 'remove-segment':
        next.segments = next.segments.filter(segment => segment.id !== operation.segmentId);
        next.subtitles = next.subtitles.filter(cue => cue.segmentId !== operation.segmentId);
        break;
      case 'update-trim': {
        const segment = next.segments.find(item => item.id === operation.segmentId);
        if (!segment) throw new Error(`Segment ${operation.segmentId} does not exist.`);
        segment.sourceStart = operation.sourceStart;
        segment.sourceEnd = operation.sourceEnd;
        next.subtitles = next.subtitles.filter(cue => cue.segmentId !== segment.id || (cue.sourceStart >= segment.sourceStart && cue.sourceEnd <= segment.sourceEnd));
        break;
      }
      case 'update-subtitle': {
        const subtitle = next.subtitles.find(item => item.id === operation.subtitleId);
        if (!subtitle) throw new Error(`Subtitle ${operation.subtitleId} does not exist.`);
        subtitle.english = operation.english.trim();
        subtitle.vietnamese = operation.vietnamese.trim();
        break;
      }
      case 'update-motion': {
        const segment = next.segments.find(item => item.id === operation.segmentId);
        if (!segment) throw new Error(`Segment ${operation.segmentId} does not exist.`);
        segment.motion = operation.motion;
        break;
      }
      case 'set-voice-cleanup': next.voiceCleanup = operation.enabled; break;
    }
  }
  next.revision += 1;
  next.targetDuration = next.segments.reduce((sum, segment) => sum + segment.sourceEnd - segment.sourceStart, 0);
  validateEditPlan(next, media);
  return next;
}

export function proposal(plan: EditPlan, operations: ReviewOperation[], summary: string): Proposal {
  return { id: randomUUID(), createdAt: new Date().toISOString(), summary, plan, operations };
}

