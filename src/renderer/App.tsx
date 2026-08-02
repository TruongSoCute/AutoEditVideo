import { useEffect, useMemo, useState } from 'react';
import type { DependencyStatus, EditSegment, ModelItem, ProgressEvent, PublicProject, SubtitleCue } from '../shared/types';

const steps = ['Import', 'Proxy', 'Transcript', 'Editorial', 'Subtitles', 'Review', 'Final', 'Render'];
const reasoningOptions = ['low', 'medium', 'high', 'xhigh'] as const;
type Reasoning = typeof reasoningOptions[number];

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
  const plan = project?.pendingProposal?.plan ?? project?.acceptedPlan ?? project?.final?.plan;
  const previewUrl = project?.proxyUrl ?? project?.previewUrl;

  useEffect(() => window.autoEdit.onProgress(setProgress), []);
  useEffect(() => {
    void refreshStatus();
    void window.autoEdit.listModels().then(setModels).catch(reason => {
      setModels([]);
      window.autoEdit.log({ level: 'warn', scope: 'renderer', message: 'Model catalog unavailable', details: { message: reason instanceof Error ? reason.message : String(reason) } });
    });
  }, [project?.id]);
  useEffect(() => { setPreviewError(''); setPreviewReady(false); }, [previewUrl]);

  async function action<T>(task: () => Promise<T>, apply?: (value: T) => void) {
    setBusy(true); setError('');
    try { const value = await task(); apply?.(value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function refreshStatus() { try { setStatus(await window.autoEdit.systemStatus(project?.id)); } catch { setStatus(null); } }
  const setMaybeProject = (value: PublicProject | null) => { if (value) setProject(value); };
  const totalDuration = useMemo(() => plan?.segments.reduce((sum, item) => sum + item.sourceEnd - item.sourceStart, 0) ?? 0, [plan]);

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

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">A</span><div><strong>AutoEdit</strong><small>STUDIO</small></div></div>
      <div className="project-title">{project ? project.name : 'A quiet workspace for sharp stories'}</div>
      {project && <AgentPicker project={project} models={models} busy={busy} authenticated={status?.codex.authenticated === true}
        onModel={model => void action(() => window.autoEdit.updateModel(project.id, model, project.settings.reasoning), setProject)}
        onReasoning={reasoning => void action(() => window.autoEdit.updateModel(project.id, project.settings.model, reasoning), setProject)} />}
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
        <Check label="Codex CLI" ok={status?.codex.authenticated} />
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
              {previewError && <div className="preview-failure"><strong>Preview unavailable</strong><p>{previewError}</p>{!project.proxyUrl && <button onClick={() => void action(() => window.autoEdit.startAnalysis(project.id), setProject)}>Create compatible proxy</button>}</div>}
            </div>
            {plan?.subtitles[0] && previewReady && <div className="subtitle-sample"><strong>{plan.subtitles[0].english}</strong><span>{plan.subtitles[0].vietnamese}</span></div>}
          </div>
          {progress && <div className="progress"><div style={{ width: `${Math.round(progress.progress * 100)}%` }} /><span>{progress.message}</span></div>}
          <div className="transport"><span className="preview-health"><i className={previewReady ? 'ready' : ''} />{previewReady ? 'Preview ready' : 'Preparing preview'}</span><span>{project.media.width}×{project.media.height} · {project.media.videoCodec.toUpperCase()} {project.media.hdr ? '· HDR source' : ''}</span></div>
        </section>

        <section className="editor-panel">
          <div className="tabs"><button className="active">Edit plan</button><button>Transcript</button><button>Subtitles</button></div>
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
            {!plan && <button className="primary large" disabled={busy} onClick={() => void action(() => window.autoEdit.startAnalysis(project.id), setProject)}>Analyze video</button>}
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

function AgentPicker({ project, models, busy, authenticated, onModel, onReasoning }: {
  project: PublicProject; models: ModelItem[]; busy: boolean; authenticated: boolean;
  onModel: (model: string) => void; onReasoning: (reasoning: Reasoning) => void;
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
      <footer>Applies to the next editorial, subtitle, or Ask Agent proposal.</footer>
    </div>
  </details>;
}

function Check({ label, ok }: { label: string; ok?: boolean }) { return <div className="check"><span className={ok ? 'ok' : ''}>{ok ? '✓' : '·'}</span>{label}</div>; }
function EmptyState({ onImport }: { onImport: () => void }) { return <div className="empty-state"><div className="reel-icon">◫</div><p className="eyebrow">AUTOEDIT STUDIO</p><h1>Find the story.<br /><em>Keep your voice.</em></h1><p>Turn one local headtalk into a reviewed, bilingual vertical edit. Your footage never goes to the agent.</p><button className="primary large" onClick={onImport}>Import a video</button><small>MOV · MP4 · M4V · MKV</small></div>; }
