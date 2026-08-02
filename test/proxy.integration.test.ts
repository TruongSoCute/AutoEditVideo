import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, probeMedia } from '../src/core/media';

const exec = promisify(execFile);
let dir = '';
let source = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'autoedit-proxy-')); source = path.join(dir, 'source.mp4');
  await exec('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe('proxy integration', () => {
  it('creates a timeline-preserving H.264/AAC portrait proxy', async () => {
    const media = await probeMedia('ffprobe', source); const target = path.join(dir, 'proxy.mp4');
    await createProxy({ ffmpegPath: 'ffmpeg', source, target, media }); await access(target);
    const proxy = await probeMedia('ffprobe', target);
    expect(proxy.videoCodec).toBe('h264'); expect(proxy.audioCodec).toBe('aac'); expect(proxy.width).toBe(720); expect(proxy.height).toBe(1280); expect(proxy.duration).toBeCloseTo(2, 0);
  }, 30_000);
});
