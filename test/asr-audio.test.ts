import { describe, expect, it } from 'vitest';
import { parsePcm16Wav } from '../src/core/asr';

function pcmWav(samples: number[], options: { channels?: number; sampleRate?: number; bits?: number } = {}): Buffer {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 16_000;
  const bits = options.bits ?? 16;
  const bytesPerSample = bits / 8;
  const output = Buffer.alloc(44 + samples.length * bytesPerSample);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22); output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  output.writeUInt16LE(channels * bytesPerSample, 32); output.writeUInt16LE(bits, 34);
  output.write('data', 36); output.writeUInt32LE(samples.length * bytesPerSample, 40);
  samples.forEach((sample, index) => output.writeInt16LE(sample, 44 + index * 2));
  return output;
}

describe('Whisper Node audio input', () => {
  it('decodes mono 16 kHz PCM samples into normalized Float32 audio', () => {
    const audio = parsePcm16Wav(pcmWav([-32768, -16384, 0, 16384, 32767]));
    expect(audio).toBeInstanceOf(Float32Array);
    expect([...audio]).toEqual([-1, -0.5, 0, 0.5, 32767 / 32768]);
  });

  it('rejects WAV input that does not match the FFmpeg cache contract', () => {
    expect(() => parsePcm16Wav(pcmWav([0], { channels: 2 }))).toThrow(/mono 16 kHz PCM 16-bit/);
    expect(() => parsePcm16Wav(Buffer.from('not a wav'))).toThrow(/valid RIFF\/WAVE/);
  });

  it('honours cancellation before allocating the transcription run', () => {
    const controller = new AbortController(); controller.abort();
    expect(() => parsePcm16Wav(pcmWav([0, 1]), controller.signal)).toThrowError(DOMException);
  });
});
