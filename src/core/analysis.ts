import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EditPlan, EditSegment, ProgressEvent, ProjectDocument, SubtitleCue } from '../shared/types.js';
import { transcribeLocal } from './asr.js';
import { runCodexStructured } from './codex.js';
import { createProxy, extractEvidenceFrames, extractPcm } from './media.js';
import { editorialPrompt, editorialSchema, subtitlePrompt, subtitleSchema } from './prompts.js';
import { ProjectStore, verifySource } from './project-store.js';
import { proposal } from './review.js';
import { validateEditPlan, validateTranscript } from './validators.js';

type Progress = (event: ProgressEvent) => void;
type AnalysisStage = 'proxy' | 'asr' | 'editorial' | 'subtitle';
interface EditorialResult { summary: string; segments: EditSegment[] }
interface SubtitleResult { subtitles: SubtitleCue[]; voiceCleanup: boolean }

const STAGE_LABELS: Record<AnalysisStage, string> = {
  proxy: 'Proxy', asr: 'Transcript', editorial: 'Editorial', subtitle: 'Subtitles',
};
const STAGE_RANGES: Record<AnalysisStage, [number, number]> = {
  proxy: [0, 0.34], asr: [0.34, 0.6], editorial: [0.6, 0.84], subtitle: [0.84, 1],
};

export function analysisOverallProgress(stage: AnalysisStage, progress: number): number {
  const bounded = Math.min(1, Math.max(0, progress));
  const [start, end] = STAGE_RANGES[stage];
  return start + (end - start) * bounded;
}

export class AnalysisPipeline {
  private controllers = new Map<string, AbortController>();
  private progressValues = new Map<string, number>();
  constructor(private store: ProjectStore, private progress: Progress) {}

  cancel(projectId: string): void { this.controllers.get(projectId)?.abort(); }

  async run(project: ProjectDocument): Promise<ProjectDocument> {
    if (this.controllers.has(project.id)) throw new Error('Analysis is already running.');
    const controller = new AbortController();
    this.controllers.set(project.id, controller);
    try {
      await verifySource(project.source);
      const cache = this.store.cacheDir(project.id);
      await mkdir(cache, { recursive: true });
      const proxyPath = path.join(cache, `${project.source.fingerprint}-proxy.mp4`);
      if (!(await exists(proxyPath))) {
        await this.stage(project, 'proxy', 'Creating an SDR editing proxy…', async () => {
          await createProxy({
            ffmpegPath: project.settings.ffmpegPath, source: project.source.path, target: proxyPath, media: project.media, signal: controller.signal,
            onProgress: ratio => this.emit(project.id, 'proxy', ratio, `Encoding portrait SDR proxy ${Math.round(ratio * 100)}%`),
          });
        });
      } else {
        project.stages.proxy = { state: 'complete', updatedAt: new Date().toISOString(), cacheKey: project.source.fingerprint, message: 'Using cached SDR proxy.' };
        this.emit(project.id, 'proxy', 1, 'Cached SDR proxy is ready.', 'complete');
      }
      project.proxyPath = proxyPath;

      const pcmPath = path.join(cache, `${project.source.fingerprint}-mono16k.wav`);
      await this.stage(project, 'asr', 'Transcribing locally with Whisper…', async () => {
        if (!project.transcript.length) {
          if (!(await exists(pcmPath))) {
            this.emit(project.id, 'asr', 0.05, 'Extracting mono 16 kHz audio for speech recognition…');
            await extractPcm(project.settings.ffmpegPath, project.source.path, pcmPath, controller.signal);
          } else this.emit(project.id, 'asr', 0.08, 'Using cached speech-recognition audio.');
          this.emit(project.id, 'asr', 0.1, 'Starting local Whisper transcription…');
          project.transcript = await transcribeLocal(
            pcmPath, path.join(cache, 'models'), controller.signal,
            (ratio, message) => this.emit(project.id, 'asr', 0.1 + ratio * 0.85, message),
          );
          validateTranscript(project.transcript, project.media.duration);
        } else this.emit(project.id, 'asr', 0.95, `Using ${project.transcript.length} cached transcript cues.`);
      });

      let editorial!: EditorialResult;
      const agentKey = createHash('sha256').update(`${project.source.fingerprint}:${project.settings.model}:${project.settings.reasoning}:prompt-v1`).digest('hex').slice(0, 16);
      const editorialCheckpoint = path.join(cache, `${agentKey}-editorial.json`);
      await this.stage(project, 'editorial', 'Codex is shaping the story…', async () => {
        const cached = await readJson<EditorialResult>(editorialCheckpoint);
        if (cached) {
          this.emit(project.id, 'editorial', 0.9, 'Using cached editorial proposal.');
          editorial = cached;
        } else {
          this.emit(project.id, 'editorial', 0.04, 'Extracting five visual evidence frames…');
          const frames = await extractEvidenceFrames(
            project.settings.ffmpegPath, proxyPath, path.join(cache, 'evidence'), project.media.duration, controller.signal,
            ratio => this.emit(project.id, 'editorial', 0.04 + ratio * 0.2, `Extracting evidence frame ${Math.ceil(ratio * 5)} of 5…`),
          );
          this.emit(project.id, 'editorial', 0.28, `Starting ${project.settings.model} editorial agent…`);
          let agentProgress = 0.3;
          editorial = await runCodexStructured<EditorialResult>({
            prompt: editorialPrompt(project.media, project.transcript), schema: editorialSchema, model: project.settings.model,
            reasoning: project.settings.reasoning, images: frames, signal: controller.signal,
            onProgress: message => {
              agentProgress = Math.min(0.88, agentProgress + 0.04);
              this.emit(project.id, 'editorial', agentProgress, describeCodexProgress(message, 'editorial structure'));
            },
          });
          this.emit(project.id, 'editorial', 0.93, 'Validating chronological clips and target duration…');
        }
        await writeJsonAtomic(editorialCheckpoint, editorial);
      });

      let subtitle!: SubtitleResult;
      const subtitleCheckpoint = path.join(cache, `${agentKey}-subtitle.json`);
      await this.stage(project, 'subtitle', 'Creating bilingual subtitles…', async () => {
        const cached = await readJson<SubtitleResult>(subtitleCheckpoint);
        if (cached) {
          this.emit(project.id, 'subtitle', 0.9, 'Using cached bilingual subtitles.');
          subtitle = cached;
        } else {
          this.emit(project.id, 'subtitle', 0.08, 'Preparing English cue groups and Vietnamese translation context…');
          let agentProgress = 0.12;
          subtitle = await runCodexStructured<SubtitleResult>({
            prompt: subtitlePrompt(editorial.segments, project.transcript), schema: subtitleSchema, model: project.settings.model,
            reasoning: project.settings.reasoning, signal: controller.signal,
            onProgress: message => {
              agentProgress = Math.min(0.9, agentProgress + 0.05);
              this.emit(project.id, 'subtitle', agentProgress, describeCodexProgress(message, 'bilingual subtitles'));
            },
          });
          this.emit(project.id, 'subtitle', 0.94, 'Validating subtitle timing and voice-cleanup settings…');
        }
        await writeJsonAtomic(subtitleCheckpoint, subtitle);
      });

      const duration = editorial.segments.reduce((sum, item) => sum + item.sourceEnd - item.sourceStart, 0);
      const plan: EditPlan = {
        revision: 1, targetDuration: duration, segments: editorial.segments, subtitles: subtitle.subtitles,
        voiceCleanup: subtitle.voiceCleanup, exportPreset: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', crf: 18 },
      };
      validateEditPlan(plan, project.media);
      project.pendingProposal = proposal(plan, [], editorial.summary);
      project.stages.review = { state: 'running', updatedAt: new Date().toISOString(), message: 'Review the AI proposal.' };
      await this.store.save(project);
      this.progress({ projectId: project.id, stage: 'review', progress: 1, overallProgress: 1, state: 'complete', message: 'Analysis complete. Review the AI proposal before accepting it.' });
      return project;
    } finally { this.controllers.delete(project.id); }
  }

  private async stage(project: ProjectDocument, stage: AnalysisStage, message: string, action: () => Promise<void>): Promise<void> {
    project.stages[stage] = { state: 'running', updatedAt: new Date().toISOString(), message };
    await this.store.save(project);
    this.emit(project.id, stage, 0, message, 'running');
    try {
      await action();
      project.stages[stage] = { state: 'complete', updatedAt: new Date().toISOString(), cacheKey: project.source.fingerprint, message: `${STAGE_LABELS[stage]} complete.` };
      await this.store.save(project);
      this.emit(project.id, stage, 1, `${STAGE_LABELS[stage]} complete.`, 'complete');
    } catch (error) {
      const state = error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error';
      const detail = state === 'cancelled' ? `${STAGE_LABELS[stage]} stopped. Completed checkpoints are safe to resume.` : error instanceof Error ? error.message : String(error);
      project.stages[stage] = { state, updatedAt: new Date().toISOString(), message: detail };
      await this.store.save(project);
      this.emit(project.id, stage, 0, detail, state);
      throw error;
    }
  }

  private emit(projectId: string, stage: AnalysisStage, progress: number, message: string, state: ProgressEvent['state'] = 'running'): void {
    const key = `${projectId}:${stage}`;
    const requested = Math.min(1, Math.max(0, progress));
    const bounded = state === 'cancelled' || state === 'error'
      ? Math.max(requested, this.progressValues.get(key) ?? 0)
      : requested;
    if (state === 'running') this.progressValues.set(key, bounded);
    else this.progressValues.delete(key);
    this.progress({ projectId, stage, progress: bounded, overallProgress: analysisOverallProgress(stage, bounded), state, message });
  }
}

function describeCodexProgress(message: string, output: string): string {
  if (/thread started/i.test(message)) return `Codex session started for ${output}.`;
  if (/turn started/i.test(message)) return `Codex is reading the evidence and drafting ${output}…`;
  if (/turn completed/i.test(message)) return `Codex returned ${output}; preparing validation…`;
  if (/item completed/i.test(message)) return `Codex completed a reasoning step for ${output}.`;
  return `Codex: ${message}`;
}

async function exists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }
async function readJson<T>(filePath: string): Promise<T | undefined> { try { return JSON.parse(await readFile(filePath, 'utf8')) as T; } catch { return undefined; } }
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> { const partial = `${filePath}.partial`; await writeFile(partial, JSON.stringify(value), 'utf8'); await rename(partial, filePath); }
