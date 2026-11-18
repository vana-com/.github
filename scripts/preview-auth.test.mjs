import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_OWNERS, COMMENT_MARKER, createApi, previewAuth, renderPreviewComment, retryRequest, upsertPreviewComment, validateMatrix,
} from './preview-auth.mjs';

const app = (name, key, callback_paths = []) => ({ app: name, project_id: APP_OWNERS[name][1], ...(key ? { client_id_key: key } : {}), callback_paths });
const web = app('web', 'WEB_CLIENT_ID', ['/oauth/callback']);
const account = app('account', 'ACCOUNT_CLIENT_ID', ['/auth/oidc/callback']);
const open = app('open');
const repo = 'vana-com/unity-surfaces', domain = 'vana.boo';
const sha = 'a'.repeat(40), nextSha = 'b'.repeat(40);
const prOpenedAt = '2026-11-17T22:18:23Z';
const prOpenedMs = Date.parse(prOpenedAt);
const basePr = {
  number: 12, state: 'open', created_at: prOpenedAt, base: { ref: 'dev' },
  head: { sha, ref: 'topic', repo: { full_name: repo, id: 1226317611 } },
};
const closedPr = { ...basePr, state: 'closed' };
const deploymentEvent = {
  deployment_status: { state: 'success', environment_url: 'https://deploy.vercel.app' },
  deployment: { sha },
};
const pullEvent = (action, pull_request = basePr) => ({ eventName: 'pull_request_target', event: { action, pull_request } });
const signal = (details = {}) => ({
  eventName: 'workflow_run',
  event: {
    action: 'completed',
    repository: { full_name: repo },
    workflow_run: {
      name: 'Preview deployment signal', path: '.github/workflows/preview-deployment-signal.yml',
      event: 'pull_request', status: 'completed', conclusion: 'success',
      repository: { full_name: repo }, head_repository: { full_name: repo }, head_sha: sha, head_branch: 'topic',
      ...details,
    },
  },
});
const sweep = { eventName: 'schedule', event: {} };
const dispatch = { eventName: 'workflow_dispatch', event: {}, decommission: true };
const host = name => `${name}-pr-12.${domain}`;
const webUri = `https://${host('web')}/oauth/callback`;
const unknownPath = `https://${host('web')}/unrelated`;
const foreignUri = 'https://my-two-cents-pr-4.vana.boo/api/member/auth/callback';
const deployment = (app, details) => ({
  id: `dpl_${app.app}`, name: `vana-${app.app}`, projectId: app.project_id, readyState: 'READY', target: null,
  createdAt: prOpenedMs + 1000, source: 'git',
  gitSource: { type: 'github', sha, ref: 'topic', repoId: basePr.head.repo.id, prId: null },
  meta: { githubCommitOrg: 'vana-com', githubCommitRepo: 'unity-surfaces', githubCommitSha: sha, githubCommitRef: 'topic', githubPrId: '12' },
  ...details,
});
const mapping = (app, deploymentId = `dpl_${app.app}`) => ({ uid: `alias_${app.app}`, alias: host(app.app), deploymentId, projectId: app.project_id });
const json = (body, status = 200) => Response.json(body, { status });

function fixture({
  apps = [web, account, open], aliases = [], deployments = [deployment(web)], clientUris = { 'web-dev': [], 'account-dev': [] },
  pr = basePr, env = {}, intercept, initialComments = [],
} = {}) {
  const calls = [], delays = [];
  const state = {
    pr, aliases: new Map(aliases.map(a => [a.alias, a])),
    deployments: new Map(deployments.map(d => [d.id, d])),
    clientUris: new Map(Object.entries(clientUris)),
    eventDeployment: deployments[0], comments: [...initialComments], nextCommentId: 900,
  };
  const credentials = {
    GITHUB_REPOSITORY: repo, PREVIEW_DOMAIN: domain, GITHUB_TOKEN: 'github-test', VERCEL_TOKEN: 'vercel-test',
    TEAM_ID: 'team_test', ACCOUNT_ADMIN_TOKEN: 'account-test', PREVIEW_DEV_CLIENT_IDS: JSON.stringify(Object.keys(clientUris)),
    WEB_CLIENT_ID: 'web-dev', ACCOUNT_CLIENT_ID: 'account-dev', ...env,
  };
  const fetchFn = async (address, options) => {
    const url = new URL(address);
    const method = options.method;
    const body = options.body ? JSON.parse(options.body) : null;
    const call = { origin: url.origin, path: url.pathname, method, body, options };
    calls.push(call);
    const response = await intercept?.({ ...call, url, state });
    if (response) return response;
    if (url.origin === 'https://api.github.com') {
      if (/\/issues\/12\/comments$/.test(url.pathname)) {
        if (method === 'POST') {
          const created = { id: state.nextCommentId++, user: { login: 'github-actions[bot]', type: 'Bot' }, body: body.body };
          state.comments.push(created);
          return json(created, 201);
        }
        const page = Number(url.searchParams.get('page'));
        return json(state.comments.slice((page - 1) * 100, page * 100));
      }
      const edit = /\/issues\/comments\/(\d+)$/.exec(url.pathname);
      if (edit) {
        assert.equal(method, 'PATCH');
        const target = state.comments.find(c => c.id === Number(edit[1]));
        if (!target) return json({}, 404);
        target.body = body.body;
        return json(target);
      }
      if (url.pathname.endsWith('/pulls')) {
        return json(url.searchParams.get('state') === 'open' ? [state.pr].filter(pr => pr.state === 'open') : [basePr]);
      }
      assert.match(url.pathname, /\/pulls\/12$/);
      return json(state.pr);
    }
    if (url.origin === 'https://account-dev.vana.org') {
      const match = /^\/api\/admin\/oauth-clients\/([^/]+)\/redirect-uris$/.exec(url.pathname);
      assert.ok(match);
      const id = match[1];
      const uris = state.clientUris.get(id);
      if (!uris) return json({}, 404);
      if (method === 'GET') return json({ redirect_uris: uris });
      if (body.action === 'add') state.clientUris.set(id, [...new Set([...uris, body.redirect_uri])]);
      else state.clientUris.set(id, uris.filter(uri => uri !== body.redirect_uri));
      return json({ redirect_uris: state.clientUris.get(id) });
    }
    assert.equal(url.origin, 'https://api.vercel.com');
    assert.equal(url.searchParams.get('teamId'), 'team_test');
    if (url.pathname === '/v4/aliases') {
      return json({ aliases: [...state.aliases.values()].filter(a => a.projectId === url.searchParams.get('projectId')) });
    }
    if (url.pathname.startsWith('/v4/aliases/')) {
      const alias = state.aliases.get(url.pathname.split('/').at(-1));
      return alias ? json(alias) : json({}, 404);
    }
    if (url.pathname.startsWith('/v2/aliases/')) {
      assert.equal(method, 'DELETE');
      const uid = url.pathname.split('/').at(-1);
      for (const [host, alias] of state.aliases) if (alias.uid === uid) state.aliases.delete(host);
      return json({});
    }
    if (url.pathname.endsWith('/aliases')) {
      assert.equal(method, 'POST');
      const id = url.pathname.split('/')[3];
      const target = state.deployments.get(id);
      assert.ok(target);
      state.aliases.set(body.alias, { uid: 'alias_new', alias: body.alias, deploymentId: id, projectId: target.projectId });
      return json({});
    }
    if (url.pathname === '/v7/deployments') {
      return json({ deployments: [...state.deployments.values()]
        .filter(d => d.projectId === url.searchParams.get('projectId') &&
          (d.meta.githubCommitSha ?? d.gitSource?.sha) === url.searchParams.get('sha'))
        .filter(d => !url.searchParams.has('state') || d.readyState === url.searchParams.get('state'))
        .map(d => ({ uid: d.id })) });
    }
    if (url.pathname === '/v13/deployments' && method === 'POST') {
      assert.equal(url.searchParams.get('forceNew'), '1');
      const source = state.deployments.get(body.deploymentId);
      assert.deepEqual(body, { deploymentId: source.id, name: source.name, project: source.projectId, meta: { action: 'redeploy' } });
      const refreshed = { ...source, id: 'dpl_refresh', source: 'cli', createdAt: prOpenedMs + 2000, readyState: 'BUILDING' };
      state.deployments.set(refreshed.id, refreshed);
      return json(refreshed);
    }
    const id = url.pathname.split('/').at(-1);
    const detail = id === 'deploy.vercel.app' ? state.eventDeployment : state.deployments.get(id);
    return detail ? json(detail) : json({}, 404);
  };
  const api = createApi(credentials, { fetchFn, sleep: async ms => delays.push(ms) });
  return {
    calls, delays, state,
    // Comments are off unless a test passes `comments: f.comments`, so existing write assertions stay exact.
    comments: api.comments,
    run: (overrides = {}) => previewAuth({ eventName: 'deployment_status', event: deploymentEvent, repo, matrix: apps, domain, targetBranch: 'dev', ...api, comments: undefined, ...overrides }),
    writes: () => calls.filter(c => c.method !== 'GET'),
  };
}

test('validates ownership, app names, domains, callback paths and OAuth client keys', () => {
  for (const name of ['../web', 'WEB', 'web.example', '__proto__']) assert.throws(() => validateMatrix([{ ...web, app: name }], domain, repo));
  for (const candidate of ['vana.boo.evil/', '*.vana.boo', 'vana.boo:443']) assert.throws(() => validateMatrix([web], candidate, repo));
  for (const path of ['//evil.example', '/login/../callback', '/callback?secret=z', '/callback/*']) {
    assert.throws(() => validateMatrix([{ ...web, callback_paths: [path] }], domain, repo));
  }
  assert.throws(() => validateMatrix([{ ...web, client_id_key: 'ACCOUNT_ADMIN_TOKEN' }], domain, repo));
  assert.throws(() => validateMatrix([{ ...web, project_id: account.project_id }], domain, repo));
  assert.throws(() => validateMatrix([web], domain, 'vana-com/my-two-cents'));
});

test('rejects malicious deployment URLs and deployments outside the matching project or repository', async () => {
  for (const environment_url of ['https://deploy.vercel.app.evil.test', 'https://user@deploy.vercel.app', 'https://deploy.vercel.app/path']) {
    const f = fixture();
    assert.equal((await f.run({ event: { ...deploymentEvent, deployment_status: { state: 'success', environment_url } } })).state, 'ignored');
    assert.equal(f.calls.length, 0);
  }
  for (const details of [
    { projectId: 'prj_other' }, { meta: { githubCommitOrg: 'foreign', githubCommitRepo: 'repo', githubCommitSha: sha } },
    { target: 'production' }, { customEnvironment: 'dev' },
  ]) {
    const f = fixture({ deployments: [deployment(web, details)] });
    assert.equal((await f.run()).state, 'ignored');
    assert.deepEqual(f.writes(), []);
  }
});

test('Step 0 uses existing dev databases and blocks only explicit Neon with a migration path', async () => {
  for (const details of [{}, { needs_neon: false, migrations_path: 'db/migrations' }, { needs_neon: true }]) {
    const f = fixture({ apps: [{ ...web, ...details }] });
    assert.equal((await f.run()).state, 'published');
    assert.deepEqual(f.state.clientUris.get('web-dev'), [webUri]);
    assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_web');
  }
  const f = fixture({ apps: [{ ...web, needs_neon: true, migrations_path: 'db/migrations' }] });
  assert.equal((await f.run()).state, 'required-unavailable');
  assert.deepEqual(f.writes(), []);
});

test('fork PRs make no credentialed requests', async () => {
  const f = fixture();
  const fork = { ...basePr, head: { ...basePr.head, repo: { full_name: 'someone/unity-surfaces' } } };
  assert.equal((await f.run(pullEvent('opened', fork))).state, 'ignored');
  assert.deepEqual(f.calls, []);
});

test('workflow_run publishes only after matching the signal to a fresh same-repository PR', async () => {
  const f = fixture({ apps: [web] });
  const result = await f.run(signal({ event: 'deployment_status', head_branch: null }));
  assert.equal(result.state, 'published');
  assert.equal(f.calls[0].origin, 'https://api.github.com');
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_web');
  const writes = f.writes().length;
  assert.equal((await f.run(signal())).state, 'published');
  assert.equal(f.writes().length, writes);
});

test('workflow_run reports the latest failed build while preserving its alias and publishing a sibling app', async () => {
  const lastGood = deployment(web, { id: 'dpl_last_good', meta: { ...deployment(web).meta, githubCommitSha: nextSha } });
  const olderReady = deployment(web, { id: 'dpl_earlier', createdAt: prOpenedMs + 1500 });
  const failure = deployment(web, { id: 'dpl_failed', readyState: 'ERROR', createdAt: prOpenedMs + 2000 });
  const f = fixture({
    apps: [web, open], aliases: [mapping(web, lastGood.id)],
    deployments: [lastGood, olderReady, failure, deployment(open)],
  });
  const result = await f.run(signal({ event: 'deployment_status' }));
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.failures.map(item => [item.app, item.reason]), [['web', 'Deployment failed']]);
  assert.deepEqual(result.results, [{ app: 'open', state: 'published' }]);
  assert.equal(f.state.aliases.get(host('web')).deploymentId, lastGood.id);
  assert.equal(f.state.aliases.get(host('open')).deploymentId, 'dpl_open');
});

test('workflow_run reports a non-PR-ID app build failure and treats canceled apps as skipped', async () => {
  const canceled = deployment(open, { readyState: 'CANCELED' });
  const failure = deployment(account, { readyState: 'ERROR' });
  const f = fixture({ apps: [web, account, open], deployments: [deployment(web), canceled, failure] });
  const result = await f.run(signal({ event: 'deployment_status' }));
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.failures.map(item => [item.app, item.reason]), [['account', 'Deployment failed']]);
  assert.deepEqual(result.results, [{ app: 'web', state: 'published' }, { app: 'open', state: 'deployment-canceled' }]);
  assert.deepEqual([...f.state.aliases.keys()], [host('web')]);
});

test('workflow_run skips fork, foreign workflow and malformed signal metadata before any service request', async () => {
  for (const details of [
    { head_repository: { full_name: 'fork/unity-surfaces' } },
    { repository: { full_name: 'repo/other' } },
    { path: '.github/workflows/different.yml' },
    { head_sha: '../evil' },
  ]) {
    const f = fixture();
    assert.equal((await f.run(signal(details))).state, 'ignored');
    assert.deepEqual(f.calls, []);
  }
});

test('workflow_run resolves the current PR and rejects a fork even if the run reports the base repository', async () => {
  const fork = { ...basePr, head: { ...basePr.head, repo: { full_name: 'someone/unity-surfaces' } } };
  const f = fixture({ pr: fork });
  assert.equal((await f.run(signal())).state, 'ignored');
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(c => c.origin === 'https://api.github.com'));
});

test('workflow_run branch lookup finds closed unmerged and retargeted PRs outside commit associations', async () => {
  for (const pr of [closedPr, { ...basePr, base: { ref: 'main' } }]) {
    const f = fixture({
      apps: [web], pr, aliases: [mapping(web)], clientUris: { 'web-dev': [webUri] },
      intercept: ({ url }) => {
        if (url.pathname.includes('/commits/')) return json([]);
        if (url.searchParams.get('state') === 'all') {
          assert.equal(url.searchParams.get('head'), 'vana-com:topic');
          return json([pr]);
        }
      },
    });
    assert.equal((await f.run(signal())).state, 'cleanup-checked');
    assert.equal(f.state.aliases.size, 0);
    assert.deepEqual(f.state.clientUris.get('web-dev'), []);
  }
});

test('workflow_run stale head signal cannot publish or mutate credentials for the new head', async () => {
  const f = fixture({ pr: { ...basePr, head: { ...basePr.head, sha: nextSha } } });
  assert.equal((await f.run(signal())).state, 'ignored');
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(c => c.origin === 'https://api.github.com'));
});

test('workflow_run verifies a closed PR signaled with its GitHub merge SHA', async () => {
  const f = fixture({
    apps: [web], pr: { ...closedPr, merge_commit_sha: nextSha }, aliases: [mapping(web)],
    intercept: ({ url }) => url.pathname.includes('/commits/') || url.searchParams.get('state') === 'all' ? json([]) : undefined,
  });
  const result = await f.run(signal({ head_sha: nextSha, head_branch: 'dev', pull_requests: [{ number: basePr.number }] }));
  assert.equal(result.state, 'cleanup-checked');
  assert.equal(f.state.aliases.size, 0);
});

test('static app can publish without any Account configuration', async () => {
  const f = fixture({ apps: [open], deployments: [deployment(open)], clientUris: {}, env: { ACCOUNT_ADMIN_TOKEN: undefined } });
  assert.equal((await f.run()).state, 'published');
  assert.equal(f.calls.some(c => c.origin.includes('account-dev')), false);
});

test('old builds are ignored and an in-flight force-push removes only the deployment just set', async () => {
  let f = fixture({ pr: { ...basePr, head: { ...basePr.head, sha: nextSha } } });
  assert.equal((await f.run()).state, 'stale');
  assert.deepEqual(f.writes(), []);
  f = fixture({ intercept: ({ method, path, state }) => {
    if (method === 'POST' && path.startsWith('/v2/deployments/')) state.pr = { ...basePr, head: { ...basePr.head, sha: nextSha } };
  } });
  assert.equal((await f.run()).state, 'stale');
  assert.equal(f.state.aliases.size, 0);
  assert.deepEqual(f.state.clientUris.get('web-dev'), [webUri]);
});

test('stale-head cleanup preserves a newer alias assignment', async () => {
  let assigned = false;
  const f = fixture({
    deployments: [deployment(web), deployment(web, { id: 'dpl_new', meta: { ...deployment(web).meta, githubCommitSha: nextSha } })],
    intercept: ({ method, path, state }) => {
      if (method === 'POST' && path.startsWith('/v2/deployments/')) assigned = true;
      if (assigned && path.endsWith('/pulls/12')) {
        state.pr = { ...basePr, head: { ...basePr.head, sha: nextSha } };
        state.aliases.set(host('web'), mapping(web, 'dpl_new'));
      }
    },
  });
  assert.equal((await f.run()).state, 'stale');
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_new');
  assert.equal(f.writes().some(c => c.method === 'DELETE'), false);
});

test('close mid-publish revokes exact callbacks even when assignment never happened', async () => {
  const f = fixture({ intercept: ({ method, origin, state }) => {
    if (method === 'POST' && origin === 'https://account-dev.vana.org') state.pr = closedPr;
  } });
  assert.equal((await f.run()).state, 'stale');
  assert.equal(f.state.aliases.size, 0);
  assert.deepEqual(f.state.clientUris.get('web-dev'), []);
  assert.deepEqual(f.writes().map(c => c.body?.action), ['add', 'remove']);
});

test('close after assignment removes both the just-assigned alias and its callbacks', async () => {
  const f = fixture({ intercept: ({ method, path, state }) => {
    if (method === 'POST' && path.startsWith('/v2/deployments/')) state.pr = closedPr;
  } });
  assert.equal((await f.run()).state, 'stale');
  assert.equal(f.state.aliases.size, 0);
  assert.deepEqual(f.state.clientUris.get('web-dev'), []);
});

test('closed cleanup removes all aliases before Account calls and isolates a failed exact callback', async () => {
  const secondUri = `https://${host('web')}/second/callback`;
  const f = fixture({
    apps: [{ ...web, callback_paths: [...web.callback_paths, '/second/callback'] }, open],
    pr: closedPr, aliases: [mapping(web), mapping(open)], deployments: [deployment(web), deployment(open)],
    clientUris: { 'web-dev': [webUri, secondUri, unknownPath] },
    intercept: ({ method, body }) => {
      if (method === 'POST' && body?.redirect_uri === webUri) return json({ error: 'secret response body' }, 503);
    },
  });
  const result = await f.run(pullEvent('closed'));
  assert.equal(result.state, 'failed');
  assert.match(result.failures[0].reason, /Account request failed \(503\)/);
  assert.equal(JSON.stringify(result).includes('secret response body'), false);
  assert.deepEqual(f.writes().map(c => c.method), ['DELETE', 'DELETE', 'POST', 'POST', 'POST', 'POST', 'POST']);
  assert.equal(f.state.aliases.size, 0);
  assert.deepEqual(f.state.clientUris.get('web-dev'), [webUri]);
  assert.deepEqual(f.delays, [500, 1000]);
  const accountCalls = f.calls.filter(c => c.origin === 'https://account-dev.vana.org');
  assert.deepEqual(accountCalls.map(c => c.method), ['GET', 'GET', 'POST', 'GET', 'POST', 'GET', 'POST', 'GET', 'POST', 'GET', 'POST']);
});

test('a closed PR alias now pointing to a foreign deployment is preserved', async () => {
  const foreign = deployment(web, { id: 'dpl_foreign', meta: { ...deployment(web).meta, githubCommitOrg: 'foreign' } });
  const f = fixture({ pr: closedPr, aliases: [mapping(web, foreign.id)], deployments: [foreign] });
  const result = await f.run(pullEvent('closed'));
  assert.equal(result.state, 'failed');
  assert.equal(result.failures[0].reason, 'Alias ownership refused');
  assert.deepEqual(f.writes(), []);
});

test('cleanup re-reads the alias immediately before delete and preserves a changed target', async () => {
  let reads = 0;
  const f = fixture({
    pr: closedPr, aliases: [mapping(web)],
    intercept: ({ path, state }) => {
      if (path.endsWith(host('web')) && ++reads === 2) state.aliases.set(host('web'), mapping(web, 'dpl_new'));
    },
  });
  const result = await f.run(pullEvent('closed'));
  assert.equal(result.state, 'failed');
  assert.equal(result.failures[0].reason, 'Alias changed during cleanup');
  assert.deepEqual(f.writes(), []);
});

test('cleanup fails when Vercel reports successful delete but alias GET still resolves', async () => {
  const f = fixture({
    pr: closedPr, aliases: [mapping(web)],
    intercept: ({ method }) => method === 'DELETE' ? json({}) : undefined,
  });
  const result = await f.run(pullEvent('closed'));
  assert.deepEqual(result.failures, [{ app: 'web', operation: 'reconcile PR #12 alias', reason: 'Alias removal unconfirmed' }]);
  assert.equal(f.state.aliases.has(host('web')), true);
  assert.deepEqual(f.delays, [250, 1000]);
});

test('a transient delete failure rechecks the target before retrying', async () => {
  const f = fixture({
    pr: closedPr, aliases: [mapping(web)],
    intercept: ({ method, state }) => {
      if (method !== 'DELETE') return;
      state.aliases.set(host('web'), mapping(web, 'dpl_new'));
      return json({}, 503);
    },
  });
  const result = await f.run(pullEvent('closed'));
  assert.equal(result.failures[0].reason, 'Alias changed during cleanup');
  assert.deepEqual(f.writes().map(c => c.method), ['DELETE']);
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_new');
});

test('decommission fails when a purported callback removal still lists the URI', async () => {
  const f = fixture({
    clientUris: { 'web-dev': [webUri] },
    intercept: ({ method, origin }) => method === 'POST' && origin === 'https://account-dev.vana.org'
      ? json({ redirect_uris: [webUri] }) : undefined,
  });
  assert.equal((await f.run(dispatch)).failures[0].reason, 'Account callback update unconfirmed');
});

test('assignment success requires a read showing the intended alias target', async () => {
  const f = fixture({ intercept: ({ path, method }) => method === 'POST' && path.startsWith('/v2/deployments/') ? json({}) : undefined });
  assert.equal((await f.run()).failures[0].reason, 'Alias assignment unconfirmed');
});

test('Account 404 during removal is already gone, including between GET and POST', async () => {
  for (const race of [false, true]) {
    const f = fixture({
      pr: closedPr, aliases: [mapping(web)], clientUris: race ? { 'web-dev': [webUri] } : {},
      env: { PREVIEW_DEV_CLIENT_IDS: 'web-dev' },
      intercept: ({ method, origin, state }) => {
        if (method === 'POST' && origin === 'https://account-dev.vana.org') {
          state.clientUris.delete('web-dev');
          return json({}, 404);
        }
      },
    });
    assert.equal((await f.run(pullEvent('closed'))).state, 'cleanup-checked');
    assert.equal(f.state.aliases.size, 0);
  }
});

test('missing Account credentials leave alias cleanup independent across apps', async () => {
  const f = fixture({
    pr: closedPr, aliases: [mapping(web), mapping(open)],
    deployments: [deployment(web), deployment(open)], env: { ACCOUNT_ADMIN_TOKEN: undefined, WEB_CLIENT_ID: undefined },
  });
  const result = await f.run(pullEvent('closed'));
  assert.equal(result.state, 'failed');
  assert.equal(result.failures.every(f => f.reason === 'Missing Account credentials'), true);
  assert.equal(f.state.aliases.size, 0);
});

test('a missing app client key blocks only its publish and never blocks static cleanup', async () => {
  const f = fixture({ aliases: [mapping(open)], deployments: [deployment(web), deployment(open)], env: { WEB_CLIENT_ID: undefined } });
  assert.equal((await f.run()).failures[0].reason, 'Missing Account client ID');
  assert.deepEqual(f.writes(), []);
  f.state.pr = closedPr;
  assert.equal((await f.run(pullEvent('closed'))).state, 'cleanup-checked');
  assert.equal(f.state.aliases.size, 0);
});

test('cleanup continues through another project when one Vercel listing fails', async () => {
  const f = fixture({
    pr: closedPr, aliases: [mapping(web), mapping(open)], deployments: [deployment(web), deployment(open)],
    clientUris: { 'web-dev': [webUri] },
    intercept: ({ url }) => url.pathname === '/v4/aliases' && url.searchParams.get('projectId') === web.project_id
      ? json({ error: 'private payload' }, 401) : undefined,
  });
  const result = await f.run(sweep);
  assert.equal(result.failures[0].reason, 'Vercel request failed (401)');
  assert.equal(f.state.aliases.has(host('web')), true);
  assert.equal(f.state.aliases.has(host('open')), false);
  assert.deepEqual(f.state.clientUris.get('web-dev'), []);
});

test('retargeted PR cleanup is immediate and an eligible reopened PR is preserved', async () => {
  const f = fixture({ aliases: [mapping(web)], clientUris: { 'web-dev': [webUri] } });
  assert.equal((await f.run(pullEvent('closed'))).state, 'cleanup-checked');
  assert.deepEqual(f.writes(), []);
  f.state.pr = { ...basePr, base: { ref: 'main' } };
  assert.equal((await f.run(pullEvent('edited'))).state, 'cleanup-checked');
  assert.equal(f.state.aliases.size, 0);
  assert.deepEqual(f.state.clientUris.get('web-dev'), []);
});

test('reopening publishes the existing current-head preview without a new push', async () => {
  const f = fixture({ apps: [web], pr: closedPr, aliases: [mapping(web)], clientUris: { 'web-dev': [webUri] } });
  await f.run(pullEvent('closed'));
  f.state.pr = basePr;
  assert.equal((await f.run(pullEvent('reopened'))).state, 'published');
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_web');
  assert.deepEqual(f.state.clientUris.get('web-dev'), [webUri]);
});

test('first-open refresh redeploys a native pre-PR Web build without enrolling or aliasing it', async () => {
  const old = deployment(web, { createdAt: prOpenedMs - 1000 });
  const f = fixture({ apps: [web], deployments: [old] });
  const opened = await f.run(pullEvent('opened'));
  assert.deepEqual(opened.results, [{ app: 'web', state: 'redeploy-requested' }]);
  assert.deepEqual(f.writes().map(c => c.path), ['/v13/deployments']);
  assert.equal(f.state.aliases.size, 0);
  assert.deepEqual(f.state.clientUris.get('web-dev'), []);
  assert.equal((await f.run()).state, 'awaiting-deployment');
  assert.equal(f.writes().length, 1);
  const refreshed = f.state.deployments.get('dpl_refresh');
  refreshed.readyState = 'READY';
  f.state.eventDeployment = refreshed;
  assert.equal((await f.run()).state, 'published');
  assert.equal(f.state.aliases.get(host('web')).deploymentId, refreshed.id);
  assert.deepEqual(f.state.clientUris.get('web-dev'), [webUri]);
});

test('late pre-PR success finds and publishes the ready post-PR deployment instead', async () => {
  const old = deployment(web, { createdAt: prOpenedMs - 1000 });
  const refreshed = deployment(web, { id: 'dpl_refresh', source: 'cli' });
  const f = fixture({ apps: [web], deployments: [old, refreshed] });
  assert.equal((await f.run()).state, 'published');
  assert.equal(f.state.aliases.get(host('web')).deploymentId, refreshed.id);
  assert.equal(f.writes().some(c => c.path === '/v13/deployments'), false);
});

test('scheduled and reopened recovery can refresh a pre-PR build that failed closed', async () => {
  const old = deployment(web, { createdAt: prOpenedMs - 1000, readyState: 'ERROR' });
  for (const event of [sweep, pullEvent('reopened')]) {
    const f = fixture({ apps: [web], deployments: [old] });
    assert.deepEqual((await f.run(event)).results, [{ app: 'web', state: 'redeploy-requested' }]);
    assert.deepEqual(f.writes().map(c => c.path), ['/v13/deployments']);
  }
});

test('an ambiguous redeploy POST is sent once and a discovered build prevents repetition', async () => {
  const old = deployment(web, { createdAt: prOpenedMs - 1000 });
  const f = fixture({
    apps: [web], deployments: [old],
    intercept: ({ method, path, state }) => {
      if (method !== 'POST' || path !== '/v13/deployments') return;
      state.deployments.set('dpl_refresh', deployment(web, { id: 'dpl_refresh', source: 'cli', readyState: 'BUILDING', meta: {} }));
      throw new Error('connection lost after acceptance');
    },
  });
  assert.equal((await f.run(pullEvent('opened'))).state, 'failed');
  assert.equal(f.writes().length, 1);
  assert.equal((await f.run()).state, 'awaiting-deployment');
  assert.equal(f.writes().length, 1);
  assert.equal(f.state.aliases.size, 0);
});

test('pre-PR refresh refuses non-Git, prebuilt, other-branch and ambiguous deployments', async () => {
  const old = deployment(web, { createdAt: prOpenedMs - 1000 });
  for (const overrides of [
    { source: 'cli' }, { prebuilt: true }, { createdAt: undefined },
    { gitSource: { ...old.gitSource, ref: 'another-pr' } }, { gitSource: { ...old.gitSource, repoId: 1 } },
  ]) {
    const f = fixture({ apps: [web], deployments: [{ ...old, ...overrides }] });
    assert.equal((await f.run(pullEvent('opened'))).state, 'awaiting-deployment');
    assert.deepEqual(f.writes(), []);
  }
});

test('a post-PR build missing the expected PR ID leaves callbacks and aliases untouched', async () => {
  const post = deployment(web, { meta: { ...deployment(web).meta, githubPrId: '13' } });
  const f = fixture({ apps: [web], deployments: [post] });
  assert.equal((await f.run()).state, 'awaiting-deployment');
  assert.deepEqual(f.writes(), []);
});

test('a force-push or close before the redeploy POST prevents rebuilding the old head', async () => {
  const old = deployment(web, { createdAt: prOpenedMs - 1000 });
  for (const pr of [closedPr, { ...basePr, head: { ...basePr.head, sha: nextSha } }]) {
    const f = fixture({
      apps: [web], deployments: [old],
      intercept: ({ path, state }) => {
        if (path === '/v7/deployments') state.pr = pr;
      },
    });
    assert.deepEqual((await f.run(pullEvent('opened'))).results, [{ app: 'web', state: 'stale' }]);
    assert.deepEqual(f.writes(), []);
  }
});

test('apps without PR-ID dependencies can publish a pre-PR build directly', async () => {
  for (const entry of [account, open]) {
    const f = fixture({ apps: [entry], deployments: [deployment(entry, { createdAt: prOpenedMs - 1000 })] });
    assert.equal((await f.run(pullEvent('opened'))).state, 'published');
    assert.equal(f.state.aliases.get(host(entry.app)).deploymentId, `dpl_${entry.app}`);
    assert.equal(f.writes().some(c => c.path === '/v13/deployments'), false);
  }
});

test('daily recovery replaces a previously aliased pre-PR build only when the refresh is ready', async () => {
  const old = deployment(web, { createdAt: prOpenedMs - 1000 });
  const f = fixture({ apps: [web], aliases: [mapping(web)], deployments: [old] });
  assert.deepEqual((await f.run(sweep)).results, [{ app: 'web', state: 'redeploy-requested' }]);
  assert.equal(f.state.aliases.get(host('web')).deploymentId, old.id);
  f.state.deployments.get('dpl_refresh').readyState = 'READY';
  assert.deepEqual((await f.run(sweep)).results, [{ app: 'web', state: 'published' }]);
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_refresh');
});

test('scheduled cleanup finds aliases and callback-only entries for former matrix apps', async () => {
  const removedAccountUri = `https://${host('account')}/auth/oidc/callback`;
  const f = fixture({
    apps: [open], aliases: [mapping(web)],
    clientUris: { 'retired-dev': [webUri, removedAccountUri, 'https://unrelated.example/callback'] },
  });
  assert.equal((await f.run(sweep)).state, 'cleanup-checked');
  assert.equal(f.state.aliases.size, 0);
  assert.deepEqual(f.state.clientUris.get('retired-dev'), ['https://unrelated.example/callback']);
  assert.deepEqual(new Set(f.calls.filter(c => c.path === '/v4/aliases').map(c => c.path)), new Set(['/v4/aliases']));
  assert.equal(f.calls.filter(c => c.path === '/v4/aliases').length, 6);
});

test('scheduled cleanup removes callback-only closed PRs and keeps unrelated exact entries', async () => {
  const f = fixture({ pr: closedPr, clientUris: { 'web-dev': [webUri, unknownPath, 'https://unrelated.example/auth/callback'] } });
  assert.equal((await f.run(sweep)).state, 'cleanup-checked');
  assert.deepEqual(f.state.clientUris.get('web-dev'), ['https://unrelated.example/auth/callback']);
});

test('daily sweep publishes a verified build whose deployment event left no artifacts', async () => {
  const f = fixture();
  const result = await f.run(sweep);
  assert.equal(result.state, 'cleanup-checked');
  assert.deepEqual(result.results, [{ app: 'web', state: 'published' }]);
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_web');
  assert.deepEqual(f.state.clientUris.get('web-dev'), [webUri]);
  assert.equal(f.state.aliases.size, 1);
});

test('daily sweep repairs an Account outage before the first alias or callback', async () => {
  let accountDown = true;
  const f = fixture({
    apps: [web],
    intercept: ({ origin }) => accountDown && origin === 'https://account-dev.vana.org' ? json({}, 503) : undefined,
  });
  assert.equal((await f.run()).state, 'failed');
  assert.deepEqual(f.writes(), []);
  accountDown = false;
  assert.equal((await f.run(sweep)).state, 'cleanup-checked');
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_web');
  assert.deepEqual(f.state.clientUris.get('web-dev'), [webUri]);
});

test('daily recovery paginates open PRs and ignores fork or retargeted PRs', async () => {
  const fork = { ...basePr, number: 13, head: { ...basePr.head, repo: { full_name: 'fork/unity-surfaces' } } };
  const retargeted = { ...basePr, number: 14, base: { ref: 'main' } };
  const pages = [];
  const f = fixture({
    apps: [web],
    intercept: ({ url }) => {
      if (url.searchParams.get('state') !== 'open') return;
      const page = Number(url.searchParams.get('page'));
      const perPage = Number(url.searchParams.get('per_page'));
      assert.equal(url.searchParams.get('base'), 'dev');
      assert.ok(perPage > 0);
      pages.push(page);
      return json(page === 1 ? Array.from({ length: perPage }, () => fork) : [retargeted, basePr]);
    },
  });
  assert.equal((await f.run(sweep)).state, 'cleanup-checked');
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual([...f.state.aliases.keys()], [host('web')]);
});

test('daily recovery preserves a last good alias even when GitHub has a newer eligible build', async () => {
  const previous = deployment(web, { id: 'dpl_previous', meta: { ...deployment(web).meta, githubCommitSha: nextSha } });
  for (const aliasInList of [true, false]) {
    const f = fixture({
      apps: [web], aliases: [mapping(web, previous.id)], deployments: [deployment(web), previous],
      intercept: ({ path }) => !aliasInList && path === '/v4/aliases' ? json({ aliases: [] }) : undefined,
    });
    assert.equal((await f.run(sweep)).state, 'cleanup-checked');
    assert.equal(f.state.aliases.get(host('web')).deploymentId, previous.id);
    assert.deepEqual(f.writes(), []);
  }
});

test('daily recovery rechecks the PR head after reading the deployment', async () => {
  const f = fixture({
    apps: [web],
    intercept: ({ path, state }) => {
      if (path === '/v7/deployments') state.pr = { ...basePr, head: { ...basePr.head, sha: nextSha } };
    },
  });
  assert.equal((await f.run(sweep)).state, 'cleanup-checked');
  assert.deepEqual(f.writes(), []);
});

test('decommission drains open PR artifacts across the full repo namespace and is idempotent', async () => {
  const f = fixture({
    apps: [], aliases: [mapping(web), mapping(open)], deployments: [deployment(web), deployment(open)],
    clientUris: { 'web-dev': [webUri, unknownPath, 'https://unrelated.example/auth/callback'] },
  });
  assert.equal((await f.run(dispatch)).state, 'decommissioned');
  assert.equal(f.state.aliases.size, 0);
  assert.deepEqual(f.state.clientUris.get('web-dev'), ['https://unrelated.example/auth/callback']);
  const count = f.writes().length;
  assert.equal((await f.run(dispatch)).state, 'decommissioned');
  assert.equal(f.writes().length, count);
  assert.equal((await f.run({ ...sweep, decommission: true })).state, 'ignored');
});

test('sweep repairs an expired alias only with a ready owned deployment for the current head', async () => {
  const expired = mapping(open, 'dpl_expired');
  let f = fixture({ apps: [open], aliases: [expired], deployments: [deployment(open)] });
  assert.equal((await f.run(sweep)).state, 'cleanup-checked');
  assert.equal(f.state.aliases.get(host('open')).deploymentId, 'dpl_open');
  for (const replacement of [
    deployment(open, { readyState: 'ERROR' }),
    deployment(open, { meta: { ...deployment(open).meta, githubCommitRepo: 'foreign' } }),
    deployment(open, { meta: { ...deployment(open).meta, githubCommitSha: nextSha } }),
  ]) {
    f = fixture({ apps: [open], aliases: [expired], deployments: [replacement] });
    const result = await f.run(sweep);
    assert.equal(result.state, 'push-needed');
    assert.deepEqual(result.pushNeeded, [host('open')]);
    assert.deepEqual(f.writes(), []);
  }
});

test('sweep keeps a last good alias when a newer deployment failed', async () => {
  const f = fixture({ aliases: [mapping(web)], deployments: [deployment(web)], pr: { ...basePr, head: { ...basePr.head, sha: nextSha } } });
  assert.equal((await f.run(sweep)).state, 'cleanup-checked');
  assert.deepEqual(f.writes(), []);
});

test('a failed app build preserves its alias while another project publishes', async () => {
  const f = fixture({ aliases: [mapping(web)], deployments: [deployment(web), deployment(open)] });
  const failed = await f.run({ event: { ...deploymentEvent, deployment_status: { ...deploymentEvent.deployment_status, state: 'failure' } } });
  assert.equal(failed.failures[0].reason, 'Deployment failed');
  assert.deepEqual(f.writes(), []);
  f.state.eventDeployment = f.state.deployments.get('dpl_open');
  assert.equal((await f.run()).state, 'published');
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_web');
  assert.equal(f.state.aliases.get(host('open')).deploymentId, 'dpl_open');
});

test('production Account origin and unallowlisted client IDs are refused before any API call to Account', async () => {
  for (const env of [
    { ACCOUNT_ORIGIN: 'https://account.vana.org' },
    { WEB_CLIENT_ID: 'prod-client' },
    { WEB_CLIENT_ID: 'secret/with space' },
    { PREVIEW_DEV_CLIENT_IDS: undefined },
  ]) {
    const f = fixture({ env });
    assert.equal((await f.run()).state, 'failed');
    assert.equal(f.calls.some(c => c.origin.includes('account')), false);
    assert.deepEqual(f.writes(), []);
  }
});

test('shared Account client is refused on publish or cleanup before mutating its exact URI list', async () => {
  const f = fixture({ clientUris: { 'web-dev': [foreignUri] }, env: { PREVIEW_DEV_CLIENT_IDS: 'web-dev, account-dev' } });
  const published = await f.run();
  assert.equal(published.failures[0].reason, 'Account client has callbacks owned by another repository');
  assert.deepEqual(f.writes(), []);
  f.state.clientUris.set('web-dev', [foreignUri, webUri]);
  f.state.pr = closedPr;
  const closed = await f.run(pullEvent('closed'));
  assert.equal(closed.failures[0].reason, 'Account client has callbacks owned by another repository');
  assert.deepEqual(f.writes(), []);
});

test('Account outage preserves the last good alias and reports sanitized service failure', async () => {
  const f = fixture({
    aliases: [mapping(web, 'dpl_last_good')],
    deployments: [deployment(web), deployment(web, { id: 'dpl_last_good', meta: { ...deployment(web).meta, githubCommitSha: nextSha } })],
    intercept: ({ origin }) => origin === 'https://account-dev.vana.org' ? json({ error: 'private body' }, 503) : undefined,
  });
  const result = await f.run();
  assert.equal(result.failures[0].reason, 'Account request failed (503)');
  assert.deepEqual(f.writes(), []);
  assert.equal(f.state.aliases.get(host('web')).deploymentId, 'dpl_last_good');
});

test('publication preserves a foreign target without granting it an Account callback', async () => {
  const foreign = deployment(web, { id: 'dpl_foreign', meta: { ...deployment(web).meta, githubCommitOrg: 'foreign' } });
  const f = fixture({ aliases: [mapping(web, foreign.id)], deployments: [deployment(web), foreign] });
  assert.equal((await f.run()).failures[0].reason, 'Alias ownership refused');
  assert.deepEqual(f.writes(), []);
});

test('retries 429, clamps Retry-After and succeeds', async () => {
  const delays = []; let calls = 0;
  const response = await retryRequest(async () => ++calls === 1
    ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '999' }) }
    : { ok: true }, async ms => delays.push(ms), 'https://example.test', {});
  assert.equal(response.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [5000]);
});

test('does not retry 401 and reports exhausted transient failures', async () => {
  for (const [status, expected] of [[401, 1], [503, 3]]) {
    let calls = 0;
    await assert.rejects(retryRequest(async () => { calls++; return { ok: false, status }; }, async () => {}, 'https://example.test', {}), new RegExp(`API request failed \\(${status}\\)`));
    assert.equal(calls, expected);
  }
});


test('close and sweep remove historical callback paths after path rename or callback removal', async () => {
  for (const app of [{...web, callback_paths: ['/auth/callback']}, {...web, callback_paths: [], client_id_key: undefined}]) {
    for (const event of [pullEvent('closed'), sweep]) {
      const f = fixture({apps: [app], pr: closedPr, clientUris: {'web-dev': [webUri, `https://${host('web')}/?legacy=1`, 'https://unrelated.example/callback']}});
      assert.equal((await f.run(event)).state, 'cleanup-checked');
      assert.deepEqual(f.state.clientUris.get('web-dev'), ['https://unrelated.example/callback']);
    }
  }
});

const runUrl = 'https://github.com/vana-com/unity-surfaces/actions/runs/77';

test('renders one table row per app with a link only when the preview is live', () => {
  const body = renderPreviewComment({
    pr: 12, sha, runUrl,
    rows: [
      { app: 'web', host: host('web'), state: 'ready' },
      { app: 'account', host: host('account'), state: 'building' },
      { app: 'open', host: host('open'), state: 'failed' },
      { app: 'metrics', host: host('metrics'), state: 'ready' },
    ],
  });
  assert.ok(body.startsWith(`${COMMENT_MARKER}\n`));
  assert.match(body, /Commit `aaaaaaa` · \[Workflow run\]\(https:\/\/github.com\/vana-com\/unity-surfaces\/actions\/runs\/77\)/);
  assert.match(body, /\| web \| \[web-pr-12.vana.boo\]\(https:\/\/web-pr-12.vana.boo\) \| ✅ Ready \|/);
  assert.match(body, /\| account \| `account-pr-12.vana.boo` \| ⏳ Building \|/);
  assert.match(body, /\| open \| `open-pr-12.vana.boo` \| ❌ Build failed — \[View logs\]\(https:\/\/github.com\/vana-com\/unity-surfaces\/actions\/runs\/77\) \|/);
  assert.match(body, /\| metrics \| \[metrics-pr-12.vana.boo\].*\(Vercel sign-in required\) \| ✅ Ready \|/);
  assert.match(body, /Sign in with your Vana account \(dev\)/);
});

test('render drops a run URL that is not a GitHub Actions run and labels unknown states', () => {
  const body = renderPreviewComment({ pr: 12, sha, runUrl: 'https://evil.example/x', rows: [{ app: 'web', host: host('web'), state: 'odd' }] });
  assert.equal(body.includes('evil.example'), false);
  assert.match(body, /Status unavailable/);
});

test('closed render keeps the marker and says previews were removed', () => {
  const body = renderPreviewComment({ closed: true });
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /Previews and sign-in callbacks removed/);
  assert.equal(body.includes('| App |'), false);
});

test('upsert creates once, edits when the body changes and skips an identical body', async () => {
  const store = [];
  const comments = {
    find: async () => store[0] ?? null,
    create: async (pr, body) => { store.push({ id: 1, body }); },
    update: async (id, body) => { store[0].body = body; },
  };
  assert.equal(await upsertPreviewComment(comments, 12, 'a'), 'created');
  assert.equal(await upsertPreviewComment(comments, 12, 'a'), 'unchanged');
  assert.equal(await upsertPreviewComment(comments, 12, 'b'), 'updated');
  assert.deepEqual(store, [{ id: 1, body: 'b' }]);
  const none = { find: async () => null, create: async () => assert.fail('must not create') };
  assert.equal(await upsertPreviewComment(none, 12, 'x', { createIfMissing: false }), 'skipped');
});

test('comment lookup trusts only the Actions bot, finds the marker on a later page and never edits a stranger', async () => {
  const botComment = (id, body) => ({ id, user: { login: 'github-actions[bot]', type: 'Bot' }, body });
  const filler = Array.from({ length: 100 }, (_, i) => botComment(i + 1, 'unrelated'));
  const spoof = { id: 500, user: { login: 'mallory', type: 'User' }, body: `${COMMENT_MARKER}\nfake` };
  const f = fixture({ initialComments: [spoof, ...filler.slice(1), botComment(700, `${COMMENT_MARKER}\nold`)] });
  assert.deepEqual(await f.comments.find(12), { id: 700, body: `${COMMENT_MARKER}\nold` });
  const lone = fixture({ initialComments: [spoof] });
  assert.equal(await lone.comments.find(12), null);
  assert.equal(await upsertPreviewComment(lone.comments, 12, `${COMMENT_MARKER}\nnew`), 'created');
  assert.equal(lone.state.comments.find(c => c.id === 500).body, `${COMMENT_MARKER}\nfake`);
});

test('a PR event posts one comment with each app state, then edits it instead of adding another', async () => {
  const f = fixture({ apps: [web, account, open], deployments: [deployment(web)] });
  const options = { comments: f.comments, runUrl };
  assert.equal((await f.run({ ...pullEvent('reopened'), ...options })).state, 'published');
  assert.equal(f.state.comments.length, 1);
  assert.match(f.state.comments[0].body, /\| web \| \[web-pr-12.vana.boo\]\(https:\/\/web-pr-12.vana.boo\) \| ✅ Ready \|/);
  assert.match(f.state.comments[0].body, /\| account \| `account-pr-12.vana.boo` \| ⏳ Building \|/);
  const before = f.writes().filter(c => c.origin === 'https://api.github.com').length;
  await f.run({ ...pullEvent('reopened'), ...options });
  assert.equal(f.writes().filter(c => c.origin === 'https://api.github.com').length, before, 'identical body must not be rewritten');
  f.state.deployments.set('dpl_account', deployment(account));
  await f.run({ ...pullEvent('reopened'), ...options });
  assert.equal(f.state.comments.length, 1);
  assert.match(f.state.comments[0].body, /\| account \| \[account-pr-12.vana.boo\].*\| ✅ Ready \|/);
});

test('a failed build shows as failed with the run link', async () => {
  const f = fixture({ apps: [web, open], deployments: [deployment(web), deployment(open, { readyState: 'ERROR' })] });
  await f.run({ ...pullEvent('reopened'), comments: f.comments, runUrl });
  assert.match(f.state.comments[0].body, /\| open \| `open-pr-12.vana.boo` \| ❌ Build failed — \[View logs\]/);
});

test('a stale alias on an older commit reads as updating while the new commit builds', async () => {
  const f = fixture({
    apps: [web], aliases: [mapping(web, 'dpl_old')],
    deployments: [deployment(web, { id: 'dpl_old', meta: { ...deployment(web).meta, githubCommitSha: nextSha }, gitSource: { ...deployment(web).gitSource, sha: nextSha } }),
      deployment(web, { readyState: 'BUILDING' })],
  });
  await f.run({ ...pullEvent('reopened'), comments: f.comments, runUrl });
  assert.match(f.state.comments[0].body, /\| web \| \[web-pr-12.vana.boo\].*\| 🔄 Updating/);
});

test('closing a PR edits the existing comment and creates none when no preview comment exists', async () => {
  const open_ = fixture({ apps: [web, open], aliases: [mapping(web)] });
  await open_.run({ ...pullEvent('reopened'), comments: open_.comments, runUrl });
  assert.equal(open_.state.comments.length, 1);
  open_.state.pr = closedPr;
  const result = await open_.run({ ...pullEvent('closed', closedPr), comments: open_.comments, runUrl });
  assert.equal(result.state, 'cleanup-checked');
  assert.equal(open_.state.comments.length, 1);
  assert.match(open_.state.comments[0].body, /Previews and sign-in callbacks removed/);
  const never = fixture({ apps: [web], pr: closedPr });
  await never.run({ ...pullEvent('closed', closedPr), comments: never.comments, runUrl });
  assert.deepEqual(never.state.comments, []);
  assert.deepEqual(never.writes().filter(c => c.origin === 'https://api.github.com'), []);
});

test('a comment permission failure is a warning, never a failed preview', async () => {
  const f = fixture({
    apps: [web], deployments: [deployment(web)],
    intercept: ({ origin, method }) => origin === 'https://api.github.com' && method === 'POST' ? json({ message: 'denied' }, 403) : undefined,
  });
  const result = await f.run({ ...pullEvent('reopened'), comments: f.comments, runUrl });
  assert.equal(result.state, 'published');
  assert.deepEqual(result.warnings, ['comment on PR #12: GitHub request failed (403)']);
  assert.equal(result.failures, undefined);
});

test('a Preview deployment signal run comments on each resolved PR and carries warnings up', async () => {
  const f = fixture({ apps: [web], deployments: [deployment(web)] });
  const result = await f.run({ ...signal(), comments: f.comments, runUrl });
  assert.equal(result.state, 'published');
  assert.equal(f.state.comments.length, 1);
  assert.match(f.state.comments[0].body, /✅ Ready/);
});

test('a direct deployment status refreshes the comment after success and after a failed build', async () => {
  const ok = fixture({ apps: [web], deployments: [deployment(web)] });
  assert.equal((await ok.run({ comments: ok.comments, runUrl })).state, 'published');
  assert.match(ok.state.comments[0].body, /\| web \| \[web-pr-12.vana.boo\].*\| ✅ Ready \|/);
  const failed = fixture({ apps: [web], deployments: [deployment(web, { readyState: 'ERROR' })] });
  failed.state.eventDeployment = failed.state.deployments.get('dpl_web');
  const result = await failed.run({
    event: { ...deploymentEvent, deployment_status: { state: 'failure', environment_url: 'https://deploy.vercel.app' } },
    comments: failed.comments, runUrl,
  });
  assert.equal(result.state, 'failed');
  assert.match(failed.state.comments[0].body, /❌ Build failed — \[View logs\]/);
});

test('a PR closed while publishing gets no open-state comment, and an existing one is switched to closed', async () => {
  const closeDuringPublish = ({ origin, method, state }) => {
    if (origin === 'https://account-dev.vana.org' && method === 'POST') state.pr = closedPr;
  };
  const none = fixture({ apps: [web], deployments: [deployment(web)], intercept: closeDuringPublish });
  await none.run({ ...pullEvent('reopened'), comments: none.comments, runUrl });
  assert.deepEqual(none.state.comments, []);
  const existing = fixture({
    apps: [web], deployments: [deployment(web)], intercept: closeDuringPublish,
    initialComments: [{ id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${COMMENT_MARKER}\nold open body` }],
  });
  await existing.run({ ...pullEvent('reopened'), comments: existing.comments, runUrl });
  assert.match(existing.state.comments[0].body, /Previews and sign-in callbacks removed/);
});

test('a push during the run leaves the comment for the newer commit run to write', async () => {
  const pushDuringPublish = ({ origin, method, state }) => {
    if (origin === 'https://account-dev.vana.org' && method === 'POST') state.pr = { ...basePr, head: { ...basePr.head, sha: nextSha } };
  };
  const f = fixture({ apps: [web], deployments: [deployment(web)], intercept: pushDuringPublish });
  await f.run({ ...pullEvent('reopened'), comments: f.comments, runUrl });
  assert.deepEqual(f.state.comments, []);
});

test('a failed build of an app without PR context still shows on the comment', async () => {
  const f = fixture({ apps: [open], deployments: [deployment(open, { readyState: 'ERROR' })] });
  f.state.eventDeployment = f.state.deployments.get('dpl_open');
  const result = await f.run({
    event: { ...deploymentEvent, deployment_status: { state: 'failure', environment_url: 'https://deploy.vercel.app' } },
    comments: f.comments, runUrl,
  });
  assert.equal(result.state, 'failed');
  assert.match(f.state.comments[0].body, /\| open \| `open-pr-12.vana.boo` \| ❌ Build failed/);
});

test('a PR closed mid-publish with a failed callback removal does not claim the previews were removed', async () => {
  const f = fixture({
    apps: [web], deployments: [deployment(web)],
    initialComments: [{ id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${COMMENT_MARKER}\nold open body` }],
    intercept: ({ origin, method, body, state }) => {
      if (origin !== 'https://account-dev.vana.org' || method !== 'POST') return undefined;
      if (body.action === 'add') { state.pr = closedPr; return undefined; }
      return json({ error: 'down' }, 503);
    },
  });
  const result = await f.run({ ...pullEvent('reopened'), comments: f.comments, runUrl });
  assert.equal(result.state, 'failed');
  assert.match(f.state.comments[0].body, /Preview removal is incomplete/);
  assert.equal(f.state.comments[0].body.includes('were removed'), false);
});

test('an alias that points at a foreign deployment is never advertised as a live link', async () => {
  const foreign = deployment(web, { id: 'dpl_foreign', projectId: 'prj_other' });
  const f = fixture({ apps: [web], aliases: [mapping(web, 'dpl_foreign')], deployments: [deployment(web, { readyState: 'BUILDING' }), foreign] });
  await f.run({ ...pullEvent('reopened'), comments: f.comments, runUrl });
  const row = f.state.comments[0]?.body.split('\n').find(line => line.startsWith('| web |')) ?? '';
  assert.equal(row.includes('](https://'), false);
});

test('a PR lookup failure after a successful cleanup is a warning, not a failed run', async () => {
  let accountDone = false;
  const f = fixture({
    apps: [web], pr: closedPr, aliases: [mapping(web)], deployments: [deployment(web)],
    intercept: ({ origin, path, method }) => {
      if (origin === 'https://account-dev.vana.org') accountDone = true;
      if (accountDone && origin === 'https://api.github.com' && method === 'GET' && /\/pulls\/12$/.test(path)) return json({}, 403);
    },
  });
  const result = await f.run({ ...pullEvent('closed', closedPr), comments: f.comments, runUrl });
  assert.equal(result.failures, undefined);
  assert.ok(result.warnings?.length);
});

test('a publication failure shows the app as failed, not as a permanent spinner', async () => {
  const f = fixture({
    apps: [web], deployments: [deployment(web)],
    intercept: ({ origin, method }) => origin === 'https://account-dev.vana.org' && method === 'POST' ? json({}, 503) : undefined,
  });
  const result = await f.run({ ...pullEvent('reopened'), comments: f.comments, runUrl });
  assert.equal(result.state, 'failed');
  assert.match(f.state.comments[0].body, /\| web \| `web-pr-12.vana.boo` \| ❌ Build failed/);
});

test('the sign-in note names the configured preview domain', () => {
  const body = renderPreviewComment({ pr: 12, sha, runUrl, domain: 'previews.example.test', rows: [] });
  assert.match(body, /`previews.example.test` links/);
  assert.equal(body.includes('vana.boo'), false);
});

test('a sweep that removes a closed PR preview closes its existing comment and creates none', async () => {
  const stale = { id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${COMMENT_MARKER}\nready` };
  const f = fixture({ pr: closedPr, aliases: [mapping(web)], initialComments: [stale] });
  assert.equal((await f.run({ ...sweep, comments: f.comments, runUrl })).state, 'cleanup-checked');
  assert.equal(f.state.aliases.size, 0);
  assert.match(f.state.comments[0].body, /Previews and sign-in callbacks removed/);
  const none = fixture({ pr: closedPr, aliases: [mapping(web)] });
  await none.run({ ...sweep, comments: none.comments, runUrl });
  assert.deepEqual(none.state.comments, []);
});

test('decommission closes existing comments with a repository-level note', async () => {
  const stale = { id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${COMMENT_MARKER}\nready` };
  const f = fixture({ aliases: [mapping(web)], initialComments: [stale] });
  await f.run({ ...dispatch, comments: f.comments, runUrl });
  assert.match(f.state.comments[0].body, /turned off for this repository/);
});

test('a sweep keeps the comment when only a retired app alias is removed from an open PR', async () => {
  const live = { id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${COMMENT_MARKER}\nready` };
  const f = fixture({ apps: [open], aliases: [mapping(web)], initialComments: [live] });
  await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.equal(f.state.aliases.size, 0);
  assert.doesNotMatch(f.state.comments[0].body, /removed|closed/);
  assert.match(f.state.comments[0].body, /Commit `aaaaaaa`/);
});

test('a sweep that removes only a callback for a closed PR closes its comment', async () => {
  const stale = { id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${COMMENT_MARKER}\nready` };
  const f = fixture({ pr: closedPr, clientUris: { 'web-dev': [webUri] }, initialComments: [stale] });
  await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.match(f.state.comments[0].body, /Previews and sign-in callbacks removed/);
});

test('a sweep still closes a removed preview comment when another cleanup fails, and says so', async () => {
  const stale = { id: 5, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${COMMENT_MARKER}\nready` };
  const f = fixture({
    pr: closedPr, aliases: [mapping(web)], initialComments: [stale],
    intercept: ({ origin }) => origin === 'https://account-dev.vana.org' ? json({ message: 'down' }, 500) : undefined,
  });
  const result = await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.equal(f.state.aliases.size, 0);
  assert.ok(result.failures.length);
  assert.match(f.state.comments[0].body, /removal is incomplete/);
});

const botComment = (body, id = 5) => ({ id, user: { login: 'github-actions[bot]', type: 'Bot' }, body });
const staleBody = renderPreviewComment({ pr: 12, sha, runUrl: undefined, rows: [{ app: 'web', host: host('web'), state: 'publishing' }] });
const skippedBuild = (app, details) => deployment(app, {
  id: 'dpl_skipped', readyState: 'CANCELED', createdAt: prOpenedMs + 5000, canceledAt: prOpenedMs + 5000,
  errorLink: 'https://vercel.com/docs/monorepos#skipping-unaffected-projects',
  readyStateReason: 'The deployment was canceled because the commit didn\u2019t affect this project.', ...details,
});
const olderBuild = (app, details) => deployment(app, {
  id: 'dpl_earlier', createdAt: prOpenedMs + 1000, ...details,
  meta: { ...deployment(app).meta, githubCommitSha: nextSha }, gitSource: { ...deployment(app).gitSource, sha: nextSha },
});

test('a sweep refreshes a stale comment on an old branch that never receives the deployment signal', async () => {
  const f = fixture({ apps: [web], aliases: [mapping(web)], initialComments: [botComment(staleBody)] });
  const result = await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.equal(result.failures, undefined);
  assert.match(f.state.comments[0].body, new RegExp(`\\| web \\| \\[${host('web')}\\]\\(https://${host('web')}\\) \\| ✅ Ready \\|`));
  assert.equal(f.state.comments.length, 1);
  // A second sweep finds nothing to change.
  const before = f.writes().length;
  await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.equal(f.writes().length, before);
});

test('a sweep creates a missing comment only when the PR already has a live preview alias', async () => {
  const live = fixture({ apps: [web], aliases: [mapping(web)] });
  await live.run({ ...sweep, comments: live.comments, runUrl });
  assert.equal(live.state.comments.length, 1);
  const none = fixture({ apps: [web], aliases: [], deployments: [] });
  await none.run({ ...sweep, comments: none.comments, runUrl });
  assert.deepEqual(none.state.comments, []);
});

test('a sweep does not mark apps failed on other PRs when one alias repair fails', async () => {
  const f = fixture({
    apps: [web], aliases: [mapping(web)], deployments: [deployment(web, { readyState: 'BUILDING' })],
    initialComments: [botComment(staleBody)],
    intercept: ({ origin, path }) => origin === 'https://api.vercel.com' && path === '/v4/aliases' ? json({}, 500) : undefined,
  });
  await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.doesNotMatch(f.state.comments[0].body, /Build failed/);
});

test('a skipped build whose alias still serves an earlier READY build reads as ready, not as a warning', async () => {
  const earlier = olderBuild(open);
  const f = fixture({
    apps: [open], aliases: [mapping(open, 'dpl_earlier')], deployments: [earlier, skippedBuild(open)],
    initialComments: [botComment(staleBody)],
  });
  await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.match(f.state.comments[0].body, new RegExp(`\\| open \\| \\[${host('open')}\\]\\(https://${host('open')}\\) \\| ✅ Ready \\(previous build\\) \\|`));
  assert.doesNotMatch(f.state.comments[0].body, /canceled/i);
});

test('a really canceled build still warns, and says the previous build is what is served', async () => {
  const cancel = skippedBuild(open, { errorLink: undefined, readyStateReason: undefined, canceledAt: prOpenedMs + 60000 });
  const f = fixture({
    apps: [open], aliases: [mapping(open, 'dpl_earlier')], deployments: [olderBuild(open), cancel],
    initialComments: [botComment(staleBody)],
  });
  await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.match(f.state.comments[0].body, /⚠️ Build canceled · showing previous build/);
  const bare = fixture({ apps: [open], aliases: [], deployments: [cancel], initialComments: [botComment(staleBody)] });
  await bare.run({ ...sweep, comments: bare.comments, runUrl });
  assert.match(bare.state.comments[0].body, /⚠️ Build canceled \|/);
});

test('a skipped build with no alias reads as no changes, not as a failure', async () => {
  const f = fixture({ apps: [open], aliases: [], deployments: [skippedBuild(open)], initialComments: [botComment(staleBody)] });
  await f.run({ ...sweep, comments: f.comments, runUrl });
  assert.match(f.state.comments[0].body, /➖ No changes for this app/);
});

test('the comment refresh stops at the soft deadline, reports it and never fails the run', async () => {
  let clock = 0;
  const f = fixture({ apps: [web], aliases: [mapping(web)], initialComments: [botComment(staleBody)] });
  const result = await f.run({ ...sweep, comments: f.comments, runUrl, now: () => (clock += 1000), softDeadlineMs: 500 });
  assert.equal(result.failures, undefined);
  assert.match(result.warnings.join('\n'), /comment refresh reached its time limit; 1 PRs wait/);
  assert.equal(f.state.comments[0].body, staleBody);
});

test('the sweep reads each listed open PR once for cleanup instead of once per alias', async () => {
  const f = fixture({ apps: [web, account, open], aliases: [mapping(web), mapping(account), mapping(open)] });
  await f.run({ ...sweep });
  const reads = f.calls.filter(c => c.origin === 'https://api.github.com' && /\/pulls\/12$/.test(c.path));
  assert.ok(reads.length <= 3, `PR reads: ${reads.length}`);
});

for (const event of [sweep,pullEvent('closed',closedPr)]) {
  for (const worker of [false,true]) test('cleanup retry copy respects caller for '+event.eventName+' worker='+worker,async()=>{
    const f=fixture({
      pr:closedPr,aliases:[mapping(web)],initialComments:[botComment(COMMENT_MARKER+'\nready')],
      intercept:({origin})=>origin==='https://account-dev.vana.org'?json({},403):undefined,
    });
    const result=await f.run({...event,comments:f.comments,...(worker?{cleanupRetryNote:'The next scheduled preview sweep will retry.'}:{})});
    assert.ok(result.failures.length);
    assert.match(f.state.comments[0].body,worker?/next scheduled preview sweep will retry/:/Rerun Preview auth from the Actions tab/);
    assert.doesNotMatch(f.state.comments[0].body,worker?/Actions tab/:/next scheduled preview sweep/);
  });
}
