import { access, copyFile, mkdir, mkdtemp, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EditPlan, MediaInfo, ProgressEvent, ProjectDocument, SubtitleCue } from '../shared/types.js';
import { requireSuccessful } from './process.js';
import { verifySource } from './project-store.js';
import { validateEditPlan } from './validators.js';

type Progress = (event: ProgressEvent) => void;

function assTime(seconds: number): string {
  const value = Math.max(0, seconds);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  const cs = Math.floor((value - Math.floor(value)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assEscape(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}').replaceAll(/\r?\n/g, '\\N'); }

export function mapSourceToOutput(plan: EditPlan, time: number): number | undefined {
  let cursor = 0;
  for (const segment of plan.segments) {
    if (time >= segment.sourceStart - 0.001 && time <= segment.sourceEnd + 0.001) return cursor + Math.max(0, time - segment.sourceStart);
    cursor += segment.sourceEnd - segment.sourceStart;
  }
  return undefined;
}

export function createAss(plan: EditPlan): string {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: English,Satoshi,68,&H00FFFFFF,&H00FFFFFF,&H90000000,&H60000000,-1,0,0,0,100,100,0,0,1,3,2,2,72,72,685,1\nStyle: Vietnamese,Be Vietnam Pro SemiBold,48,&H0000E7FF,&H0000E7FF,&H90000000,&H60000000,0,0,0,0,100,100,0,0,1,3,2,2,72,72,565,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events: string[] = [];
  for (const subtitle of plan.subtitles) {
    const start = mapSourceToOutput(plan, subtitle.sourceStart);
    const end = mapSourceToOutput(plan, subtitle.sourceEnd);
    if (start === undefined || end === undefined || end <= start) continue;
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},English,,0,0,0,,${assEscape(subtitle.english)}`);
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Vietnamese,,0,0,0,,${assEscape(subtitle.vietnamese)}`);
  }
  return header + events.join('\n') + '\n';
}

function escapeFilterPath(filePath: string): string { return filePath.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'"); }

export function buildFilterGraph(plan: EditPlan, media: MediaInfo, assPath: string, fontsDir: string): string {
  const parts: string[] = [];
  const concatInputs: string[] = [];
  plan.segments.forEach((segment, index) => {
    const base = media.rotation === 90 ? 'transpose=clock,' : media.rotation === 270 ? 'transpose=cclock,' : media.rotation === 180 ? 'hflip,vflip,' : '';
    const hdr = media.hdr ? 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p,' : '';
    const offset = Math.max(-1, Math.min(1, segment.framingOffset));
    const scale = segment.motion === 'punch-in'
      ? `scale=1134:2016:force_original_aspect_ratio=increase,crop=1134:2016:x='(iw-ow)/2+${offset}*(iw-ow)/2',crop=1080:1920,`
      : `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:x='(iw-ow)/2+${offset}*(iw-ow)/2',`;
    const slow = segment.motion === 'slow-zoom' ? `zoompan=z='min(zoom+0.0005,1.08)':d=1:s=1080x1920:fps=30,` : '';
    parts.push(`[0:v]trim=start=${segment.sourceStart}:end=${segment.sourceEnd},setpts=PTS-STARTPTS,${base}${hdr}${scale}${slow}fps=30,format=yuv420p[v${index}]`);
    parts.push(`[0:a]atrim=start=${segment.sourceStart}:end=${segment.sourceEnd},asetpts=PTS-STARTPTS[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  });
  parts.push(`${concatInputs.join('')}concat=n=${plan.segments.length}:v=1:a=1[vcat][acat]`);
  parts.push(`[vcat]subtitles='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}'[vout]`);
  if (plan.voiceCleanup) parts.push('[acat]highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:LRA=7:TP=-1.5[aout]');
  else parts.push('[acat]anull[aout]');
  return parts.join(';');
}

export async function verifyRenderedMedia(ffprobePath: string, outputPath: string, expectedDuration: number): Promise<void> {
  const result = await requireSuccessful(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath]);
  const data = JSON.parse(result.stdout) as { streams: Array<Record<string, unknown>>; format: { duration?: string } };
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  const duration = Number(data.format.duration ?? 0);
  if (video?.codec_name !== 'h264' || video.width !== 1080 || video.height !== 1920) throw new Error('Rendered video failed H.264 1080×1920 verification.');
  if (audio?.codec_name !== 'aac') throw new Error('Rendered video failed AAC audio verification.');
  if (duration > 120.1 || Math.abs(duration - expectedDuration) > 1.5) throw new Error('Rendered duration differs from the approved edit.');
}

export class RenderPipeline {
  private controllers = new Map<string, AbortController>();
  constructor(private progress: Progress, private bundledFontDir: string) {}
  cancel(projectId: string): void { this.controllers.get(projectId)?.abort(); }

  async run(project: ProjectDocument, outputPath: string): Promise<void> {
    if (!project.final || project.final.sourceFingerprint !== project.source.fingerprint) throw new Error('Approve a valid Final revision before rendering.');
    if (!project.settings.satoshiFontPath || !(await exists(project.settings.satoshiFontPath))) throw new Error('Satoshi Bold is missing. Select a licensed local font file before rendering.');
    if (path.resolve(outputPath).toLowerCase() === path.resolve(project.source.path).toLowerCase()) throw new Error('The render cannot overwrite the source file.');
    if (await exists(outputPath)) throw new Error('The chosen output already exists. Choose another filename.');
    const disk = await statfs(path.dirname(outputPath));
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    if (freeBytes < 1024 * 1024 * 1024) throw new Error('At least 1 GB of free disk space is required to render safely.');
    await verifySource(project.source);
    validateEditPlan(project.final.plan, project.media);
    const controller = new AbortController();
    this.controllers.set(project.id, controller);
    const workDir = await mkdtemp(path.join(tmpdir(), 'autoedit-render-'));
    const partial = path.join(path.dirname(outputPath), `${path.parse(outputPath).name}.partial.mp4`);
    const assPath = path.join(workDir, 'subtitles.ass');
    const fontDir = path.join(workDir, 'fonts');
    try {
      await mkdir(fontDir, { recursive: true });
      await copyFile(project.settings.satoshiFontPath, path.join(fontDir, path.basename(project.settings.satoshiFontPath)));
      await copyFile(path.join(this.bundledFontDir, 'BeVietnamPro-SemiBold.ttf'), path.join(fontDir, 'BeVietnamPro-SemiBold.ttf'));
      await writeFile(assPath, createAss(project.final.plan), 'utf8');
      const graph = buildFilterGraph(project.final.plan, project.media, assPath, fontDir);
      project.stages.render = { state: 'running', updatedAt: new Date().toISOString(), message: 'Rendering Final…' };
      const result = await requireSuccessful(project.settings.ffmpegPath, ['-hide_banner', '-y', '-noautorotate', '-i', project.source.path, '-filter_complex', graph,
        '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-r', '30', '-vsync', 'cfr', '-metadata:s:v:0', 'rotate=0', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', partial], { signal: controller.signal });
      for (const match of result.stdout.matchAll(/out_time_ms=(\d+)/g)) {
        const ratio = Math.min(1, Number(match[1]) / 1_000_000 / project.final.plan.targetDuration);
        this.progress({ projectId: project.id, stage: 'render', progress: ratio, message: `Rendering ${Math.round(ratio * 100)}%` });
      }
      await verifyRenderedMedia(project.settings.ffprobePath, partial, project.final.plan.targetDuration);
      await rename(partial, outputPath);
      project.outputPath = outputPath;
      project.stages.render = { state: 'complete', updatedAt: new Date().toISOString(), message: 'Render verified.' };
      this.progress({ projectId: project.id, stage: 'render', progress: 1, message: 'Render complete' });
    } catch (error) {
      project.stages.render = { state: controller.signal.aborted ? 'cancelled' : 'error', updatedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      this.controllers.delete(project.id);
      if (await exists(partial)) await unlink(partial).catch(() => undefined);
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function exists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }
