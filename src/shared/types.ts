export type StageName = 'import' | 'proxy' | 'asr' | 'editorial' | 'subtitle' | 'review' | 'final' | 'render';
export type StageState = 'idle' | 'running' | 'complete' | 'error' | 'cancelled';
export type MotionPreset = 'none' | 'punch-in' | 'slow-zoom';

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec?: string;
  hasAudio: boolean;
  rotation: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  dolbyVision: boolean;
  hdr: boolean;
}

export interface SourceReference {
  path: string;
  displayName: string;
  fingerprint: string;
  size: number;
  modifiedAt: number;
  missing: boolean;
}

export interface TranscriptCue {
  id: string;
  start: number;
  end: number;
  rawAsr: string;
  english: string;
  vietnamese: string;
  provenance: 'asr' | 'agent-corrected' | 'user-edited';
}

export interface SubtitleCue {
  id: string;
  segmentId: string;
  sourceStart: number;
  sourceEnd: number;
  english: string;
  vietnamese: string;
}

export interface EditSegment {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  transcriptCueIds: string[];
  hook?: string;
  rationale?: string;
  framingOffset: number;
  motion: MotionPreset;
}

export interface EditPlan {
  revision: number;
  targetDuration: number;
  segments: EditSegment[];
  subtitles: SubtitleCue[];
  voiceCleanup: boolean;
  exportPreset: {
    width: 1080;
    height: 1920;
    fps: 30;
    videoCodec: 'h264';
    audioCodec: 'aac';
    crf: 18;
  };
}

export type ReviewOperation =
  | { type: 'remove-segment'; segmentId: string }
  | { type: 'update-trim'; segmentId: string; sourceStart: number; sourceEnd: number }
  | { type: 'update-subtitle'; subtitleId: string; english: string; vietnamese: string }
  | { type: 'update-motion'; segmentId: string; motion: MotionPreset }
  | { type: 'set-voice-cleanup'; enabled: boolean };

export interface Proposal {
  id: string;
  createdAt: string;
  summary: string;
  plan: EditPlan;
  operations: ReviewOperation[];
}

export interface FinalSnapshot {
  approvedAt: string;
  sourceFingerprint: string;
  revisionHash: string;
  plan: EditPlan;
}

export interface Checkpoint {
  state: StageState;
  updatedAt: string;
  cacheKey?: string;
  message?: string;
}

export interface ProjectSettings {
  model: string;
  reasoning: 'low' | 'medium' | 'high' | 'xhigh';
  ffmpegPath: string;
  ffprobePath: string;
  satoshiFontPath?: string;
}

export interface ProjectDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  source: SourceReference;
  media: MediaInfo;
  settings: ProjectSettings;
  stages: Record<StageName, Checkpoint>;
  transcript: TranscriptCue[];
  acceptedPlan?: EditPlan;
  pendingProposal?: Proposal;
  final?: FinalSnapshot;
  proxyPath?: string;
  outputPath?: string;
}

export type PublicProject = Omit<ProjectDocument, 'source' | 'proxyPath' | 'outputPath' | 'settings'> & {
  source: Omit<SourceReference, 'path'>;
  settings: Pick<ProjectSettings, 'model' | 'reasoning'>;
  sourceToken: string;
  previewUrl: string;
  proxyUrl?: string;
  outputAvailable: boolean;
};

export interface DependencyStatus {
  codex: { available: boolean; authenticated: boolean; version?: string; error?: string };
  ffmpeg: { available: boolean; version?: string; error?: string };
  ffprobe: { available: boolean; version?: string; error?: string };
  fonts: { beVietnamPro: boolean; satoshi: boolean };
}

export interface ModelItem { id: string; displayName: string; description?: string; defaultReasoning?: string; supportedReasoning?: string[]; isDefault?: boolean }

export interface ProgressEvent {
  projectId: string;
  stage: StageName;
  progress: number;
  message: string;
}

export interface RenderRequest { projectId: string }

export interface ClientLogEvent {
  level: 'info' | 'warn' | 'error';
  scope: 'preview' | 'renderer';
  message: string;
  details?: Record<string, string | number | boolean | null>;
}
