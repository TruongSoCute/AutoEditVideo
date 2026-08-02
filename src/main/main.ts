import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AnalysisPipeline } from '../core/analysis.js';
import { codexVersion, listCodexModels, runCodexStructured } from '../core/codex.js';
import { requireSuccessful } from '../core/process.js';
import { operationsPrompt, operationsSchema } from '../core/prompts.js';
import { ProjectStore } from '../core/project-store.js';
import { applyOperations, proposal } from '../core/review.js';
import { RenderPipeline } from '../core/render.js';
import { IPC } from '../shared/bridge.js';
import type { DependencyStatus, ProgressEvent, ProjectDocument, RenderRequest, ReviewOperation } from '../shared/types.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let store: ProjectStore;
let analysis: AnalysisPipeline;
let renderer: RenderPipeline;

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

function bundledFontDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'assets', 'fonts') : path.resolve(currentDir, '../../../assets/fonts');
}

function sendProgress(event: ProgressEvent): void {
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
  let codex: DependencyStatus['codex'];
  try { codex = { available: true, authenticated: (await listCodexModels()).length > 0, version: await codexVersion() }; }
  catch (error) { codex = { available: false, authenticated: false, error: error instanceof Error ? error.message : String(error) }; }
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
    return store.public(await store.create(choice.filePaths[0]));
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
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({ width: 1500, height: 940, minWidth: 1100, minHeight: 720, backgroundColor: '#101116', title: 'AutoEdit Studio',
    webPreferences: { preload: path.join(currentDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await mainWindow.loadFile(path.resolve(currentDir, '../../renderer/index.html'));
}

app.whenReady().then(async () => {
  store = new ProjectStore(app.getPath('userData'));
  analysis = new AnalysisPipeline(store, event => sendProgress(event));
  renderer = new RenderPipeline(event => sendProgress(event), bundledFontDir());
  protocol.handle('media', async request => {
    const match = new URL(request.url).pathname.match(/^\/([^/]+)\/proxy$/);
    if (!match) return new Response('Not found', { status: 404 });
    try { const project = await store.load(match[1]); if (!project.proxyPath) return new Response('Not found', { status: 404 }); return await net.fetch(pathToFileURL(project.proxyPath).toString()); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  registerHandlers(); await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

async function exists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }
