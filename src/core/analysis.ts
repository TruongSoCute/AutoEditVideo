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
interface EditorialResult { summary: string; segments: EditSegment[] }
interface SubtitleResult { subtitles: SubtitleCue[]; voiceCleanup: boolean }

export class AnalysisPipeline {
  private controllers = new Map<string, AbortController>();
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
          await createProxy({ ffmpegPath: project.settings.ffmpegPath, source: project.source.path, target: proxyPath, media: project.media, signal: controller.signal,
            onProgress: ratio => this.progress({ projectId: project.id, stage: 'proxy', progress: ratio, message: `Creating proxy ${Math.round(ratio * 100)}%` }) });
        });
      }
      project.proxyPath = proxyPath;
      const pcmPath = path.join(cache, `${project.source.fingerprint}-mono16k.wav`);
      await this.stage(project, 'asr', 'Transcribing locally with Whisper…', async () => {
        if (!project.transcript.length) {
          if (!(await exists(pcmPath))) await extractPcm(project.settings.ffmpegPath, project.source.path, pcmPath, controller.signal);
          project.transcript = await transcribeLocal(pcmPath, path.join(cache, 'models'), controller.signal);
          validateTranscript(project.transcript, project.media.duration);
        }
      });
      const frames = await extractEvidenceFrames(project.settings.ffmpegPath, proxyPath, path.join(cache, 'evidence'), project.media.duration, controller.signal);
      let editorial!: EditorialResult;
      const agentKey = createHash('sha256').update(`${project.source.fingerprint}:${project.settings.model}:${project.settings.reasoning}:prompt-v1`).digest('hex').slice(0, 16);
      const editorialCheckpoint = path.join(cache, `${agentKey}-editorial.json`);
      await this.stage(project, 'editorial', 'Codex is shaping the story…', async () => {
        editorial = await readJson<EditorialResult>(editorialCheckpoint) ?? await runCodexStructured<EditorialResult>({
          prompt: editorialPrompt(project.media, project.transcript), schema: editorialSchema, model: project.settings.model,
          reasoning: project.settings.reasoning, images: frames, signal: controller.signal,
          onProgress: message => this.progress({ projectId: project.id, stage: 'editorial', progress: 0.5, message }),
        });
        await writeJsonAtomic(editorialCheckpoint, editorial);
      });
      let subtitle!: SubtitleResult;
      const subtitleCheckpoint = path.join(cache, `${agentKey}-subtitle.json`);
      await this.stage(project, 'subtitle', 'Creating bilingual subtitles…', async () => {
        subtitle = await readJson<SubtitleResult>(subtitleCheckpoint) ?? await runCodexStructured<SubtitleResult>({
          prompt: subtitlePrompt(editorial.segments, project.transcript), schema: subtitleSchema, model: project.settings.model,
          reasoning: project.settings.reasoning, signal: controller.signal,
          onProgress: message => this.progress({ projectId: project.id, stage: 'subtitle', progress: 0.5, message }),
        });
        await writeJsonAtomic(subtitleCheckpoint, subtitle);
      });
      const duration = editorial.segments.reduce((sum, item) => sum + item.sourceEnd - item.sourceStart, 0);
      const plan: EditPlan = { revision: 1, targetDuration: duration, segments: editorial.segments, subtitles: subtitle.subtitles,
        voiceCleanup: subtitle.voiceCleanup, exportPreset: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', crf: 18 } };
      validateEditPlan(plan, project.media);
      project.pendingProposal = proposal(plan, [], editorial.summary);
      project.stages.review = { state: 'running', updatedAt: new Date().toISOString(), message: 'Review the AI proposal.' };
      await this.store.save(project);
      return project;
    } catch (error) {
      if (controller.signal.aborted) this.progress({ projectId: project.id, stage: 'review', progress: 0, message: 'Analysis cancelled. Resume is available.' });
      throw error;
    } finally { this.controllers.delete(project.id); }
  }

  private async stage(project: ProjectDocument, stage: 'proxy' | 'asr' | 'editorial' | 'subtitle', message: string, action: () => Promise<void>): Promise<void> {
    project.stages[stage] = { state: 'running', updatedAt: new Date().toISOString(), message };
    await this.store.save(project);
    this.progress({ projectId: project.id, stage, progress: 0, message });
    try {
      await action();
      project.stages[stage] = { state: 'complete', updatedAt: new Date().toISOString(), cacheKey: project.source.fingerprint };
      await this.store.save(project);
      this.progress({ projectId: project.id, stage, progress: 1, message: `${stage} complete` });
    } catch (error) {
      project.stages[stage] = { state: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error', updatedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
      await this.store.save(project);
      throw error;
    }
  }
}

async function exists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }
async function readJson<T>(filePath: string): Promise<T | undefined> { try { return JSON.parse(await readFile(filePath, 'utf8')) as T; } catch { return undefined; } }
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> { const partial = `${filePath}.partial`; await writeFile(partial, JSON.stringify(value), 'utf8'); await rename(partial, filePath); }
