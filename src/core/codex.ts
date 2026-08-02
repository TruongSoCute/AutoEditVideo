import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ModelItem } from '../shared/types.js';
import { requireSuccessful, runProcess } from './process.js';

export interface CodexRunOptions<T> {
  prompt: string;
  schema: Record<string, unknown>;
  model: string;
  reasoning: string;
  images?: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

interface CodexInvocation { command: string; prefix: string[]; env: NodeJS.ProcessEnv }
const MODEL_CACHE_TTL_MS = 30_000;
let modelCache: { expiresAt: number; models: ModelItem[] } | undefined;
let modelRequest: Promise<ModelItem[]> | undefined;

export function codexProcessEnvironment(electronRuntime: boolean, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, NO_COLOR: '1' };
  if (electronRuntime) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function codexInvocation(): Promise<CodexInvocation> {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const entry = path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
      await readFile(entry);
      return { command: process.execPath, prefix: [entry], env: codexProcessEnvironment(Boolean(process.versions.electron)) };
    } catch { /* use a native executable */ }
  }
  return { command: process.platform === 'win32' ? 'codex.exe' : 'codex', prefix: [], env: codexProcessEnvironment(false) };
}

export async function codexVersion(): Promise<string> {
  const invocation = await codexInvocation();
  return (await requireSuccessful(invocation.command, [...invocation.prefix, '--version'], { env: invocation.env })).stdout.trim();
}

function parseModelList(value: unknown): ModelItem[] {
  const root = value as { result?: { data?: unknown[] }; data?: unknown[] };
  const data = root.result?.data ?? root.data ?? [];
  return data.flatMap(item => {
    const model = item as Record<string, unknown>;
    const id = String(model.id ?? model.model ?? model.slug ?? '');
    if (!id) return [];
    const efforts = (model.supportedReasoningEfforts as Array<Record<string, unknown>> | undefined)?.map(item => String(item.reasoningEffort)).filter(Boolean);
    return [{ id, displayName: String(model.display_name ?? model.displayName ?? id), description: model.description ? String(model.description) : undefined,
      defaultReasoning: model.default_reasoning_level ? String(model.default_reasoning_level) : model.defaultReasoningEffort ? String(model.defaultReasoningEffort) : undefined,
      supportedReasoning: efforts, isDefault: model.isDefault === true }];
  });
}

async function requestCodexModels(signal?: AbortSignal): Promise<ModelItem[]> {
  const invocation = await codexInvocation();
  return await new Promise<ModelItem[]>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefix, 'app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: invocation.env });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    let stderr = '';
    const finish = (error?: Error, models?: ModelItem[]) => {
      if (settled) return;
      settled = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      if (error) reject(error); else resolve(models ?? []);
    };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish(new Error('Timed out while reading the Codex model catalog.')), 15_000);
    signal?.addEventListener('abort', () => finish(new DOMException('Operation cancelled', 'AbortError')), { once: true });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString()}`.slice(-2000); });
    child.on('error', finish);
    child.on('close', code => { if (!settled) finish(new Error(`Codex app-server stopped early (${code}). ${stderr}`)); });
    lines.on('line', line => {
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (message.id === 0) {
          if (message.error) return finish(new Error(`Codex initialization failed: ${JSON.stringify(message.error)}`));
          send({ method: 'initialized', params: {} });
          send({ method: 'model/list', id: 1, params: { limit: 100, includeHidden: false } });
        } else if (message.id === 1) {
          if (message.error) return finish(new Error(`Codex model catalog failed: ${JSON.stringify(message.error)}`));
          const models = parseModelList({ result: message.result });
          if (!models.length) return finish(new Error('Codex returned an empty model catalog. Sign in with the Codex CLI and try again.'));
          finish(undefined, models);
        }
      } catch { /* non-protocol output is ignored */ }
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'auto_edit_studio', title: 'AutoEdit Studio', version: '0.1.0' } } });
  });
}

export async function listCodexModels(signal?: AbortSignal): Promise<ModelItem[]> {
  if (!signal && modelCache && modelCache.expiresAt > Date.now()) return modelCache.models.map(model => ({ ...model }));
  if (!signal && modelRequest) return await modelRequest;
  const request = requestCodexModels(signal).then(models => {
    if (!signal) modelCache = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models };
    return models;
  });
  if (signal) return await request;
  modelRequest = request.finally(() => { modelRequest = undefined; });
  return await modelRequest;
}

export async function runCodexStructured<T>(options: CodexRunOptions<T>): Promise<T> {
  const work = await mkdtemp(path.join(tmpdir(), 'autoedit-codex-'));
  const schemaPath = path.join(work, 'schema.json');
  const outputPath = path.join(work, 'result.json');
  try {
    await writeFile(schemaPath, JSON.stringify(options.schema), 'utf8');
    const invocation = await codexInvocation();
    const args = [...invocation.prefix, 'exec', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '--color', 'never', '--json', '--model', options.model,
      '-c', `model_reasoning_effort=${JSON.stringify(options.reasoning)}`];
    for (const feature of ['shell_tool', 'apps', 'browser_use', 'computer_use', 'plugins', 'multi_agent']) args.push('--disable', feature);
    args.push('--ephemeral', '--output-schema', schemaPath, '--output-last-message', outputPath);
    for (const image of options.images ?? []) args.push('--image', image);
    args.push('-');
    let buffered = '';
    const result = await runProcess(invocation.command, args, {
      cwd: work, env: invocation.env, input: options.prompt, signal: options.signal,
      onOutput: chunk => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/); buffered = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as { type?: string; item?: { text?: string } };
            if (event.type) options.onProgress?.(event.item?.text ?? event.type.replaceAll('.', ' '));
          } catch { /* stderr and partial output are intentionally ignored */ }
        }
      },
    });
    if (result.code !== 0) throw new Error(classifyCodexError(result.stderr || result.stdout));
    return JSON.parse(await readFile(outputPath, 'utf8')) as T;
  } finally { await rm(work, { recursive: true, force: true }); }
}

export function classifyCodexError(raw: string): string {
  const message = raw.replaceAll(/(?:[A-Z]:\\|\/)[^\s"']+/g, '<path>').slice(-1200).trim();
  if (/login|auth|unauthorized|401/i.test(message)) return 'Codex is not signed in. Run `codex login` and retry.';
  if (/model.*not|unsupported.*model/i.test(message)) return 'The selected Codex model is unavailable for this account.';
  if (/schema|json/i.test(message)) return `Codex returned data that did not match the required schema. ${message}`;
  return `Codex analysis failed. ${message || 'No details were provided.'}`;
}
