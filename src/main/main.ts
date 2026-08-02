import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AnalysisPipeline } from '../core/analysis.js';
import { parseByteRange, RangeNotSatisfiableError } from '../core/byte-range.js';
import { codexVersion, listCodexModels, runCodexStructured } from '../core/codex.js';
import { requireSuccessful } from '../core/process.js';
import { operationsPrompt, operationsSchema } from '../core/prompts.js';
import { ProjectStore } from '../core/project-store.js';
import { applyOperations, proposal } from '../core/review.js';
import { RenderPipeline } from '../core/render.js';
import { IPC } from '../shared/bridge.js';
import type { ClientLogEvent, DependencyStatus, ProgressEvent, ProjectDocument, RenderRequest, ReviewOperation } from '../shared/types.js';
import { AppLogger } from './logger.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let store: ProjectStore;
let analysis: AnalysisPipeline;
let renderer: RenderPipeline;
let logger: AppLogger;
const rangeLogState = new Map<string, { start: number; at: number }>();

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

function bundledFontDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'assets', 'fonts') : path.resolve(currentDir, '../../../assets/fonts');
}

function sendProgress(event: ProgressEvent): void {
  if (event.progress === 0 || event.progress === 1) logger.info('pipeline', event.message, { projectId: event.projectId, stage: event.stage, progress: event.progress });
  mainWindow?.webContents.send(IPC.progress, event);
}

async function loadProject(id: string): Promise<ProjectDocument> { return await store.load(id); }

async function commandStatus(command: string): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const result = await requireSuccessful(command, ['-version']);
    return { available: true, version: (result.stdout || result.stderr).split(/\r?\n/)[0] };
  } catch (error) { return { available: false, error: error instanceof Error ? error.message : String(error) }; }
}

async function systemStatus(projectId?: string): Promise<DependencyStatus> {
  const project = projectId ? await loadProject(projectId) : undefined;
  const ffmpegPath = project?.settings.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = project?.settings.ffprobePath ?? 'ffprobe';
  const [ffmpeg, ffprobe] = await Promise.all([commandStatus(ffmpegPath), commandStatus(ffprobePath)]);
  const [versionResult, catalogResult] = await Promise.allSettled([codexVersion(), listCodexModels()]);
  const version = versionResult.status === 'fulfilled' ? versionResult.value : undefined;
  const authenticated = catalogResult.status === 'fulfilled' && catalogResult.value.length > 0;
  const available = versionResult.status === 'fulfilled' || catalogResult.status === 'fulfilled';
  const failure = catalogResult.status === 'rejected' ? catalogResult.reason : versionResult.status === 'rejected' ? versionResult.reason : undefined;
  const error = failure instanceof Error ? failure.message : failure ? String(failure) : undefined;
  if (error) logger.warn('codex', 'Codex system check incomplete', { available, authenticated, message: error });
  const codex: DependencyStatus['codex'] = { available, authenticated, version, ...(error ? { error } : {}) };
  const beVietnamPro = await exists(path.join(bundledFontDir(), 'BeVietnamPro-SemiBold.ttf'));
  const satoshi = Boolean(project?.settings.satoshiFontPath && await exists(project.settings.satoshiFontPath));
  return { codex, ffmpeg, ffprobe, fonts: { beVietnamPro, satoshi } };
}

function registerHandlers(): void {
  ipcMain.handle(IPC.systemStatus, (_event, id?: string) => systemStatus(id));
  ipcMain.handle(IPC.modelList, () => listCodexModels());
  ipcMain.handle(IPC.projectCreate, async () => {
    const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Import headtalk video', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mov', 'mp4', 'm4v', 'mkv'] }] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const project = await store.create(choice.filePaths[0]);
    logger.info('project', 'Imported source', { projectId: project.id, file: project.source.displayName, codec: project.media.videoCodec, hdr: project.media.hdr, rotation: project.media.rotation });
    return store.public(project);
  });
  ipcMain.handle(IPC.projectOpen, async () => {
    const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Open AutoEdit project', defaultPath: store.root, properties: ['openFile'], filters: [{ name: 'AutoEdit project', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    return store.public(await store.openFile(choice.filePaths[0]));
  });
  ipcMain.handle(IPC.projectRelink, async (_event, id: string) => {
    const project = await loadProject(id);
    const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Relink source', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mov', 'mp4', 'm4v', 'mkv'] }] });
    return choice.canceled || !choice.filePaths[0] ? null : store.public(await store.relink(project, choice.filePaths[0]));
  });
  ipcMain.handle(IPC.settingsFont, async (_event, id: string) => {
    const project = await loadProject(id);
    const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Select your licensed Satoshi Bold font', properties: ['openFile'], filters: [{ name: 'Font', extensions: ['otf', 'ttf'] }] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    project.settings.satoshiFontPath = choice.filePaths[0];
    await store.save(project);
    return store.public(project);
  });
  ipcMain.handle(IPC.settingsModel, async (_event, id: string, model: string, reasoning: ProjectDocument['settings']['reasoning']) => {
    const catalog = await listCodexModels();
    const selected = catalog.find(item => item.id === model);
    if (!selected) throw new Error('The selected model is not available for this Codex account.');
    if (!['low', 'medium', 'high', 'xhigh'].includes(reasoning)) throw new Error('Unsupported reasoning level.');
    if (selected.supportedReasoning?.length && !selected.supportedReasoning.includes(reasoning)) throw new Error(`${selected.displayName} does not support ${reasoning} reasoning.`);
    const project = await loadProject(id); project.settings.model = selected.id; project.settings.reasoning = reasoning; await store.save(project); return store.public(project);
  });
  ipcMain.handle(IPC.analysisStart, async (_event, id: string) => store.public(await analysis.run(await loadProject(id))));
  ipcMain.handle(IPC.analysisResume, async (_event, id: string) => store.public(await analysis.run(await loadProject(id))));
  ipcMain.handle(IPC.analysisCancel, (_event, id: string) => analysis.cancel(id));
  ipcMain.handle(IPC.reviewUpdate, async (_event, id: string, operations: ReviewOperation[]) => {
    const project = await loadProject(id);
    const base = project.pendingProposal?.plan ?? project.acceptedPlan;
    if (!base) throw new Error('Analyze the video before editing.');
    const plan = applyOperations(base, operations, project.media);
    project.pendingProposal = proposal(plan, operations, 'Manual review changes');
    await store.save(project); return store.public(project);
  });
  ipcMain.handle(IPC.reviewAgent, async (_event, id: string, instruction: string) => {
    const project = await loadProject(id);
    const base = project.pendingProposal?.plan ?? project.acceptedPlan;
    if (!base) throw new Error('Analyze the video before asking the agent.');
    const result = await runCodexStructured<{ summary: string; operations: ReviewOperation[] }>({ prompt: operationsPrompt(base, instruction), schema: operationsSchema,
      model: project.settings.model, reasoning: project.settings.reasoning });
    const plan = applyOperations(base, result.operations, project.media);
    project.pendingProposal = proposal(plan, result.operations, result.summary);
    await store.save(project); return store.public(project);
  });
  ipcMain.handle(IPC.reviewAccept, async (_event, id: string) => {
    const project = await loadProject(id); if (!project.pendingProposal) throw new Error('There is no proposal to accept.');
    project.acceptedPlan = structuredClone(project.pendingProposal.plan); project.pendingProposal = undefined;
    project.stages.review = { state: 'complete', updatedAt: new Date().toISOString(), message: 'Proposal accepted.' };
    await store.save(project); return store.public(project);
  });
  ipcMain.handle(IPC.reviewReject, async (_event, id: string) => { const project = await loadProject(id); project.pendingProposal = undefined; await store.save(project); return store.public(project); });
  ipcMain.handle(IPC.reviewApprove, async (_event, id: string) => {
    const project = await loadProject(id); if (!project.acceptedPlan) throw new Error('Accept a proposal before approving Final.');
    store.finalize(project, project.acceptedPlan); await store.save(project); return store.public(project);
  });
  ipcMain.handle(IPC.renderStart, async (_event, request: RenderRequest) => {
    const project = await loadProject(request.projectId);
    const choice = await dialog.showSaveDialog(mainWindow!, { title: 'Export Final', defaultPath: `${project.name}-final.mp4`, filters: [{ name: 'MP4', extensions: ['mp4'] }] });
    if (choice.canceled || !choice.filePath) return store.public(project);
    await renderer.run(project, choice.filePath); await store.save(project); return store.public(project);
  });
  ipcMain.handle(IPC.renderCancel, (_event, id: string) => renderer.cancel(id));
  ipcMain.handle(IPC.renderReveal, async (_event, id: string) => { const project = await loadProject(id); if (project.outputPath) shell.showItemInFolder(project.outputPath); });
  ipcMain.on(IPC.clientLog, (_event, payload: ClientLogEvent) => {
    if (!payload || !['info', 'warn', 'error'].includes(payload.level) || !['preview', 'renderer'].includes(payload.scope)) return;
    logger[payload.level](payload.scope, payload.message, payload.details);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({ width: 1500, height: 940, minWidth: 1100, minHeight: 720, backgroundColor: '#101116', title: 'AutoEdit Studio',
    webPreferences: { preload: path.join(currentDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await mainWindow.loadFile(path.resolve(currentDir, '../../renderer/index.html'));
}

app.whenReady().then(async () => {
  logger = new AppLogger(app.getPath('userData'));
  logger.info('app', 'AutoEdit Studio started', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform });
  store = new ProjectStore(app.getPath('userData'));
  analysis = new AnalysisPipeline(store, event => sendProgress(event));
  renderer = new RenderPipeline(event => sendProgress(event), bundledFontDir());
  protocol.handle('media', async request => {
    const match = new URL(request.url).pathname.match(/^\/([^/]+)\/(source|proxy)$/);
    if (!match) return new Response('Not found', { status: 404 });
    try {
      const project = await store.load(match[1]);
      const kind = match[2] as 'source' | 'proxy';
      const mediaPath = kind === 'proxy' ? project.proxyPath : project.source.path;
      if (!mediaPath || !(await exists(mediaPath))) { logger.warn('preview', 'Media route target is unavailable', { projectId: project.id, kind }); return new Response('Not found', { status: 404 }); }
      const fileInfo = await stat(mediaPath);
      const rangeHeader = request.headers.get('range');
      let range;
      try { range = parseByteRange(rangeHeader, fileInfo.size); }
      catch (error) {
        if (!(error instanceof RangeNotSatisfiableError)) throw error;
        logger.warn('preview', 'Rejected media range', { projectId: project.id, kind, range: rangeHeader ?? '', size: fileInfo.size });
        return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${fileInfo.size}` } });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? fileInfo.size - 1;
      const headers = new Headers({
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Length': String(end - start + 1),
        'Content-Type': mediaContentType(mediaPath),
      });
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${fileInfo.size}`);
      logMediaRange(project.id, kind, path.basename(mediaPath), rangeHeader, start, end, fileInfo.size);
      if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
      const body = Readable.toWeb(createReadStream(mediaPath, { start, end })) as unknown as BodyInit;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch (error) { logger.error('preview', 'Media route failed', { message: error instanceof Error ? error.message : String(error) }); return new Response('Not found', { status: 404 }); }
  });
  registerHandlers(); await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
process.on('uncaughtExceptionMonitor', error => logger?.error('process', 'Uncaught exception', { name: error.name, message: error.message, stack: error.stack?.slice(0, 1200) }));
process.on('unhandledRejection', reason => logger?.error('process', 'Unhandled rejection', { message: reason instanceof Error ? reason.message : String(reason) }));

async function exists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }

function mediaContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mov': return 'video/quicktime';
    case '.mkv': return 'video/x-matroska';
    case '.m4v': return 'video/x-m4v';
    default: return 'video/mp4';
  }
}

function logMediaRange(projectId: string, kind: 'source' | 'proxy', file: string, requested: string | null, start: number, end: number, size: number): void {
  const key = `${projectId}:${kind}`;
  const previous = rangeLogState.get(key);
  const now = Date.now();
  if (!previous || start === 0 || Math.abs(start - previous.start) >= 2 * 1024 * 1024 || now - previous.at >= 10_000) {
    logger.info('preview', 'Serving media range', { projectId, kind, file, requested: requested ?? 'full', start, end, size });
    rangeLogState.set(key, { start, at: now });
  }
}
