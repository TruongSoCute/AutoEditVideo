import { createHash } from 'node:crypto';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFfmpegProgressParser, fingerprintSource, parseProbe, visualFilter } from '../src/core/media';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(item => rm(item, { recursive: true, force: true }))); });

describe('media inspection', () => {
  it('detects rotation, HLG and Dolby Vision evidence', () => {
    const info = parseProbe({ format: { duration: '359.35' }, streams: [
      { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '30/1', color_primaries: 'bt2020', color_transfer: 'arib-std-b67', tags: { rotate: '90' }, side_data_list: [{ side_data_type: 'DOVI configuration record' }] },
      { codec_type: 'audio', codec_name: 'aac' },
    ] });
    expect(info.rotation).toBe(90); expect(info.hdr).toBe(true); expect(info.dolbyVision).toBe(true); expect(info.hasAudio).toBe(true);
    expect(visualFilter(info, 720, 1280)).toContain('transpose=clock'); expect(visualFilter(info, 720, 1280)).toContain('tonemap');
  });
  it('fingerprints file content and metadata deterministically', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'autoedit-media-')); temporary.push(dir);
    const file = path.join(dir, 'clip.mov'); await writeFile(file, Buffer.alloc(2_200_000, 7));
    const first = await fingerprintSource(file); const second = await fingerprintSource(file);
    expect(first.fingerprint).toBe(second.fingerprint); expect(first.displayName).toBe('clip.mov');
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await utimes(file, new Date(), new Date(Date.now() + 10_000));
    expect((await fingerprintSource(file)).fingerprint).toBe(first.fingerprint);
  });
  it('parses streaming FFmpeg progress across split chunks', () => {
    const samples: number[] = [];
    const parse = createFfmpegProgressParser(10, ratio => samples.push(ratio));
    parse('progress=continue\nout_time_us=2500');
    parse('000\nframe=30\nout_time_ms=9000000\n');
    expect(samples).toEqual([0.25, 0.9]);
  });
});
