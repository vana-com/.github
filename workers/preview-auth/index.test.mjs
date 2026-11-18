import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import worker, { PreviewRepo, configs, repoEnv, runJob } from './index.mjs';
import { createGitHubApp } from './github-app.mjs';
import { APP_OWNERS, COMMENT_MARKER, createApi, previewAuth } from '../../scripts/preview-auth.mjs';

const repo = 'vana-com/unity-surfaces', other = 'vana-com/my-two-cents', sha = 'a'.repeat(40);
const project = APP_OWNERS.open[1];
const app = { app: 'open', project_id: project, callback_paths: [], needs_neon: false };
const pr = { number: 12, state: 'open', created_at: '2026-11-01T00:00:00Z', base: { ref: 'dev', repo: { full_name: repo } }, head: { sha, ref: 'topic', repo: { full_name: repo, id: 123 } } };
const config = { matrix: [app], targetBranch: 'dev', domain: 'vana.boo' };
const envFor = () => ({ REPOS: JSON.stringify({ [repo]: config }), TEAM_ID: 'team_test', VERCEL_TOKEN: 'test-vercel', ACCOUNT_ADMIN_TOKEN: 'test-account', PREVIEW_DEV_CLIENT_IDS: 'test-client', VERCEL_WEBHOOK_SECRET: 'test-vercel-signature', GITHUB_WEBHOOK_SECRET: 'test-github-signature' });
const access = async () => ({ token: 'test-github', commentAuthor: 'preview-test[bot]' });
const reply = (data, status = 200) => Response.json(data, { status });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Storage {
  constructor() { this.data = new Map(); this.alarm = null; this.tail = Promise.resolve(); }
  async get(k) { return structuredClone(this.data.get(k)); }
  async put(k, v) { this.data.set(k, structuredClone(v)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(v) { this.alarm = v; }
  async deleteAlarm() { this.alarm = null; }
  transaction(fn) { const work = this.tail.then(() => fn(this)); this.tail = work.catch(() => {}); return work; }
}
function services({ state = 'READY', prs = [structuredClone(pr)], intercept } = {}) {
  const calls = [], comments = [], aliases = new Map();
  const deployment = { id: 'dpl_open', projectId: project, readyState: state, target: null, createdAt: Date.parse('2026-11-02T00:00:00Z'),
    meta: { githubCommitOrg: 'vana-com', githubCommitRepo: 'unity-surfaces', githubCommitSha: sha } };
  const fetchFn = async (input, options = {}) => {
    const u = new URL(input), method = options.method ?? 'GET', body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: u.href, method, body });
    const extra = await intercept?.(u, options); if (extra) return extra;
    if (u.origin === 'https://api.github.com') {
      if (u.pathname.includes('/commits/')) return reply(prs);
      if (/\/pulls\/\d+$/.test(u.pathname)) return reply(prs.find(p => String(p.number) === u.pathname.split('/').at(-1)) ?? {}, prs.length ? 200 : 404);
      if (u.pathname.endsWith('/pulls')) return reply(prs.filter(p => p.state === 'open'));
      if (/\/issues\/\d+\/comments$/.test(u.pathname)) {
        const number = Number(u.pathname.split('/').at(-2));
        if (method === 'POST') { const item = { id: comments.length + 1, number, user: { login: 'preview-test[bot]', type: 'Bot' }, body: body.body }; comments.push(item); return reply(item); }
        return reply(comments.filter(c => c.number === number));
      }
      if (/\/issues\/comments\/\d+$/.test(u.pathname)) { const c = comments.find(c => String(c.id) === u.pathname.split('/').at(-1)); c.body = body.body; return reply(c); }
      assert.fail('Unexpected GitHub request ' + u.pathname);
    }
    if (u.origin === 'https://account-dev.vana.org') return reply({ redirect_uris: [] });
    assert.equal(u.origin, 'https://api.vercel.com');
    assert.equal(u.searchParams.get('teamId'), 'team_test');
    if (u.pathname === '/v4/aliases') return reply({ aliases: [...aliases.values()].filter(a => a.projectId === u.searchParams.get('projectId')) });
    if (u.pathname.startsWith('/v4/aliases/')) return aliases.has(u.pathname.split('/').at(-1)) ? reply(aliases.get(u.pathname.split('/').at(-1))) : reply({}, 404);
    if (u.pathname.startsWith('/v2/aliases/')) { for (const [k, v] of aliases) if (v.uid === u.pathname.split('/').at(-1)) aliases.delete(k); return reply({}); }
    if (u.pathname === '/v2/deployments/dpl_open/aliases') { aliases.set(body.alias, { uid: 'alias-test', alias: body.alias, deploymentId: deployment.id, projectId: project }); return reply({}); }
    if (u.pathname === '/v7/deployments') return reply({ deployments: u.searchParams.get('projectId') === project ? [{ uid: deployment.id }] : [] });
    if (u.pathname === '/v13/deployments/dpl_open') return reply(deployment);
    assert.fail('Unexpected Vercel request ' + u.pathname);
  };
  return { fetchFn, calls, comments, aliases, prs, deployment };
}
function fixture(options) {
  const env = envFor(), svc = services(options), objects = new Map(), stores = new Map();
  env.PREVIEW_REPOS = {
    idFromName: name => name,
    get(name) { if (!objects.has(name)) { const storage = new Storage(); stores.set(name, storage); objects.set(name, new PreviewRepo({ storage }, env, { fetchFn: svc.fetchFn, access })); } return objects.get(name); },
  };
  const drain = async (name = repo) => { const obj = env.PREVIEW_REPOS.get(name); while ((await stores.get(name).get('queue'))?.length) await obj.alarm(); };
  return { env, ...svc, objects, stores, drain };
}
function vercel(type = 'deployment.succeeded', overrides = {}) {
  return { type, id: 'evt-one', payload: { team: { id: 'team_test' }, target: null, project: { id: project }, deployment: { id: 'dpl_open', url: 'test.vercel.app', meta: { githubCommitOrg: 'vana-com', githubCommitRepo: 'unity-surfaces', githubCommitSha: sha } } }, ...overrides };
}
function github(action = 'opened', pull = pr) { return { action, repository: { full_name: repo }, pull_request: pull }; }
function request(env, path, body, { bad = false, id = 'delivery-one', raw } = {}) {
  const text = raw ?? JSON.stringify(body), v = path === '/vercel';
  const signature = createHmac(v ? 'sha1' : 'sha256', v ? env.VERCEL_WEBHOOK_SECRET : env.GITHUB_WEBHOOK_SECRET).update(text).digest('hex');
  return new Request('https://worker.example' + path, { method: 'POST', headers: { [v ? 'x-vercel-signature' : 'x-hub-signature-256']: bad ? 'wrong' : (v ? '' : 'sha256=') + signature, 'x-github-event': 'pull_request', 'x-github-delivery': id }, body: text });
}
async function send(f, path, body, opts) { return worker.fetch(request(f.env, path, body, opts), f.env); }

test('rejects bad signatures for both providers, malformed JSON and byte changes before any work', async () => {
  for (const path of ['/vercel', '/github']) {
    const f = fixture();
    assert.equal((await send(f, path, {}, { bad: true })).status, 401);
    assert.equal((await send(f, path, {}, { raw: '{' })).status, 400);
    const signed = request(f.env, path, {});
    const changed = new Request(signed.url, { method: 'POST', headers: signed.headers, body: '{ }' });
    assert.equal((await worker.fetch(changed, f.env)).status, 401);
    assert.equal(f.objects.size, 0); assert.equal(f.calls.length, 0);
  }
});
test('signed succeeded event uses exactly the deployment-completed reconciliation path, and sticky comments stay single', async () => {
  const f = fixture();
  assert.equal((await send(f, '/vercel', vercel())).status, 202);
  assert.equal(f.calls.length, 0, 'ack follows durable admission, not network work');
  await f.drain();
  const expected = services();
  const adapters = createApi({ ...f.env, GITHUB_REPOSITORY: repo, PREVIEW_DOMAIN: config.domain, GITHUB_TOKEN: 'test-github' }, { fetchFn: expected.fetchFn, commentAuthor: 'preview-test[bot]' });
  await previewAuth({ ...config, repo, eventName: 'pull_request_target', event: { action: 'reopened', pull_request: pr }, reportBuildOutcome: true, ...adapters });
  assert.equal(f.comments[0].body, expected.comments[0].body);
  assert.match(f.comments[0].body, /✅ Ready/); assert.doesNotMatch(f.comments[0].body, /Workflow run/);
  await send(f, '/vercel', vercel(undefined, { id: 'evt-two' })); await f.drain();
  assert.equal(f.comments.length, 1);
  const count = f.calls.length;
  await send(f, '/vercel', vercel()); await f.drain(); assert.equal(f.calls.length, count, 'deduplicated completed delivery');
});
for (const [type, state, text] of [['deployment.error', 'ERROR', /❌ Build failed/], ['deployment.canceled', 'CANCELED', /⚠️ Build canceled/]]) test(type + ' shows truthful live outcome', async () => {
  const f = fixture({ state }); await send(f, '/vercel', vercel(type)); await f.drain();
  assert.match(f.comments[0].body, text); assert.equal(f.aliases.size, 0);
});
test('ignores unknown project, wrong team, foreign metadata, production and irrelevant events', async () => {
  for (const mutate of [e => { e.payload.project.id = 'unknown'; }, e => { e.payload.team.id = 'foreign'; }, e => { e.payload.deployment.meta.githubCommitRepo = 'foreign'; }, e => { e.payload.target = 'production'; }, e => { e.type = 'deployment.created'; }]) {
    const f = fixture(), event = vercel(); mutate(event); assert.equal((await send(f, '/vercel', event)).status, 200); assert.equal(f.objects.size, 0); assert.equal(f.calls.length, 0);
  }
});
test('ignores fork heads from GitHub and live Vercel commit association', async () => {
  const fork = structuredClone(pr); fork.head.repo.full_name = 'stranger/fork';
  const f = fixture({ prs: [fork] });
  await send(f, '/github', github('opened', fork)); assert.equal(f.objects.size, 0);
  await send(f, '/vercel', vercel()); await f.drain();
  assert.equal(f.comments.length, 0); assert.equal(f.aliases.size, 0);
});
test('closed PR runs existing cleanup and updates only the App-owned comment', async () => {
  const f = fixture(); await send(f, '/vercel', vercel()); await f.drain();
  f.prs[0].state = 'closed';
  assert.equal((await send(f, '/github', github('closed', f.prs[0]))).status, 202); await f.drain();
  assert.equal(f.aliases.size, 0); assert.match(f.comments[0].body, /removed/); assert.equal(f.comments.length, 1);
});
test('cron durably admits a sweep for both configured repos', async () => {
  const f = fixture(); const repos = JSON.parse(f.env.REPOS);
  repos[other] = { matrix: [{ app: 'my-two-cents', project_id: APP_OWNERS['my-two-cents'][1], callback_paths: [] }], targetBranch: 'main', domain: 'vana.boo' };
  f.env.REPOS = JSON.stringify(repos);
  await worker.scheduled({ scheduledTime: 123 }, f.env);
  for (const name of [repo, other]) { assert.equal((await f.stores.get(name).get('queue'))[0].kind, 'schedule'); await f.drain(name); assert.deepEqual((await f.stores.get(name).get('last')).states, ['cleanup-checked']); }
  assert.ok(f.calls.some(c => c.url.includes('/repos/' + other + '/pulls?')));
});
test('two repo events serialize, new admission survives in-flight execution and queue survives reconstruction', async () => {
  const gate = deferred(), entered = deferred(); let first = true;
  const second = { ...structuredClone(pr), number: 13 };
  const f = fixture({ prs: [structuredClone(pr), second], intercept: async u => { if (u.pathname.endsWith('/pulls/12') && first) { first = false; entered.resolve(); await gate.promise; } } });
  await send(f, '/github', github('reopened'));
  const obj = f.objects.get(repo), a = obj.alarm(); await entered.promise;
  await send(f, '/github', github('reopened', second), { id: 'two' });
  const b = obj.alarm(); assert.equal(a, b); assert.equal(f.calls.length, 1);
  gate.resolve(); await a;
  assert.equal((await f.stores.get(repo).get('queue')).length, 1);
  const resumed = new PreviewRepo({ storage: f.stores.get(repo) }, f.env, { fetchFn: f.fetchFn, access });
  await resumed.alarm(); assert.equal((await f.stores.get(repo).get('queue')).length, 0);
  assert.equal(f.comments.length, 2);
});
test('transient access failure retains queue and sets backoff without leaking exception', async () => {
  const f = fixture(); await send(f, '/vercel', vercel());
  const storage = f.stores.get(repo), broken = new PreviewRepo({ storage }, f.env, { access: async () => { throw new Error('private credential value'); } });
  await broken.alarm(); const queue = await storage.get('queue'); assert.equal(queue.length, 1); assert.equal(queue[0].attempts, 1);
  assert.ok(storage.alarm > Date.now()); assert.doesNotMatch(JSON.stringify([...storage.data]), /private credential/);
});
test('repo override is explicit and config has both exact matrices without credentials', async () => {
  assert.equal(repoEnv({ PREVIEW_DEV_CLIENT_IDS: 'shared', PREVIEW_DEV_CLIENT_IDS__VANA_COM_UNITY_SURFACES: 'specific' }, repo).PREVIEW_DEV_CLIENT_IDS, 'specific');
  const raw = await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8');
  const conf = JSON.parse(raw.split('\n').filter(line => !line.startsWith('//')).join('\n'));
  assert.deepEqual(Object.keys(configs(conf.vars)), [repo, other]); assert.equal(JSON.parse(conf.vars.REPOS)[repo].matrix.length, 6);
  assert.equal(conf.main, 'index.mjs'); assert.deepEqual(conf.triggers.crons, ['23 5 * * *']);
  assert.doesNotMatch(raw, /PRIVATE KEY|WEBHOOK_SECRET|ADMIN_TOKEN/);
});
test('App JWT uses RS256, repo-restricted installation token, trusted bot identity, cache and expiry refresh', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }); let now = 1_800_000_000_000, calls = 0;
  const appEnv = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: pem };
  const provider = createGitHubApp({ now: () => now, fetchFn: async (url, opts) => {
    calls++; const token = opts.headers.Authorization.slice(7), parts = token.split('.');
    assert.equal(JSON.parse(Buffer.from(parts[0], 'base64url')).alg, 'RS256');
    assert.ok(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url')));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); assert.equal(claims.iss, '123'); assert.ok(claims.exp - claims.iat <= 600);
    if (url.endsWith('/app')) return reply({ slug: 'preview-test' });
    if (url.endsWith('/installation')) return reply({ id: 7 });
    assert.equal(url, 'https://api.github.com/app/installations/7/access_tokens');
    assert.deepEqual(JSON.parse(opts.body).repositories, ['unity-surfaces']);
    return reply({ token: 'opaque-test-access', expires_at: new Date(now + 3600_000).toISOString() });
  } });
  assert.deepEqual(await provider(appEnv, repo), { token: 'opaque-test-access', commentAuthor: 'preview-test[bot]' });
  await provider(appEnv, repo); assert.equal(calls, 3);
  now += 3550_000; await provider(appEnv, repo); assert.equal(calls, 6);
});
test('App identity does not match a stranger or the old Actions bot', async () => {
  const comments = [ { id: 1, user: { login: 'stranger', type: 'User' }, body: COMMENT_MARKER }, { id: 2, user: { login: 'github-actions[bot]', type: 'Bot' }, body: COMMENT_MARKER }, { id: 3, user: { login: 'preview-test[bot]', type: 'Bot' }, body: COMMENT_MARKER } ];
  const { comments: adapter } = createApi({ GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: repo }, { commentAuthor: 'preview-test[bot]', fetchFn: async () => reply(comments) });
  assert.equal((await adapter.find(12)).id, 3);
});
