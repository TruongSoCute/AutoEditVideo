export interface ByteRange {
  start: number;
  end: number;
  length: number;
}

export class RangeNotSatisfiableError extends Error {}

export function parseByteRange(header: string | null, size: number): ByteRange | null {
  if (!header) return null;
  if (!Number.isSafeInteger(size) || size <= 0) throw new RangeNotSatisfiableError('Media size is invalid.');
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw new RangeNotSatisfiableError('Only one byte range is supported.');

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new RangeNotSatisfiableError('Invalid suffix range.');
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      throw new RangeNotSatisfiableError('Requested range is outside the media file.');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

