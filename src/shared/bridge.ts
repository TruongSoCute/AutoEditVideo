import type { DependencyStatus, ModelItem, ProgressEvent, PublicProject, RenderRequest, ReviewOperation } from './types.js';

export const IPC = {
  systemStatus: 'system:status', modelList: 'model:list', projectCreate: 'project:create',
  projectOpen: 'project:open', projectRelink: 'project:relink', analysisStart: 'analysis:start',
  analysisCancel: 'analysis:cancel', analysisResume: 'analysis:resume', reviewUpdate: 'review:update',
  reviewAgent: 'review:agent', reviewAccept: 'review:accept', reviewReject: 'review:reject',
  reviewApprove: 'review:approve', renderStart: 'render:start', renderCancel: 'render:cancel',
  renderReveal: 'render:reveal', settingsFont: 'settings:font', settingsModel: 'settings:model', progress: 'pipeline:progress',
} as const;

export interface AutoEditApi {
  systemStatus(projectId?: string): Promise<DependencyStatus>;
  listModels(): Promise<ModelItem[]>;
  createProject(): Promise<PublicProject | null>;
  openProject(): Promise<PublicProject | null>;
  relinkSource(projectId: string): Promise<PublicProject | null>;
  selectSatoshiFont(projectId: string): Promise<PublicProject | null>;
  updateModel(projectId: string, model: string, reasoning: 'low' | 'medium' | 'high' | 'xhigh'): Promise<PublicProject>;
  startAnalysis(projectId: string): Promise<PublicProject>;
  cancelAnalysis(projectId: string): Promise<void>;
  resumeAnalysis(projectId: string): Promise<PublicProject>;
  stageReview(projectId: string, operations: ReviewOperation[]): Promise<PublicProject>;
  askAgent(projectId: string, instruction: string): Promise<PublicProject>;
  acceptProposal(projectId: string): Promise<PublicProject>;
  rejectProposal(projectId: string): Promise<PublicProject>;
  approve(projectId: string): Promise<PublicProject>;
  render(request: RenderRequest): Promise<PublicProject>;
  cancelRender(projectId: string): Promise<void>;
  reveal(projectId: string): Promise<void>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
}
