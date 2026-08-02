import type { TranscriptCue } from '../shared/types.js';

interface WhisperChunk { timestamp: [number, number | null]; text: string }
interface WhisperOutput { text?: string; chunks?: WhisperChunk[] }

export async function transcribeLocal(audioPath: string, cacheDir: string, signal?: AbortSignal): Promise<TranscriptCue[]> {
  if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError');
  const transformers = await import('@huggingface/transformers') as unknown as {
    env: { cacheDir: string; allowRemoteModels: boolean };
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<(input: string, options: Record<string, unknown>) => Promise<WhisperOutput>>;
  };
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowRemoteModels = true;
  const whisper = await transformers.pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
    device: 'cpu', dtype: 'q8', progress_callback: () => { if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError'); },
  });
  const result = await whisper(audioPath, { language: 'english', task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
  const chunks = result.chunks ?? [];
  return chunks.flatMap((chunk, index) => {
    const text = chunk.text.trim();
    const start = Number(chunk.timestamp[0]);
    const end = Number(chunk.timestamp[1] ?? start + Math.max(0.5, text.split(/\s+/).length / 2.5));
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{ id: `cue-${index + 1}`, start, end, rawAsr: text, english: text, vietnamese: '', provenance: 'asr' as const }];
  });
}

