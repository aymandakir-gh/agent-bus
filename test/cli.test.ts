import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'src', 'cli', 'cli.ts');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-bus-cli-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function cli(...args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--import', 'tsx', CLI, '--dir', dir, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('cli: end-to-end over a folder', () => {
  it('init creates a bus directory', () => {
    const r = cli('init');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('initialized bus');
  });

  it('runs a full task lifecycle', () => {
    const create = cli('create-task', '--title', 'Write tests', '--agent', 'lead', '--task', 't1');
    expect(create.status).toBe(0);

    const tasks = JSON.parse(cli('tasks', '--json').stdout);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 't1', state: 'open' });

    const claim = cli('claim', 't1', '--agent', 'worker-1');
    expect(claim.status).toBe(0);
    expect(claim.stdout).toContain('claimed t1');

    const complete = cli('complete', 't1', '--agent', 'worker-1', '--result', '{"ok":true}');
    expect(complete.status).toBe(0);

    const done = JSON.parse(cli('tasks', '--json').stdout);
    expect(done[0]).toMatchObject({ state: 'done', result: { ok: true } });
  });

  it('claim exits 1 when the race is lost', () => {
    cli('create-task', '--title', 'X', '--agent', 'lead', '--task', 't1');
    expect(cli('claim', 't1', '--agent', 'w1').status).toBe(0);
    const lost = cli('claim', 't1', '--agent', 'w2');
    expect(lost.status).toBe(1);
    expect(lost.stdout).toContain('not_open');
  });

  it('posts and lists arbitrary messages', () => {
    cli('post', '--type', 'status.update', '--agent', 'a', '--text', 'hello');
    const msgs = JSON.parse(cli('messages', '--type', 'status.update', '--json').stdout);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('hello');
  });

  it('--version prints protocol identity', () => {
    const r = cli('--version');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('agent-bus/0');
  });

  it('reports validation errors with a nonzero exit', () => {
    // missing --title
    const r = cli('create-task', '--agent', 'lead');
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).toContain('title');
  });

  it('rejects a non-integer numeric flag instead of silently ignoring it', () => {
    const r = cli('messages', '--from', 'xyz');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--from');
  });

  it('rejects hex/exponent numeric flags rather than coercing them', () => {
    // Number("0x10")===16 and Number("1e3")===1000 — surprising for --limit.
    for (const bad of ['0x10', '1e3']) {
      const r = cli('messages', '--limit', bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--limit');
    }
  });

  it('reports invalid JSON in --result clearly', () => {
    cli('create-task', '--title', 'X', '--agent', 'lead', '--task', 't1');
    cli('claim', 't1', '--agent', 'w1');
    const r = cli('complete', 't1', '--agent', 'w1', '--result', '{bad json}');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--result');
  });

  it('rejects an invalid --state filter instead of returning empty', () => {
    cli('create-task', '--title', 'X', '--agent', 'lead', '--task', 't1');
    const r = cli('tasks', '--state', 'opn'); // typo for "open"
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--state');
  });

  it('rejects an invalid --type filter instead of returning empty', () => {
    const r = cli('messages', '--type', 'status.updat'); // typo for "status.update"
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--type');
  });

  it('claim with a stable --id is idempotent on retry', () => {
    cli('create-task', '--title', 'X', '--agent', 'lead', '--task', 't1');
    const first = cli('claim', 't1', '--agent', 'w1', '--id', 'claim-key-1');
    const retry = cli('claim', 't1', '--agent', 'w1', '--id', 'claim-key-1');
    expect(first.status).toBe(0);
    expect(retry.status).toBe(0); // same id => no-op success, not a lost race
  });
});
