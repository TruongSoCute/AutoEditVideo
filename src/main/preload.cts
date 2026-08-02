const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const IPC = {
  systemStatus: 'system:status', modelList: 'model:list', projectCreate: 'project:create', projectOpen: 'project:open',
  projectRelink: 'project:relink', settingsFont: 'settings:font', settingsModel: 'settings:model', analysisStart: 'analysis:start', analysisCancel: 'analysis:cancel',
  analysisResume: 'analysis:resume', reviewUpdate: 'review:update', reviewAgent: 'review:agent', reviewAccept: 'review:accept',
  reviewReject: 'review:reject', reviewApprove: 'review:approve', renderStart: 'render:start', renderCancel: 'render:cancel',
  renderReveal: 'render:reveal', clientLog: 'system:client-log', progress: 'pipeline:progress',
} as const;

contextBridge.exposeInMainWorld('autoEdit', {
  systemStatus: (projectId?: string) => ipcRenderer.invoke(IPC.systemStatus, projectId),
  listModels: () => ipcRenderer.invoke(IPC.modelList),
  createProject: () => ipcRenderer.invoke(IPC.projectCreate),
  openProject: () => ipcRenderer.invoke(IPC.projectOpen),
  relinkSource: (projectId: string) => ipcRenderer.invoke(IPC.projectRelink, projectId),
  selectSatoshiFont: (projectId: string) => ipcRenderer.invoke(IPC.settingsFont, projectId),
  updateModel: (projectId: string, model: string, reasoning: string) => ipcRenderer.invoke(IPC.settingsModel, projectId, model, reasoning),
  startAnalysis: (projectId: string) => ipcRenderer.invoke(IPC.analysisStart, projectId),
  cancelAnalysis: (projectId: string) => ipcRenderer.invoke(IPC.analysisCancel, projectId),
  resumeAnalysis: (projectId: string) => ipcRenderer.invoke(IPC.analysisResume, projectId),
  stageReview: (projectId: string, operations: unknown[]) => ipcRenderer.invoke(IPC.reviewUpdate, projectId, operations),
  askAgent: (projectId: string, instruction: string) => ipcRenderer.invoke(IPC.reviewAgent, projectId, instruction),
  acceptProposal: (projectId: string) => ipcRenderer.invoke(IPC.reviewAccept, projectId),
  rejectProposal: (projectId: string) => ipcRenderer.invoke(IPC.reviewReject, projectId),
  approve: (projectId: string) => ipcRenderer.invoke(IPC.reviewApprove, projectId),
  render: (request: unknown) => ipcRenderer.invoke(IPC.renderStart, request),
  cancelRender: (projectId: string) => ipcRenderer.invoke(IPC.renderCancel, projectId),
  reveal: (projectId: string) => ipcRenderer.invoke(IPC.renderReveal, projectId),
  log: (event: unknown) => ipcRenderer.send(IPC.clientLog, event),
  onProgress: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on(IPC.progress, listener);
    return () => ipcRenderer.removeListener(IPC.progress, listener);
  },
});
