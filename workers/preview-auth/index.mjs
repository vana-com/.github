import { previewAuth, createApi, validateMatrix } from '../../scripts/preview-auth.mjs';
import { createGitHubApp } from './github-app.mjs';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const actions = new Set(['opened', 'reopened', 'synchronize', 'edited', 'closed']);
const deployments = new Set(['deployment.succeeded', 'deployment.error', 'deployment.canceled']);
const MAX_BODY = 1024 * 1024;
// Slug is owner_repo, with all non-alphanumeric characters replaced by underscores, uppercase.
export const repoSlug = repo => repo.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
export function repoEnv(env, repo) {
  const scoped = { ...env }, suffix = '__' + repoSlug(repo);
  for (const key of Object.keys(env)) if (key.endsWith(suffix)) scoped[key.slice(0, -suffix.length)] = env[key];
  return scoped;
}
export function configs(env) {
  const repos = typeof env.REPOS === 'string' ? JSON.parse(env.REPOS) : env.REPOS;
  if (!repos || typeof repos !== 'object' || Array.isArray(repos)) throw new Error('Invalid REPOS');
  const projects = new Set(), slugs = new Set();
  for (const [repo, config] of Object.entries(repos)) {
    if (!REPO.test(repo) || !config || !/^[A-Za-z0-9._/-]+$/.test(config.targetBranch ?? '') || slugs.has(repoSlug(repo))) throw new Error('Invalid repo config');
    slugs.add(repoSlug(repo));
    validateMatrix(config.matrix, config.domain, repo);
    if (!config.matrix.length) throw new Error('Empty repo matrix');
    for (const app of config.matrix) {
      if (projects.has(app.project_id)) throw new Error('Ambiguous project');
      projects.add(app.project_id);
    }
  }
  return repos;
}
export async function verifySignature(body, signature, secret, hash, prefix = '') {
  const length = hash === 'SHA-1' ? 40 : 64;
  if (typeof secret !== 'string' || !secret || typeof signature !== 'string' || !signature.startsWith(prefix)) return false;
  const hex = signature.slice(prefix.length);
  if (!new RegExp(`^[a-fA-F0-9]{${length}}$`).test(hex)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, Uint8Array.from(hex.match(/../g), h => parseInt(h, 16)), body);
}
async function bodyBytes(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('body too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
const json = (value, status = 200) => Response.json(value, { status });
const ignored = () => json({ state: 'ignored' });
async function enqueue(env, job) {
  const stub = env.PREVIEW_REPOS.get(env.PREVIEW_REPOS.idFromName(job.repo));
  return stub.fetch(new Request('https://preview.internal/queue', { method: 'POST', body: JSON.stringify(job) }));
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!['/github', '/vercel'].includes(path)) return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let bytes;
    try { bytes = await bodyBytes(request); } catch { return new Response('Invalid body', { status: 413 }); }
    const vercel = path === '/vercel';
    if (!await verifySignature(bytes, request.headers.get(vercel ? 'x-vercel-signature' : 'x-hub-signature-256'),
      vercel ? env.VERCEL_WEBHOOK_SECRET : env.GITHUB_WEBHOOK_SECRET, vercel ? 'SHA-1' : 'SHA-256', vercel ? '' : 'sha256=')) return new Response('Unauthorized', { status: 401 });
    let event;
    try { event = JSON.parse(new TextDecoder().decode(bytes)); } catch { return new Response('Invalid JSON', { status: 400 }); }
    try {
      const repos = configs(env);
      if (vercel) {
        if (!deployments.has(event.type)) return ignored();
        const payload = event.payload;
        const project = payload?.project?.id;
        const entry = Object.entries(repos).find(([, c]) => c.matrix.some(app => app.project_id === project));
        if (!entry) return ignored();
        const [repo] = entry, meta = payload.deployment?.meta;
        if (`${meta?.githubCommitOrg}/${meta?.githubCommitRepo}` !== repo || !SHA.test(meta?.githubCommitSha ?? '') ||
            payload.team?.id !== repoEnv(env, repo).TEAM_ID || (payload.target != null && payload.target !== 'preview')) return ignored();
        if (typeof event.id !== 'string' || !event.id || event.id.length > 200) return new Response('Missing delivery ID', { status: 400 });
        return await enqueue(env, { id: 'vercel:' + event.id, repo, kind: 'vercel', sha: meta.githubCommitSha });
      }
      if (request.headers.get('x-github-event') !== 'pull_request' || !actions.has(event.action)) return ignored();
      const repo = event.repository?.full_name, pr = event.pull_request;
      if (!Object.hasOwn(repos, repo ?? '') || pr?.head?.repo?.full_name !== repo || pr.base?.repo?.full_name !== repo ||
          !Number.isSafeInteger(pr.number) || pr.number < 1 || !SHA.test(pr.head?.sha ?? '')) return ignored();
      const id = request.headers.get('x-github-delivery');
      if (!id || id.length > 200) return new Response('Missing delivery ID', { status: 400 });
      // Do not persist descriptions, user profiles, credentials or the entire webhook.
      return await enqueue(env, { id: 'github:' + id, repo, kind: 'github', action: event.action,
        pr: { number: pr.number, head: { sha: pr.head.sha, repo: { full_name: repo } } } });
    } catch { return new Response('Preview admission failed', { status: 503 }); }
  },
  async scheduled(controller, env) {
    for (const repo of Object.keys(configs(env))) {
      const response = await enqueue(env, { id: 'cron:' + controller.scheduledTime, kind: 'schedule', repo });
      if (!response.ok) throw new Error('Preview sweep admission failed');
    }
  },
};

// Runs only behind the private DO binding. All mutable external work is inside alarm().
export async function runJob(job, env, { fetchFn = fetch, access = createGitHubApp({ fetchFn }) } = {}) {
  const config = configs(env)[job.repo];
  if (!config) throw new Error('Unknown repo');
  const scoped = repoEnv(env, job.repo);
  const identity = await access(scoped, job.repo);
  const adapters = createApi({ ...scoped, GITHUB_TOKEN: identity.token, GITHUB_REPOSITORY: job.repo, PREVIEW_DOMAIN: config.domain }, { fetchFn, commentAuthor: identity.commentAuthor });
  const run = (eventName, event, reportBuildOutcome = false) => previewAuth({ ...config, repo: job.repo, eventName, event, reportBuildOutcome, ...adapters });
  if (job.kind === 'schedule') return [await run('schedule', {})];
  if (job.kind === 'github') return [await run('pull_request_target', { action: job.action, pull_request: job.pr })];
  if (job.kind !== 'vercel' || !SHA.test(job.sha)) throw new Error('Invalid job');
  const results = [], seen = new Set();
  for (let page = 1; ; page++) {
    const pulls = await adapters.api('github', `/repos/${job.repo}/commits/${job.sha}/pulls?per_page=100&page=${page}`);
    if (!Array.isArray(pulls)) throw new Error('Invalid pull list');
    for (const pr of pulls) {
      if (!Number.isSafeInteger(pr?.number) || pr.number <= 0 || seen.has(pr.number) || pr.state !== 'open' ||
          pr.head?.repo?.full_name !== job.repo || pr.base?.repo?.full_name !== job.repo || pr.head.sha !== job.sha) continue;
      seen.add(pr.number);
      // Same path used by the successful deployment-completed workflow_run signal.
      // Re-read live PR/deployments inside the core, not the possibly old webhook status.
      results.push(await run('pull_request_target', { action: 'reopened', pull_request: pr }, true));
    }
    if (pulls.length < 100) break;
  }
  return results;
}

export class PreviewRepo {
  constructor(ctx, env, dependencies = {}) {
    this.storage = ctx.storage; this.env = env;
    this.dependencies = { ...dependencies, access: dependencies.access ?? createGitHubApp(dependencies) };
    this.alarmFlight = null;
  }
  async fetch(request) {
    const job = await request.json();
    if (!configs(this.env)[job.repo] || !['github', 'vercel', 'schedule'].includes(job.kind) || typeof job.id !== 'string') return json({ error: 'Invalid job' }, 400);
    const accepted = await this.storage.transaction(async tx => {
      const owner = await tx.get('repo');
      if (owner && owner !== job.repo) throw new Error('Wrong repo object');
      const queue = await tx.get('queue') ?? [], done = await tx.get('done') ?? [];
      if (queue.some(item => item.id === job.id) || done.includes(job.id)) return true;
      if (queue.length >= 200) return false;
      await tx.put('repo', job.repo);
      await tx.put('queue', [...queue, { ...job, attempts: 0 }]);
      if (await tx.getAlarm() === null) await tx.setAlarm(Date.now() + 1);
      return true;
    });
    return json({ state: accepted ? 'queued' : 'full' }, accepted ? 202 : 503);
  }
  alarm() {
    // Cloudflare serializes alarms; the promise also makes the invariant testable offline.
    if (this.alarmFlight) return this.alarmFlight;
    this.alarmFlight = this.drainOne().finally(() => { this.alarmFlight = null; });
    return this.alarmFlight;
  }
  async drainOne() {
    const [job] = await this.storage.get('queue') ?? [];
    if (!job) return;
    let results, failed = false;
    try { results = await runJob(job, this.env, this.dependencies); } catch { failed = true; }
    await this.storage.transaction(async tx => {
      const queue = await tx.get('queue') ?? [];
      if (queue[0]?.id !== job.id) throw new Error('Queue head changed');
      if (failed) {
        queue[0].attempts++;
        await tx.put('queue', queue);
        await tx.setAlarm(Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(queue[0].attempts, 6)));
        return;
      }
      queue.shift();
      await tx.put('queue', queue);
      await tx.put('done', [...(await tx.get('done') ?? []), job.id].slice(-500));
      // Bounded, non-secret operational status; API bodies/credentials are never logged.
      await tx.put('last', { id: job.id, at: Date.now(), states: results.map(r => r.state), failures: results.reduce((n, r) => n + (r.failures?.length ?? 0), 0) });
      if (queue.length) await tx.setAlarm(Date.now() + 1);
      else await tx.deleteAlarm();
    });
  }
}
