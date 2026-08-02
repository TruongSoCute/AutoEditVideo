import { readFile } from 'node:fs/promises';
import type { TranscriptCue } from '../shared/types.js';

interface WhisperChunk { timestamp: [number, number | null]; text: string }
interface WhisperOutput { text?: string; chunks?: WhisperChunk[] }

export async function transcribeLocal(audioPath: string, cacheDir: string, sourceDuration: number, signal?: AbortSignal, onProgress?: (ratio: number, message: string) => void): Promise<TranscriptCue[]> {
  if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
  const transformers = await import('@huggingface/transformers') as unknown as {
    env: { cacheDir: string; allowRemoteModels: boolean };
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<(input: Float32Array, options: Record<string, unknown>) => Promise<WhisperOutput>>;
  };
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowRemoteModels = true;
  onProgress?.(0.1, 'Loading the local Whisper model…');
  const whisper = await transformers.pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
    device: 'cpu', dtype: 'q8', progress_callback: (item: unknown) => {
      if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
      const update = item as { status?: string; progress?: number };
      const rawProgress = Number(update.progress);
      const ratio = Number.isFinite(rawProgress) ? Math.min(1, Math.max(0, rawProgress > 1 ? rawProgress / 100 : rawProgress)) : 0;
      onProgress?.(0.1 + ratio * 0.25, update.status === 'progress' ? `Preparing Whisper model ${Math.round(ratio * 100)}%` : 'Preparing the local Whisper model…');
    },
  });
  onProgress?.(0.37, 'Loading mono 16 kHz audio samples for Whisper…');
  const audio = parsePcm16Wav(await readFile(audioPath), signal);
  onProgress?.(0.4, `Whisper is transcribing ${(audio.length / 16_000).toFixed(1)} seconds of speech on CPU…`);
  const result = await whisper(audio, { language: 'english', task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
  const chunks = result.chunks ?? [];
  const cues = chunks.flatMap((chunk, index) => {
    const text = chunk.text.trim();
    const start = Number(chunk.timestamp[0]);
    const end = Number(chunk.timestamp[1] ?? start + Math.max(0.5, text.split(/\s+/).length / 2.5));
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{ id: `cue-${index + 1}`, start, end, rawAsr: text, english: text, vietnamese: '', provenance: 'asr' as const }];
  });
  const normalized = normalizeTranscriptCues(cues, sourceDuration);
  onProgress?.(0.95, `Whisper produced ${normalized.length} timestamped cues.`);
  return normalized;
}

export function normalizeTranscriptCues(cues: TranscriptCue[], sourceDuration: number): TranscriptCue[] {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('Cannot normalize transcript without a valid source duration.');
  let previousEnd = 0;
  return cues.flatMap(cue => {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end)) return [];
    const start = Math.max(previousEnd, Math.max(0, Math.min(sourceDuration, cue.start)));
    const end = Math.max(0, Math.min(sourceDuration, cue.end));
    if (end <= start) return [];
    previousEnd = end;
    return [{ ...cue, start, end }];
  });
}

export function parsePcm16Wav(buffer: Uint8Array, signal?: AbortSignal): Float32Array {
  if (buffer.byteLength < 12 || ascii(buffer, 0, 4) !== 'RIFF' || ascii(buffer, 8, 12) !== 'WAVE') {
    throw new Error('Whisper audio cache is not a valid RIFF/WAVE file. Resume analysis to regenerate it.');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 12;
  let format: { codec: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.byteLength) {
    const id = ascii(buffer, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > buffer.byteLength) throw new Error(`Whisper audio cache contains a truncated ${id || 'unknown'} chunk.`);
    if (id === 'fmt ' && size >= 16) {
      format = {
        codec: view.getUint16(body, true), channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true), bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || dataOffset < 0) throw new Error('Whisper audio cache is missing WAV format or sample data.');
  if (format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16_000 || format.bitsPerSample !== 16) {
    throw new Error(`Whisper requires mono 16 kHz PCM 16-bit WAV; received codec ${format.codec}, ${format.channels} channel(s), ${format.sampleRate} Hz, ${format.bitsPerSample}-bit.`);
  }
  if (dataLength % 2) throw new Error('Whisper audio cache contains an incomplete PCM sample.');
  const samples = new Float32Array(dataLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    if ((index & 0x3fff) === 0 && signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
    samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768;
  }
  return samples;
}

function ascii(buffer: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...buffer.subarray(start, end));
}
