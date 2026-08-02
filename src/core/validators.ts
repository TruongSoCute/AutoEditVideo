import type { EditPlan, MediaInfo, TranscriptCue } from '../shared/types.js';

export class ValidationError extends Error {}

export function planDuration(plan: EditPlan): number {
  return plan.segments.reduce((sum, segment) => sum + segment.sourceEnd - segment.sourceStart, 0);
}

export function validateTranscript(cues: TranscriptCue[], sourceDuration: number): void {
  let previousEnd = 0;
  for (const cue of cues) {
    if (!cue.id || cue.start < 0 || cue.end <= cue.start || cue.end > sourceDuration + 0.05) {
      throw new ValidationError(`Invalid transcript cue ${cue.id || '<missing>'}.`);
    }
    if (cue.start < previousEnd - 0.05) throw new ValidationError(`Transcript cues overlap at ${cue.id}.`);
    previousEnd = cue.end;
  }
}

export function validateEditPlan(plan: EditPlan, media: MediaInfo): void {
  if (!Number.isInteger(plan.revision) || plan.revision < 1) throw new ValidationError('Revision must be positive.');
  if (!plan.segments.length) throw new ValidationError('The edit must contain at least one segment.');
  let previousEnd = -1;
  const segmentIds = new Set<string>();
  const segmentsById = new Map<string, EditPlan['segments'][number]>();
  for (const segment of plan.segments) {
    if (!segment.id || segmentIds.has(segment.id)) throw new ValidationError('Segment ids must be unique.');
    segmentIds.add(segment.id);
    segmentsById.set(segment.id, segment);
    if (segment.sourceStart < 0 || segment.sourceEnd <= segment.sourceStart || segment.sourceEnd > media.duration + 0.05) {
      throw new ValidationError(`Segment ${segment.id} is outside the source.`);
    }
    if (segment.sourceStart < previousEnd - 0.001) throw new ValidationError('Segments must be chronological and non-overlapping.');
    if (!['none', 'punch-in', 'slow-zoom'].includes(segment.motion)) throw new ValidationError(`Unknown motion on ${segment.id}.`);
    previousEnd = segment.sourceEnd;
  }
  const duration = planDuration(plan);
  if (duration > 120.001) throw new ValidationError('Final duration must not exceed 120 seconds.');
  if (duration < 1) throw new ValidationError('Final duration is empty.');
  for (const subtitle of plan.subtitles) {
    if (!segmentIds.has(subtitle.segmentId)) throw new ValidationError(`Subtitle ${subtitle.id} points to a missing segment.`);
    if (subtitle.sourceEnd <= subtitle.sourceStart) throw new ValidationError(`Subtitle ${subtitle.id} has invalid timing.`);
    const segment = segmentsById.get(subtitle.segmentId)!;
    if (subtitle.sourceStart < segment.sourceStart - 0.001 || subtitle.sourceEnd > segment.sourceEnd + 0.001) throw new ValidationError(`Subtitle ${subtitle.id} falls outside its segment.`);
    if (!subtitle.english.trim() || !subtitle.vietnamese.trim()) throw new ValidationError(`Subtitle ${subtitle.id} must be bilingual.`);
  }
}
