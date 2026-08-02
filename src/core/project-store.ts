import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EditPlan, FinalSnapshot, ProjectDocument, PublicProject, SourceReference, StageName } from '../shared/types.js';
import { fingerprintSource, probeMedia } from './media.js';
import { planDuration, validateEditPlan } from './validators.js';

const stages: StageName[] = ['import', 'proxy', 'asr', 'editorial', 'subtitle', 'review', 'final', 'render'];

function now(): string { return new Date().toISOString(); }

export class ProjectStore {
  readonly root: string;
  constructor(userDataPath: string) { this.root = path.join(userDataPath, 'projects'); }
  projectDir(id: string): string { assertProjectId(id); return path.join(this.root, id); }
  cacheDir(id: string): string { return path.join(this.projectDir(id), 'cache'); }
  private documentPath(id: string): string { return path.join(this.projectDir(id), 'project.json'); }

  async create(sourcePath: string, ffprobePath = 'ffprobe', ffmpegPath = 'ffmpeg'): Promise<ProjectDocument> {
    const source = await fingerprintSource(sourcePath);
    const media = await probeMedia(ffprobePath, sourcePath);
    if (!media.hasAudio) throw new Error('The source has no audio stream.');
    const id = randomUUID();
    const timestamp = now();
    const document: ProjectDocument = {
      schemaVersion: 1, id, name: path.parse(source.displayName).name, createdAt: timestamp, updatedAt: timestamp,
      source, media, settings: { model: 'gpt-5.6-sol', reasoning: 'medium', ffmpegPath, ffprobePath },
      stages: Object.fromEntries(stages.map(stage => [stage, { state: stage === 'import' ? 'complete' : 'idle', updatedAt: timestamp }])) as ProjectDocument['stages'],
      transcript: [],
    };
    await this.save(document);
    return document;
  }

  async load(id: string): Promise<ProjectDocument> {
    const project = JSON.parse(await readFile(this.documentPath(id), 'utf8')) as ProjectDocument;
    project.source.missing = !(await exists(project.source.path));
    return project;
  }

  async openFile(documentPath: string): Promise<ProjectDocument> {
    const document = JSON.parse(await readFile(documentPath, 'utf8')) as ProjectDocument;
    return this.load(document.id);
  }

  async save(project: ProjectDocument): Promise<void> {
    project.updatedAt = now();
    const dir = this.projectDir(project.id);
    await mkdir(dir, { recursive: true });
    const target = this.documentPath(project.id);
    const temporary = `${target}.partial`;
    await writeFile(temporary, JSON.stringify(project, null, 2), 'utf8');
    await rename(temporary, target);
  }

  async relink(project: ProjectDocument, sourcePath: string): Promise<ProjectDocument> {
    const source = await fingerprintSource(sourcePath);
    if (source.fingerprint !== project.source.fingerprint) throw new Error('This file does not match the original source fingerprint.');
    project.source = source;
    await this.save(project);
    return project;
  }

  public(project: ProjectDocument): PublicProject {
    const { path: _path, ...source } = project.source;
    const { proxyPath: _proxy, outputPath, settings, ...safe } = project;
    return { ...safe, source, settings: { model: settings.model, reasoning: settings.reasoning }, sourceToken: project.id,
      previewUrl: `media://project/${project.id}/source`, proxyUrl: project.proxyPath ? `media://project/${project.id}/proxy` : undefined,
      outputAvailable: Boolean(outputPath) };
  }

  finalize(project: ProjectDocument, plan: EditPlan): FinalSnapshot {
    validateEditPlan(plan, project.media);
    if (planDuration(plan) < 60) throw new Error('Final must be at least 60 seconds. Extend the accepted edit before approval.');
    const canonical = JSON.stringify(plan);
    const final: FinalSnapshot = {
      approvedAt: now(), sourceFingerprint: project.source.fingerprint,
      revisionHash: createHash('sha256').update(`${project.source.fingerprint}:${canonical}`).digest('hex'),
      plan: structuredClone(plan),
    };
    project.final = final;
    project.stages.final = { state: 'complete', updatedAt: now(), cacheKey: final.revisionHash };
    return final;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

function assertProjectId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid project id.');
}

export async function verifySource(source: SourceReference): Promise<void> {
  if (!(await exists(source.path))) throw new Error('Source file is missing. Relink it before continuing.');
  const current = await fingerprintSource(source.path);
  if (current.fingerprint !== source.fingerprint) throw new Error('Source file changed after import. Relink or create a new project.');
}
