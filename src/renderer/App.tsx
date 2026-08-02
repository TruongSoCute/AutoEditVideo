import { useEffect, useMemo, useRef, useState } from 'react';
import type { DependencyStatus, EditSegment, ModelItem, ProgressEvent, PublicProject, StageName, StageState, SubtitleCue } from '../shared/types';

const steps = ['Import', 'Proxy', 'Transcript', 'Editorial', 'Subtitles', 'Review', 'Final', 'Render'];
const reasoningOptions = ['low', 'medium', 'high', 'xhigh'] as const;
type Reasoning = typeof reasoningOptions[number];
type AnalysisStage = Extract<StageName, 'proxy' | 'asr' | 'editorial' | 'subtitle'>;
type AnalysisRunStatus = 'running' | 'stopping' | 'complete' | 'cancelled' | 'error';
interface AnalysisLogEvent extends ProgressEvent { receivedAt: number }
interface AnalysisRun { status: AnalysisRunStatus; startedAt: number; endedAt?: number; events: AnalysisLogEvent[] }

const analysisStageOrder: AnalysisStage[] = ['proxy', 'asr', 'editorial', 'subtitle'];
const analysisStageCopy: Record<AnalysisStage, { label: string; detail: string }> = {
  proxy: { label: 'SDR proxy', detail: 'Autorotate, tone-map and encode a smooth 720×1280 preview.' },
  asr: { label: 'Whisper transcript', detail: 'Extract mono audio and transcribe English locally on CPU.' },
  editorial: { label: 'Editorial structure', detail: 'Capture evidence frames and ask Codex for chronological clips.' },
  subtitle: { label: 'Bilingual subtitles', detail: 'Create English–Vietnamese cues and voice-cleanup settings.' },
};

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  return `${mins}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

export default function App() {
  const [project, setProject] = useState<PublicProject | null>(null);
  const [status, setStatus] = useState<DependencyStatus | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [agentText, setAgentText] = useState('Make the opening tighter and keep the strongest explanation.');
  const [previewError, setPreviewError] = useState('');
  const [previewReady, setPreviewReady] = useState(false);
  const [previewMode, setPreviewMode] = useState<'fill' | 'fit'>('fill');
  const [analysisRun, setAnalysisRun] = useState<AnalysisRun | null>(null);
  const [, setClock] = useState(Date.now());
  const cancelRequested = useRef(false);
  const plan = project?.pendingProposal?.plan ?? project?.acceptedPlan ?? project?.final?.plan;
  const previewUrl = project?.proxyUrl ?? project?.previewUrl;

  useEffect(() => window.autoEdit.onProgress(event => {
    setProgress(event);
    if (!isAnalysisProgress(event)) return;
    const receivedAt = Date.now();
    setAnalysisRun(current => appendAnalysisProgress(current, { ...event, receivedAt }));
  }), []);
  useEffect(() => { void refreshDependencies(); }, [project?.id]);
  useEffect(() => { setPreviewError(''); setPreviewReady(false); }, [previewUrl]);
  useEffect(() => {
    if (analysisRun?.status !== 'running' && analysisRun?.status !== 'stopping') return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [analysisRun?.status]);

  async function action<T>(task: () => Promise<T>, apply?: (value: T) => void) {
    setBusy(true); setError('');
    try { const value = await task(); apply?.(value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function refreshDependencies() {
    const [nextStatus, nextModels] = await Promise.allSettled([window.autoEdit.systemStatus(project?.id), window.autoEdit.listModels()]);
    setStatus(nextStatus.status === 'fulfilled' ? nextStatus.value : null);
    if (nextModels.status === 'fulfilled') setModels(nextModels.value);
    else {
      setModels([]);
      window.autoEdit.log({ level: 'warn', scope: 'renderer', message: 'Model catalog unavailable', details: { message: nextModels.reason instanceof Error ? nextModels.reason.message : String(nextModels.reason) } });
    }
  }

  async function runAnalysis(resume: boolean) {
    if (!project) return;
    const startedAt = Date.now();
    cancelRequested.current = false;
    setBusy(true); setError(''); setProgress(null);
    setAnalysisRun({
      status: 'running', startedAt, events: [{
        projectId: project.id, stage: 'proxy', progress: 0, overallProgress: 0, state: 'running',
        message: resume ? 'Checking completed checkpoints before resuming…' : 'Checking the source and preparing analysis…', receivedAt: startedAt,
      }],
    });
    try {
      const updated = await (resume ? window.autoEdit.resumeAnalysis(project.id) : window.autoEdit.startAnalysis(project.id));
      setProject(updated);
      setAnalysisRun(current => current ? { ...current, status: 'complete', endedAt: Date.now() } : current);
    } catch (reason) {
      const cancelled = cancelRequested.current || /cancel|abort/i.test(reason instanceof Error ? reason.message : String(reason));
      setAnalysisRun(current => current ? { ...current, status: cancelled ? 'cancelled' : 'error', endedAt: Date.now() } : current);
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      cancelRequested.current = false;
    }
  }

  async function stopAnalysis() {
    if (!project || !analysisRun || analysisRun.status !== 'running') return;
    cancelRequested.current = true;
    const receivedAt = Date.now();
    setAnalysisRun(current => {
      if (!current) return current;
      const stopEvent: AnalysisLogEvent = {
        projectId: project.id, stage: latestAnalysisStage(current), progress: latestAnalysisProgress(current),
        overallProgress: latestOverallProgress(current), state: 'running', message: 'Stop requested. Shutting down the current task safely…', receivedAt,
      };
      return { ...current, status: 'stopping', events: [...current.events, stopEvent].slice(-40) };
    });
    try { await window.autoEdit.cancelAnalysis(project.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  const setMaybeProject = (value: PublicProject | null) => { if (value) setProject(value); };
  const totalDuration = useMemo(() => plan?.segments.reduce((sum, item) => sum + item.sourceEnd - item.sourceStart, 0) ?? 0, [plan]);
  const analysisActive = analysisRun?.status === 'running' || analysisRun?.status === 'stopping';
  const analysisResumable = analysisRun?.status === 'cancelled' || analysisRun?.status === 'error' || analysisStageOrder.some(stage => ['cancelled', 'error'].includes(project?.stages[stage]?.state ?? ''));

  async function updateMotion(segment: EditSegment) {
    const values = ['none', 'punch-in', 'slow-zoom'] as const;
    const motion = values[(values.indexOf(segment.motion) + 1) % values.length];
    await action(() => window.autoEdit.stageReview(project!.id, [{ type: 'update-motion', segmentId: segment.id, motion }]), setProject);
  }

  async function editSubtitle(cue: SubtitleCue) {
    const english = window.prompt('English subtitle', cue.english); if (english === null) return;
    const vietnamese = window.prompt('Vietnamese subtitle', cue.vietnamese); if (vietnamese === null) return;
    await action(() => window.autoEdit.stageReview(project!.id, [{ type: 'update-subtitle', subtitleId: cue.id, english, vietnamese }]), setProject);
  }

  function previewLoaded(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    setPreviewReady(true); setPreviewError('');
    window.autoEdit.log({ level: 'info', scope: 'preview', message: 'Preview metadata loaded', details: {
      projectId: project?.id ?? '', kind: project?.proxyUrl ? 'proxy' : 'source', duration: video.duration,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight, readyState: video.readyState,
    } });
  }

  function previewFailed(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    const message = project?.proxyUrl
      ? 'Proxy preview could not be played. Check the app log and regenerate the proxy.'
      : 'This source codec cannot be previewed directly. Analyze the video to create a compatible SDR proxy.';
    setPreviewReady(false); setPreviewError(message);
    window.autoEdit.log({ level: 'error', scope: 'preview', message: 'Preview playback failed', details: {
      projectId: project?.id ?? '', kind: project?.proxyUrl ? 'proxy' : 'source', codec: project?.media.videoCodec ?? '',
      mediaErrorCode: video.error?.code ?? 0, mediaError: video.error?.message ?? '', networkState: video.networkState, readyState: video.readyState,
    } });
  }

  const codexConnected = models.length > 0 || status?.codex.authenticated === true;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">A</span><div><strong>AutoEdit</strong><small>STUDIO</small></div></div>
      <div className="project-title">{project ? project.name : 'A quiet workspace for sharp stories'}</div>
      {project && <AgentPicker project={project} models={models} busy={busy} authenticated={codexConnected} statusError={status?.codex.error}
        onModel={model => void action(() => window.autoEdit.updateModel(project.id, model, project.settings.reasoning), setProject)}
        onReasoning={reasoning => void action(() => window.autoEdit.updateModel(project.id, project.settings.model, reasoning), setProject)}
        onRetry={() => void refreshDependencies()} />}
      <div className="top-actions"><button className="ghost" onClick={() => void action(window.autoEdit.openProject, setMaybeProject)}>Open</button><button className="primary" onClick={() => void action(window.autoEdit.createProject, setMaybeProject)}>＋ Import video</button></div>
    </header>

    <aside className="sidebar">
      <p className="eyebrow">WORKFLOW</p>
      <nav>{steps.map((step, index) => {
        const keys = ['import', 'proxy', 'asr', 'editorial', 'subtitle', 'review', 'final', 'render'] as const;
        const state = project?.stages[keys[index]]?.state ?? 'idle';
        return <div className={`step ${state}`} key={step}><span>{state === 'complete' ? '✓' : index + 1}</span><div>{step}<small>{state}</small></div></div>;
      })}</nav>
      <div className="checks"><p className="eyebrow">SYSTEM CHECK</p>
        <Check label="Codex CLI" ok={codexConnected} hint={status?.codex.error} />
        {!codexConnected && <button className="codex-retry" disabled={busy} onClick={() => void refreshDependencies()}>Retry Codex</button>}
        <Check label="FFmpeg" ok={status?.ffmpeg.available} />
        <Check label="FFprobe" ok={status?.ffprobe.available} />
        <Check label="Be Vietnam Pro" ok={status?.fonts.beVietnamPro} />
        <button className="font-button" disabled={!project} onClick={() => project && void action(() => window.autoEdit.selectSatoshiFont(project.id), setMaybeProject)}>Satoshi Bold {status?.fonts.satoshi ? '✓' : '— select'}</button>
      </div>
    </aside>

    <main className="workspace">
      {!project ? <EmptyState onImport={() => void action(window.autoEdit.createProject, setMaybeProject)} /> : <>
        <section className="preview-panel">
          <div className="panel-head"><div><p className="eyebrow">PREVIEW</p><h2>{project.source.displayName}</h2></div><div className="duration">{formatTime(totalDuration || project.media.duration)} <span>/ {formatTime(project.media.duration)}</span></div></div>
          <div className="stage">
            <div className="preview-toolbar"><span className={`preview-source ${project.proxyUrl ? 'proxy' : ''}`}>{project.proxyUrl ? 'SDR PROXY' : 'SOURCE'}</span><div><button className={previewMode === 'fill' ? 'active' : ''} onClick={() => setPreviewMode('fill')}>9:16 crop</button><button className={previewMode === 'fit' ? 'active' : ''} onClick={() => setPreviewMode('fit')}>Fit source</button></div></div>
            <div className={`phone-frame ${previewMode}`}>
              <video key={previewUrl} controls playsInline preload="metadata" src={previewUrl} onLoadedMetadata={previewLoaded} onCanPlay={() => setPreviewReady(true)} onError={previewFailed} />
              {!previewReady && !previewError && <div className="preview-loading"><span /><p>Loading preview…</p></div>}
              {previewError && <div className="preview-failure"><strong>Preview unavailable</strong><p>{previewError}</p>{!project.proxyUrl && <button onClick={() => void runAnalysis(false)}>Create compatible proxy</button>}</div>}
            </div>
            {plan?.subtitles[0] && previewReady && <div className="subtitle-sample"><strong>{plan.subtitles[0].english}</strong><span>{plan.subtitles[0].vietnamese}</span></div>}
          </div>
          {progress && <div className="progress"><div style={{ width: `${Math.round((progress.overallProgress ?? progress.progress) * 100)}%` }} /><span>{progress.message} · {Math.round((progress.overallProgress ?? progress.progress) * 100)}%</span></div>}
          <div className="transport"><span className="preview-health"><i className={previewReady ? 'ready' : ''} />{previewReady ? 'Preview ready' : 'Preparing preview'}</span><span>{project.media.width}×{project.media.height} · {project.media.videoCodec.toUpperCase()} {project.media.hdr ? '· HDR source' : ''}</span></div>
        </section>

        <section className="editor-panel">
          <div className="tabs"><button className="active">Edit plan</button><button>Transcript</button><button>Subtitles</button></div>
          {analysisRun && <AnalysisMonitor project={project} run={analysisRun} onStop={() => void stopAnalysis()} onResume={() => void runAnalysis(true)} />}
          <div className="proposal-banner">{project.pendingProposal ? <><span>AI PROPOSAL</span><p>{project.pendingProposal.summary}</p><button onClick={() => void action(() => window.autoEdit.rejectProposal(project.id), setProject)}>Reject</button><button className="accept" onClick={() => void action(() => window.autoEdit.acceptProposal(project.id), setProject)}>Accept</button></> : <p>{project.acceptedPlan ? 'Accepted edit — ready to approve.' : 'Analyze to create the first proposal.'}</p>}</div>
          <div className="clip-list">{plan?.segments.map((segment, index) => <article className="clip" key={segment.id}>
            <span className="clip-number">{String(index + 1).padStart(2, '0')}</span><div className="clip-main"><strong>{segment.hook || `Clip ${index + 1}`}</strong><p>{segment.rationale}</p><small>{formatTime(segment.sourceStart)} → {formatTime(segment.sourceEnd)} · {(segment.sourceEnd - segment.sourceStart).toFixed(1)}s</small></div>
            <button className="motion" onClick={() => void updateMotion(segment)}>{segment.motion}</button>
          </article>) ?? <div className="empty-list">No edit plan yet.</div>}</div>
          {plan?.subtitles.length ? <div className="subtitle-list"><p className="eyebrow">SUBTITLE LINES</p>{plan.subtitles.slice(0, 6).map(cue => <button key={cue.id} onClick={() => void editSubtitle(cue)}><strong>{cue.english}</strong><span>{cue.vietnamese}</span></button>)}</div> : null}
        </section>

        <section className="bottom-panel">
          <div className="agent-box"><label>ASK AGENT</label><input value={agentText} onChange={event => setAgentText(event.target.value)} /><button disabled={busy || !plan} onClick={() => void action(() => window.autoEdit.askAgent(project.id, agentText), setProject)}>Stage changes ↗</button></div>
          <div className="decision-bar">
            {!plan && !analysisActive && <button className="primary large" disabled={busy} onClick={() => void runAnalysis(analysisResumable)}>{analysisResumable ? 'Resume analysis' : 'Analyze video'}</button>}
            {analysisRun?.status === 'running' && <button className="ghost large stop-analysis" onClick={() => void stopAnalysis()}>Stop analysis</button>}
            {analysisRun?.status === 'stopping' && <button className="ghost large" disabled>Stopping safely…</button>}
            {project.acceptedPlan && !project.final && <button className="primary large" disabled={busy} onClick={() => void action(() => window.autoEdit.approve(project.id), setProject)}>Approve Final</button>}
            {project.final && <button className="primary large" disabled={busy} onClick={() => void action(() => window.autoEdit.render({ projectId: project.id }), setProject)}>Render MP4</button>}
            {project.outputAvailable && <button className="ghost large" onClick={() => void window.autoEdit.reveal(project.id)}>Reveal output</button>}
          </div>
        </section>
      </>}
    </main>
    {error && <div className="toast"><strong>Couldn’t continue</strong><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
    {busy && <div className="busy-dot" aria-label="Working" />}
  </div>;
}

function AnalysisMonitor({ project, run, onStop, onResume }: { project: PublicProject; run: AnalysisRun; onStop: () => void; onResume: () => void }) {
  const latest = run.events.at(-1);
  const overall = run.status === 'complete' ? 1 : latestOverallProgress(run);
  const elapsed = Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt);
  const statusCopy: Record<AnalysisRunStatus, string> = {
    running: 'Analysis in progress', stopping: 'Stopping safely', complete: 'Ready for review', cancelled: 'Analysis stopped', error: 'Analysis needs attention',
  };
  return <section className={`analysis-monitor ${run.status}`}>
    <header>
      <div><p className="eyebrow">ANALYSIS RUN</p><h3>{statusCopy[run.status]}</h3><p>{latest?.message ?? 'Preparing analysis…'}</p></div>
      <div className="analysis-metrics"><strong>{Math.round(overall * 100)}%</strong><span>{formatElapsed(elapsed)}</span></div>
    </header>
    <div className="analysis-overall"><div style={{ width: `${Math.round(overall * 100)}%` }} /></div>
    <div className="analysis-stage-list">{analysisStageOrder.map((stage, index) => {
      const snapshot = analysisStageSnapshot(project, run, stage);
      return <div className={`analysis-stage ${snapshot.state}`} key={stage}>
        <span className="analysis-stage-index">{snapshot.state === 'complete' ? '✓' : index + 1}</span>
        <div><strong>{analysisStageCopy[stage].label}</strong><small>{snapshot.message || analysisStageCopy[stage].detail}</small></div>
        <b>{snapshot.state === 'running' ? `${Math.round(snapshot.progress * 100)}%` : snapshot.state}</b>
      </div>;
    })}</div>
    <div className="analysis-log"><p className="eyebrow">RECENT ACTIVITY</p>{run.events.slice(-7).map((event, index) => <div key={`${event.receivedAt}-${index}`}>
      <time>+{formatElapsed(event.receivedAt - run.startedAt)}</time><span>{event.message}</span>
    </div>)}</div>
    <footer>
      <p>{analysisRunGuidance(run.status)}</p>
      {run.status === 'running' && <button className="stop-analysis" onClick={onStop}>Stop analysis</button>}
      {run.status === 'stopping' && <button disabled>Stopping…</button>}
      {(run.status === 'cancelled' || run.status === 'error') && <button onClick={onResume}>Resume from checkpoint</button>}
    </footer>
  </section>;
}

function isAnalysisProgress(event: ProgressEvent): boolean {
  return analysisStageOrder.includes(event.stage as AnalysisStage) || (event.stage === 'review' && event.state === 'complete' && /analysis complete/i.test(event.message));
}

function appendAnalysisProgress(current: AnalysisRun | null, event: AnalysisLogEvent): AnalysisRun {
  const run = current ?? { status: 'running', startedAt: event.receivedAt, events: [] };
  let status = run.status;
  if (event.state === 'cancelled') status = 'cancelled';
  else if (event.state === 'error') status = 'error';
  else if (event.stage === 'review' && event.state === 'complete') status = 'complete';
  else if (status !== 'stopping') status = 'running';
  const last = run.events.at(-1);
  const replaceLatest = last && last.stage === event.stage && last.state === 'running' && event.state === 'running' && event.receivedAt - last.receivedAt < 700;
  const events = (replaceLatest ? [...run.events.slice(0, -1), event] : [...run.events, event]).slice(-40);
  return { ...run, status, endedAt: ['complete', 'cancelled', 'error'].includes(status) ? event.receivedAt : undefined, events };
}

function analysisStageSnapshot(project: PublicProject, run: AnalysisRun, stage: AnalysisStage): { state: StageState; progress: number; message?: string } {
  const latest = run.events.filter(event => event.stage === stage).at(-1);
  if (latest) return { state: latest.state ?? 'running', progress: latest.progress, message: latest.message };
  const checkpoint = project.stages[stage];
  return { state: checkpoint.state, progress: checkpoint.state === 'complete' ? 1 : 0, message: checkpoint.message };
}

function latestAnalysisStage(run: AnalysisRun): AnalysisStage {
  const event = [...run.events].reverse().find(item => analysisStageOrder.includes(item.stage as AnalysisStage));
  return (event?.stage as AnalysisStage | undefined) ?? 'proxy';
}

function latestAnalysisProgress(run: AnalysisRun): number {
  const event = [...run.events].reverse().find(item => analysisStageOrder.includes(item.stage as AnalysisStage));
  return event?.progress ?? 0;
}

function latestOverallProgress(run: AnalysisRun): number {
  return [...run.events].reverse().find(item => item.overallProgress !== undefined)?.overallProgress ?? 0;
}

function analysisRunGuidance(status: AnalysisRunStatus): string {
  if (status === 'running') return 'You can stop safely at any time. Completed stages are cached, and Resume continues from the last checkpoint.';
  if (status === 'stopping') return 'The current FFmpeg, Whisper, or Codex task is shutting down. The monitor will confirm when it has stopped.';
  if (status === 'complete') return 'Analysis has ended and will not continue in the background. Inspect the AI Proposal below before accepting it.';
  if (status === 'cancelled') return 'Analysis is fully stopped. Resume reuses completed checkpoints instead of starting over.';
  return 'The current stage stopped with an error. Review the message above, then resume from the last completed checkpoint.';
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(totalSeconds / 60).toString().padStart(2, '0')}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
}

function AgentPicker({ project, models, busy, authenticated, statusError, onModel, onReasoning, onRetry }: {
  project: PublicProject; models: ModelItem[]; busy: boolean; authenticated: boolean;
  statusError?: string; onModel: (model: string) => void; onReasoning: (reasoning: Reasoning) => void; onRetry: () => void;
}) {
  const selected = models.find(model => model.id === project.settings.model);
  const supported = reasoningOptions.filter(reasoning => !selected?.supportedReasoning?.length || selected.supportedReasoning.includes(reasoning));
  return <details className="agent-picker">
    <summary><span className="agent-spark">✦</span><span><small>AI AGENT</small><strong>{selected?.displayName ?? project.settings.model}</strong></span><i className={authenticated ? 'online' : ''} /><b>⌄</b></summary>
    <div className="agent-menu">
      <div className="agent-menu-head"><span>Editorial agent</span><small><i className={authenticated ? 'online' : ''} />{authenticated ? 'Account catalog connected' : 'Codex unavailable'}</small></div>
      <label htmlFor="agent-model">Model</label>
      <select id="agent-model" disabled={busy || !models.length} value={project.settings.model} onChange={event => onModel(event.target.value)}>
        {!selected && <option value={project.settings.model}>{project.settings.model}</option>}
        {models.map(model => <option value={model.id} key={model.id}>{model.displayName}{model.isDefault ? ' · Default' : ''}</option>)}
      </select>
      <p>{selected?.description ?? 'Choose a model available to your signed-in Codex account.'}</p>
      <label>Reasoning effort</label>
      <div className="reasoning-grid">{supported.map(reasoning => <button type="button" disabled={busy} className={project.settings.reasoning === reasoning ? 'active' : ''} key={reasoning} onClick={() => onReasoning(reasoning)}>{reasoning}</button>)}</div>
      <footer title={statusError}><span>Applies to the next editorial, subtitle, or Ask Agent proposal.</span>{!authenticated && <button type="button" disabled={busy} onClick={onRetry}>Retry Codex</button>}</footer>
    </div>
  </details>;
}

function Check({ label, ok, hint }: { label: string; ok?: boolean; hint?: string }) { return <div className="check" title={hint}><span className={ok ? 'ok' : ''}>{ok ? '✓' : '·'}</span>{label}</div>; }
function EmptyState({ onImport }: { onImport: () => void }) { return <div className="empty-state"><div className="reel-icon">◫</div><p className="eyebrow">AUTOEDIT STUDIO</p><h1>Find the story.<br /><em>Keep your voice.</em></h1><p>Turn one local headtalk into a reviewed, bilingual vertical edit. Your footage never goes to the agent.</p><button className="primary large" onClick={onImport}>Import a video</button><small>MOV · MP4 · M4V · MKV</small></div>; }
