import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewAuth, validateMatrix } from './preview-auth.mjs';

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
  f = fixture({ deployment: { projectId: staticApp.project_id }, pull: n => n === 1 ? pr : ({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }) });
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
