import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MediaInfo, SourceReference } from '../shared/types.js';
import { requireSuccessful } from './process.js';

const SUPPORTED_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v', '.mkv']);

export function assertSupportedMedia(filePath: string): void {
  if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('Choose a .mov, .mp4, .m4v or .mkv video.');
}

async function hashSlice(filePath: string, start: number, end: number, hash: ReturnType<typeof createHash>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { start, end });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

export async function fingerprintSource(filePath: string): Promise<SourceReference> {
  assertSupportedMedia(filePath);
  const info = await stat(filePath);
  const hash = createHash('sha256');
  hash.update(`${info.size}:`);
  const window = Math.min(1024 * 1024, info.size);
  if (window) {
    await hashSlice(filePath, 0, window - 1, hash);
    if (info.size > window) await hashSlice(filePath, info.size - window, info.size - 1, hash);
  }
  return { path: filePath, displayName: path.basename(filePath), fingerprint: hash.digest('hex'), size: info.size, modifiedAt: info.mtimeMs, missing: false };
}

interface ProbeStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string;
  avg_frame_rate?: string; r_frame_rate?: string; color_primaries?: string; color_transfer?: string; color_space?: string;
  tags?: Record<string, string>; side_data_list?: Array<Record<string, unknown>>;
}

function rational(value?: string): number {
  if (!value) return 0;
  const [a, b = 1] = value.split('/').map(Number);
  return b ? a / b : 0;
}

export function parseProbe(payload: { streams?: ProbeStream[]; format?: { duration?: string } }): MediaInfo {
  const video = payload.streams?.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('No video stream found.');
  const audio = payload.streams?.find(stream => stream.codec_type === 'audio');
  const sideData = video.side_data_list ?? [];
  const rotationValue = sideData.find(item => item.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0;
  const rotation = ((Math.round(Number(rotationValue) || 0) % 360) + 360) % 360;
  const transfer = video.color_transfer?.toLowerCase();
  const primaries = video.color_primaries?.toLowerCase();
  const dolbyVision = sideData.some(item => JSON.stringify(item).toLowerCase().includes('dovi'));
  const hdr = dolbyVision || primaries === 'bt2020' || ['arib-std-b67', 'smpte2084'].includes(transfer ?? '');
  return {
    duration: Number(video.duration ?? payload.format?.duration ?? 0), width: video.width ?? 0, height: video.height ?? 0,
    fps: rational(video.avg_frame_rate || video.r_frame_rate), videoCodec: video.codec_name ?? 'unknown', audioCodec: audio?.codec_name,
    hasAudio: Boolean(audio), rotation, colorPrimaries: video.color_primaries, colorTransfer: video.color_transfer,
    colorSpace: video.color_space, dolbyVision, hdr,
  };
}

export async function probeMedia(ffprobePath: string, filePath: string): Promise<MediaInfo> {
  const result = await requireSuccessful(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath]);
  return parseProbe(JSON.parse(result.stdout));
}

export function visualFilter(media: MediaInfo, width: number, height: number): string {
  const filters: string[] = [];
  if (media.rotation === 90) filters.push('transpose=clock');
  else if (media.rotation === 270) filters.push('transpose=cclock');
  else if (media.rotation === 180) filters.push('hflip,vflip');
  if (media.hdr) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'tonemap=tonemap=hable:desat=0', 'zscale=p=bt709:t=bt709:m=bt709:r=tv', 'format=yuv420p');
  filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, 'setsar=1');
  return filters.join(',');
}

export async function createProxy(args: {
  ffmpegPath: string; source: string; target: string; media: MediaInfo; signal?: AbortSignal; onProgress?: (ratio: number) => void;
}): Promise<void> {
  await mkdir(path.dirname(args.target), { recursive: true });
  const result = await requireSuccessful(args.ffmpegPath, [
    '-hide_banner', '-y', '-noautorotate', '-i', args.source, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', visualFilter(args.media, 720, 1280), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', args.target,
  ], { signal: args.signal });
  for (const match of result.stdout.matchAll(/out_time_ms=(\d+)/g)) args.onProgress?.(Math.min(1, Number(match[1]) / 1_000_000 / args.media.duration));
}

export async function extractPcm(ffmpegPath: string, source: string, target: string, signal?: AbortSignal): Promise<void> {
  await requireSuccessful(ffmpegPath, ['-hide_banner', '-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', target], { signal });
}

export async function extractEvidenceFrames(ffmpegPath: string, proxyPath: string, targetDir: string, duration: number, signal?: AbortSignal): Promise<string[]> {
  await mkdir(targetDir, { recursive: true });
  const timestamps = [0.12, 0.32, 0.52, 0.72, 0.9].map(ratio => Math.max(0, duration * ratio));
  const paths: string[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const target = path.join(targetDir, `evidence-${i + 1}.jpg`);
    await requireSuccessful(ffmpegPath, ['-hide_banner', '-y', '-ss', timestamps[i].toFixed(3), '-i', proxyPath, '-frames:v', '1', '-q:v', '3', target], { signal });
    paths.push(target);
  }
  return paths;
}
