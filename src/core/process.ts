import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

export interface ProcessResult { code: number; stdout: string; stderr: string }
export type OutputHandler = (chunk: string) => void;

export function hiddenSpawnOptions(options: SpawnOptionsWithoutStdio = {}): SpawnOptionsWithoutStdio & { stdio: 'pipe' } {
  return { ...options, shell: false, detached: false, windowsHide: true, stdio: 'pipe' };
}

export function spawnHidden(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  return spawn(command, args, hiddenSpawnOptions(options));
}

export async function runProcess(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { input?: string; signal?: AbortSignal; onOutput?: OutputHandler } = {},
): Promise<ProcessResult> {
  const { input, signal, onOutput, ...spawnOptions } = options;
  return await new Promise((resolve, reject) => {
    const child = spawnHidden(command, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { const value = chunk.toString(); stdout += value; onOutput?.(value); });
    child.stderr.on('data', chunk => { const value = chunk.toString(); stderr += value; onOutput?.(value); });
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new DOMException('Operation cancelled', 'AbortError'));
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export async function requireSuccessful(command: string, args: string[], options: Parameters<typeof runProcess>[2] = {}): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  return result;
}
