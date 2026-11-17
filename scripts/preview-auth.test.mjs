import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewAuth, validateMatrix, retryRequest } from './preview-auth.mjs';

const matrix = [
  { app: 'web', project_id: 'prj_9MpHdKQiODnS6V9m4MOtwAIKaabV', client_id_key: 'WEB_ID', callback_paths: ['/auth/callback'], needs_neon: true },
  { app: 'account', project_id: 'prj_Lz3rTFxqAddEOHCkqqdeep4zfj3M', client_id_key: 'ACCOUNT_ID', callback_paths: ['/api/callback'], needs_neon: true },
];
const repo = 'vana-com/unity-surfaces', domain = 'vana.boo', sha = 'a'.repeat(40);
const pr = { number: 12, state: 'open', base: { ref: 'dev' }, head: { sha, repo: { full_name: repo } } };
const event = { deployment_status: { state: 'success', environment_url: 'https://deploy.vercel.app' }, deployment: { sha } };
function fixture(overrides = {}) {
  const calls = [];
  const deployment = { id: 'dpl_1', projectId: 'prj_9MpHdKQiODnS6V9m4MOtwAIKaabV', readyState: 'READY', meta: { githubCommitOrg: 'vana-com', githubCommitRepo: 'unity-surfaces', githubCommitSha: sha }, ...overrides.deployment };
  let reads = 0;
  const api = async (service, path, body, app) => {
    calls.push([service, path, body, app?.app]);
    if (service === 'vercel') return path === '/aliases' ? (overrides.aliases ?? []) : deployment;
    if (service === 'account') return path ? {} : { hydra: { redirect_uris: overrides.uris ?? [] } };
    if (path.endsWith('/pulls')) return [pr];
    return overrides.pull ? overrides.pull(++reads) : pr;
  };
  const alias = async (...args) => calls.push(['alias', ...args]);
  const run = (opts = {}) => previewAuth({ eventName: 'deployment_status', event, repo, domain, targetBranch: 'dev', matrix, api, alias, ...opts });
  return { calls, run };
}
test('validates app, domain, and callback paths', () => {
  for (const bad of ['../web', 'WEB', 'web.example']) assert.throws(() => validateMatrix([{ ...matrix[0], app: bad }], domain, repo));
  for (const bad of ['vana.boo.evil/', '*.vana.boo', 'vana.boo:443']) assert.throws(() => validateMatrix(matrix, bad, repo));
  assert.throws(() => validateMatrix([{ ...matrix[0], callback_paths: ['//evil.example'] }], domain, repo));
});
test('rejects malicious event URLs and foreign projects or repositories', async () => {
  for (const url of ['https://deploy.vercel.app.evil.test', 'https://user@deploy.vercel.app', 'https://deploy.vercel.app/path']) {
    const f = fixture(); await f.run({ event: { ...event, deployment_status: { ...event.deployment_status, environment_url: url } } });
    assert.equal(f.calls.length, 0);
  }
  for (const deployment of [{ projectId: 'prj_other' }, { meta: { githubCommitOrg: 'evil', githubCommitRepo: 'repo', githubCommitSha: sha } }, { target: 'production' }, { customEnvironment: 'dev' }]) {
    const f = fixture({ deployment }); await f.run(); assert.equal(f.calls.some(c => c[0] === 'alias'), false);
  }
});
test('does not publish old builds and removes alias if head changes during assignment', async () => {
  let f = fixture({ pull: () => ({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }) });
  assert.equal((await f.run()).state, 'ignored');
  const staticApp = { app: 'open', project_id: 'prj_QiRN1gRk8KBY5Do11tVQgTXisdja', callback_paths: [], needs_neon: false };
  f = fixture({ deployment: { projectId: staticApp.project_id }, pull: n => n <= 2 ? pr : ({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }) });
  assert.equal((await f.run({ matrix: [staticApp] })).state, 'stale');
  assert.deepEqual(f.calls.filter(c => c[0] === 'alias').map(c => c[1]), ['set', 'rm']);
  assert.equal(f.calls.some(c => c[0] === 'account'), false);
});
test('closed PR removes only exact owned aliases and callbacks; reopen prevents cleanup', async () => {
  const closed = { ...pr, state: 'closed' };
  const f = fixture({ pull: () => closed, aliases: [{ alias: 'web-pr-12.vana.boo' }, { alias: 'web-pr-120.vana.boo' }] });
  await f.run({ eventName: 'pull_request_target', event: { action: 'closed', pull_request: pr } });
  assert.deepEqual(f.calls.filter(c => c[0] === 'alias').map(c => c[2]), ['web-pr-12.vana.boo']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'account').map(c => c[2].redirect_uri), ['https://web-pr-12.vana.boo/auth/callback', 'https://account-pr-12.vana.boo/api/callback']);
  const reopened = fixture(); await reopened.run({ eventName: 'pull_request_target', event: { action: 'closed', pull_request: pr } });
  assert.equal(reopened.calls.some(c => c[0] === 'account' || c[0] === 'alias'), false);
});
test('blocks unprovisioned Neon', async () => {
  const f = fixture({ deployment: { projectId: 'prj_Lz3rTFxqAddEOHCkqqdeep4zfj3M' } });
  assert.equal((await f.run()).state, 'required-unavailable');
  assert.equal(f.calls.some(c => c[0] === 'account'), false);
  const blocked = fixture();
  assert.equal((await blocked.run({ matrix: [{ ...matrix[0], needs_neon: true }] })).state, 'required-unavailable');
  assert.equal(blocked.calls.some(c => c[0] === 'alias' || c[0] === 'account'), false);
});
test('sweep ignores unrelated URI paths and open PRs', async () => {
  const f = fixture({ pull: () => ({ ...pr, state: 'closed' }), uris: ['https://web-pr-12.vana.boo/auth/callback', 'https://web-pr-13.vana.boo/other'] });
  await f.run({ eventName: 'schedule', event: {} });
  assert.equal(f.calls.some(c => c[1]?.endsWith('/pulls/13')), false);
});

test('rejects ownership collisions before making API calls', async () => {
  for (const opts of [
    { repo: 'vana-com/my-two-cents' },
    { matrix: [{ ...matrix[0], project_id: 'prj_u5iiNxoAsSv2bSJN0K45tjr9DB01' }] },
    { matrix: [{ ...matrix[0], project_id: 'prj_yEUfHW7APiEIxcYfMHTAGPpMl6mI' }] },
  ]) {
    const f = fixture();
    await assert.rejects(f.run(opts));
    assert.deepEqual(f.calls, []);
  }
});
test('static app publishes and sweeps without Account API access', async () => {
  const staticApp = { app: 'open', project_id: 'prj_QiRN1gRk8KBY5Do11tVQgTXisdja', callback_paths: [], needs_neon: false };
  const f = fixture({ deployment: { projectId: staticApp.project_id } });
  assert.equal((await f.run({ matrix: [staticApp] })).state, 'published');
  assert.equal(f.calls.some(c => c[0] === 'account'), false);
  const sweep = fixture();
  await sweep.run({ eventName: 'schedule', event: {}, matrix: [staticApp] });
  assert.equal(sweep.calls.some(c => c[0] === 'account'), false);
});

test('cannot disable required database isolation in caller matrix', async () => {
  const f = fixture();
  await assert.rejects(f.run({ matrix: [{ ...matrix[0], needs_neon: false }] }));
  assert.deepEqual(f.calls, []);
});

test('routes a matching non-database project to its client key', async () => {
  const apps = [
    { app: 'mobile', project_id: 'prj_f3Hqy5lTO7KPRl9wVDNyhKEp5oGf', client_id_key: 'MOBILE_ID', callback_paths: ['/callback'], needs_neon: false },
    { app: 'open', project_id: 'prj_QiRN1gRk8KBY5Do11tVQgTXisdja', client_id_key: 'OPEN_ID', callback_paths: ['/callback'], needs_neon: false },
  ];
  const f = fixture({ deployment: { projectId: apps[1].project_id } });
  assert.equal((await f.run({ matrix: apps })).state, 'published');
  assert.equal(f.calls.find(c => c[0] === 'account')[3], 'open');
});

test('sweep repairs missing targets only with a verified current-head deployment', async () => {
  const app = { app: 'open', project_id: 'prj_QiRN1gRk8KBY5Do11tVQgTXisdja', callback_paths: [], needs_neon: false };
  const good = { id: 'dpl_good', projectId: app.project_id, readyState: 'READY', meta: { githubCommitOrg: 'vana-com', githubCommitRepo: 'unity-surfaces', githubCommitSha: sha } };
  const host = 'open-pr-12.vana.boo';
  async function run({ details = { dpl_good: good }, pulls = () => pr, target = null } = {}) {
    const calls = []; let reads = 0;
    const api = async (service, path) => {
      if (service === 'github') return pulls(++reads);
      if (path === '/aliases') return [{ alias: host, deploymentId: 'dpl_old' }];
      if (path === '/deployments/dpl_old') return target;
      if (path.startsWith('/deployments?')) return Object.keys(details).map(uid => ({ uid }));
      return details[path.split('/').pop()];
    };
    const result = await previewAuth({ eventName: 'schedule', event: {}, repo, matrix: [app], domain, targetBranch: 'dev', api, alias: async (...args) => calls.push(args) });
    return { result, calls };
  }
  let f = await run(); assert.equal(f.result.state, 'cleanup-checked'); assert.equal(f.calls[0][2], 'dpl_good');
  f = await run({ pulls: n => n === 1 ? pr : { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } } }); assert.equal(f.calls.length, 0);
  f = await run({ pulls: n => n < 3 ? pr : { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } } }); assert.deepEqual(f.calls.map(c => c[0]), ['set', 'rm']);
  f = await run({ details: { foreign: { ...good, projectId: 'foreign' }, old: { ...good, meta: { ...good.meta, githubCommitSha: 'b'.repeat(40) } } } }); assert.equal(f.result.state, 'push-needed'); assert.equal(f.calls.length, 0);
  f = await run({ details: {} }); assert.deepEqual(f.result.pushNeeded, [host]);
  f = await run({ target: { readyState: 'READY' } }); assert.equal(f.calls.length, 0);
  f = await run({ pulls: () => ({ ...pr, base: { ref: 'main' } }) }); assert.deepEqual(f.calls.map(c => c[0]), ['rm']);
  f = await run({ pulls: () => ({ ...pr, state: 'closed' }) }); assert.deepEqual(f.calls.map(c => c[0]), ['rm']);
});

test('retries 429, clamps Retry-After and succeeds', async () => {
  const delays = []; let calls = 0;
  const response = await retryRequest(async () => ++calls === 1
    ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '999' }) }
    : { ok: true }, async ms => delays.push(ms), 'https://example.test', {});
  assert.equal(response.ok, true); assert.equal(calls, 2); assert.deepEqual(delays, [5000]);
});
test('does not retry 401 and reports exhausted transient failures', async () => {
  for (const [status, expected] of [[401, 1], [503, 3]]) {
    let calls = 0;
    await assert.rejects(retryRequest(async () => { calls++; return { ok: false, status, headers: new Headers() }; }, async () => {}, 'https://example.test', {}), new RegExp(`API request failed \\(${status}\\)`));
    assert.equal(calls, expected);
  }
});
test('cleanup isolates failed app and preserves its alias', async () => {
  const f = fixture({ pull: () => ({ ...pr, state: 'closed' }), aliases: [{ alias: 'web-pr-12.vana.boo' }, { alias: 'account-pr-12.vana.boo' }] });
  const api = async (service, path, body, app) => {
    if (service === 'vercel' && app.app === 'web') throw new Error('secret response body');
    if (service === 'vercel') return [{ alias: 'account-pr-12.vana.boo' }];
    if (service === 'account') return {};
    return { ...pr, state: 'closed' };
  };
  const alias = async (...args) => f.calls.push(['alias', ...args]);
  const result = await f.run({ eventName: 'pull_request_target', event: { action: 'closed', pull_request: pr }, api, alias });
  assert.equal(result.state, 'failed'); assert.deepEqual(result.failures, [{ app: 'web', reason: 'Preview operation failed' }]);
  assert.deepEqual(f.calls.filter(c => c[0] === 'alias').map(c => c[2]), ['account-pr-12.vana.boo']);
});
test('failed deployment reports app without touching alias', async () => {
  const f = fixture();
  const result = await f.run({ event: { ...event, deployment_status: { ...event.deployment_status, state: 'failure' } } });
  assert.deepEqual(result.failures, [{ app: 'web', reason: 'Deployment failed' }]);
  assert.equal(f.calls.some(c => c[0] === 'alias'), false);
});
test('account failure leaves alias untouched and a later app publishes', async () => {
  const apps = [
    { app: 'mobile', project_id: 'prj_f3Hqy5lTO7KPRl9wVDNyhKEp5oGf', client_id_key: 'MOBILE_ID', callback_paths: ['/callback'], needs_neon: false },
    { app: 'open', project_id: 'prj_QiRN1gRk8KBY5Do11tVQgTXisdja', callback_paths: [], needs_neon: false },
  ];
  const failed = fixture({ deployment: { projectId: apps[0].project_id } });
  const original = failed.run;
  const api = async (service, path) => {
    if (service === 'vercel') return { id: 'dpl_1', projectId: apps[0].project_id, readyState: 'READY', meta: { githubCommitOrg: 'vana-com', githubCommitRepo: 'unity-surfaces', githubCommitSha: sha } };
    if (service === 'account') throw new Error('API request failed (503)');
    return path.endsWith('/pulls') ? [pr] : pr;
  };
  assert.equal((await original({ matrix: apps, api })).state, 'failed');
  assert.equal(failed.calls.some(c => c[0] === 'alias'), false);
  const next = fixture({ deployment: { projectId: apps[1].project_id } });
  assert.equal((await next.run({ matrix: apps })).state, 'published');
});
