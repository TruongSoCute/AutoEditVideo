import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

type Level = 'info' | 'warn' | 'error';

export class AppLogger {
  readonly filePath: string;
  private queue = Promise.resolve();

  constructor(userDataPath: string) { this.filePath = path.join(userDataPath, 'logs', 'app.log'); }

  info(scope: string, message: string, details?: Record<string, unknown>): void { this.write('info', scope, message, details); }
  warn(scope: string, message: string, details?: Record<string, unknown>): void { this.write('warn', scope, message, details); }
  error(scope: string, message: string, details?: Record<string, unknown>): void { this.write('error', scope, message, details); }

  private write(level: Level, scope: string, message: string, details?: Record<string, unknown>): void {
    const entry = JSON.stringify({ at: new Date().toISOString(), level, scope: clean(scope, 80), message: clean(message, 600), details: sanitize(details) });
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      try { if ((await stat(this.filePath)).size > 2 * 1024 * 1024) await rename(this.filePath, `${this.filePath}.1`); } catch { /* first log write */ }
      await appendFile(this.filePath, `${entry}\n`, 'utf8');
    }).catch(() => undefined);
  }
}

function clean(value: unknown, limit: number): string { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit); }
function sanitize(details?: Record<string, unknown>): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(Object.entries(details).slice(0, 20).map(([key, value]) => {
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [clean(key, 60), value];
    return [clean(key, 60), clean(value, 300)];
  }));
}

