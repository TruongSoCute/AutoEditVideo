import type { TranscriptCue } from '../shared/types.js';

interface WhisperChunk { timestamp: [number, number | null]; text: string }
interface WhisperOutput { text?: string; chunks?: WhisperChunk[] }

export async function transcribeLocal(audioPath: string, cacheDir: string, signal?: AbortSignal, onProgress?: (ratio: number, message: string) => void): Promise<TranscriptCue[]> {
  if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
  const transformers = await import('@huggingface/transformers') as unknown as {
    env: { cacheDir: string; allowRemoteModels: boolean };
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<(input: string, options: Record<string, unknown>) => Promise<WhisperOutput>>;
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
  onProgress?.(0.4, 'Whisper is transcribing speech on CPU…');
  const result = await whisper(audioPath, { language: 'english', task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
  const chunks = result.chunks ?? [];
  const cues = chunks.flatMap((chunk, index) => {
    const text = chunk.text.trim();
    const start = Number(chunk.timestamp[0]);
    const end = Number(chunk.timestamp[1] ?? start + Math.max(0.5, text.split(/\s+/).length / 2.5));
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{ id: `cue-${index + 1}`, start, end, rawAsr: text, english: text, vietnamese: '', provenance: 'asr' as const }];
  });
  onProgress?.(0.95, `Whisper produced ${cues.length} timestamped cues.`);
  return cues;
}
