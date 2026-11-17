import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewAuth, validateMatrix } from './preview-auth.mjs';

const matrix = [
  { app: 'web', project_id: 'prj_web', client_id_key: 'WEB_ID', callback_paths: ['/auth/callback'], needs_neon: false },
  { app: 'account', project_id: 'prj_account', client_id_key: 'ACCOUNT_ID', callback_paths: ['/api/callback'], needs_neon: false },
];
const repo = 'org/repo', domain = 'vana.boo', sha = 'a'.repeat(40);
const pr = { number: 12, state: 'open', base: { ref: 'dev' }, head: { sha, repo: { full_name: repo } } };
const event = { deployment_status: { state: 'success', environment_url: 'https://deploy.vercel.app' }, deployment: { sha } };
function fixture(overrides = {}) {
  const calls = [];
  const deployment = { id: 'dpl_1', projectId: 'prj_web', readyState: 'READY', meta: { githubCommitOrg: 'org', githubCommitRepo: 'repo', githubCommitSha: sha }, ...overrides.deployment };
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
  for (const bad of ['../web', 'WEB', 'web.example']) assert.throws(() => validateMatrix([{ ...matrix[0], app: bad }], domain));
  for (const bad of ['vana.boo.evil/', '*.vana.boo', 'vana.boo:443']) assert.throws(() => validateMatrix(matrix, bad));
  assert.throws(() => validateMatrix([{ ...matrix[0], callback_paths: ['//evil.example'] }], domain));
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
  f = fixture({ pull: n => n === 1 ? pr : ({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }) });
  assert.equal((await f.run()).state, 'stale');
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
test('routes the matching project to its app client and blocks unprovisioned Neon', async () => {
  const f = fixture({ deployment: { projectId: 'prj_account' } });
  assert.equal((await f.run()).state, 'published');
  assert.equal(f.calls.find(c => c[0] === 'account')[3], 'account');
  const blocked = fixture();
  assert.equal((await blocked.run({ matrix: [{ ...matrix[0], needs_neon: true }] })).state, 'required-unavailable');
  assert.equal(blocked.calls.some(c => c[0] === 'alias' || c[0] === 'account'), false);
});
test('sweep ignores unrelated URI paths and open PRs', async () => {
  const f = fixture({ pull: () => ({ ...pr, state: 'closed' }), uris: ['https://web-pr-12.vana.boo/auth/callback', 'https://web-pr-13.vana.boo/other'] });
  await f.run({ eventName: 'schedule', event: {} });
  assert.equal(f.calls.some(c => c[1]?.endsWith('/pulls/13')), false);
});
