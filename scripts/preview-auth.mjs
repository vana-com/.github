// Trusted automation only: caller code is never checked out or executed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Names own the global alias namespace; only these repository/project pairs may use them.
export const APP_OWNERS = Object.freeze({
  web: ['vana-com/unity-surfaces', 'prj_9MpHdKQiODnS6V9m4MOtwAIKaabV'],
  account: ['vana-com/unity-surfaces', 'prj_Lz3rTFxqAddEOHCkqqdeep4zfj3M'],
  mobile: ['vana-com/unity-surfaces', 'prj_f3Hqy5lTO7KPRl9wVDNyhKEp5oGf'],
  community: ['vana-com/unity-surfaces', 'prj_fvIr1YrwTjWZIHwqfP2561OH9CY0'],
  metrics: ['vana-com/unity-surfaces', 'prj_OmkurTBlmnaSp1Z0sOzmKWEFwUvK'],
  open: ['vana-com/unity-surfaces', 'prj_QiRN1gRk8KBY5Do11tVQgTXisdja'],
  'my-two-cents': ['vana-com/my-two-cents', 'prj_u5iiNxoAsSv2bSJN0K45tjr9DB01'],
});
const NEON_REQUIRED = new Set(['web', 'account', 'community']);

export function previewHost(app, pr, domain) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app) || app.length > 40 ||
      !/^[1-9][0-9]*$/.test(String(pr)) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) || domain.length > 200) {
    throw new Error('Invalid preview app, PR number or domain');
  }
  const host = `${app}-pr-${pr}.${domain}`;
  if (host.length > 253 || host.split('.')[0].length > 63) throw new Error('Preview hostname is too long');
  return host;
}

export function validateMatrix(matrix, domain, repo) {
  if (!Array.isArray(matrix) || !matrix.length) throw new Error('Invalid app matrix');
  const apps = new Set(), projects = new Set();
  for (const app of matrix) {
    previewHost(app.app, 1, domain);
    const owner = APP_OWNERS[app.app];
    if (!owner || owner[0] !== repo || owner[1] !== app.project_id || projects.has(app.project_id) || apps.has(app.app) ||
        (NEON_REQUIRED.has(app.app) && app.needs_neon !== true) ||
        typeof app.needs_neon !== 'boolean' || !Array.isArray(app.callback_paths) ||
        (app.callback_paths.length > 0 ? !/^[A-Z][A-Z0-9_]*$/.test(app.client_id_key ?? '') : app.client_id_key != null) ||
        app.callback_paths.some(path => typeof path !== 'string' || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(path))) {
      throw new Error('Invalid app matrix entry');
    }
    apps.add(app.app); projects.add(app.project_id);
  }
  return matrix;
}

function ownedPr(host, app, domain) {
  const prefix = `${app}-pr-`, suffix = `.${domain}`;
  if (!host.startsWith(prefix) || !host.endsWith(suffix)) return null;
  const pr = host.slice(prefix.length, -suffix.length);
  return /^[1-9][0-9]*$/.test(pr) ? pr : null;
}

// Provisioning is deliberately not implemented here. A later trusted implementation
// must validate and bind the PR's isolated database before this state can change.
export function provisioningState(app) {
  return app.needs_neon ? 'required-unavailable' : 'not-required';
}

export async function previewAuth({ eventName, event, repo, matrix, domain, targetBranch, api, alias }) {
  validateMatrix(matrix, domain, repo);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository');
  if (!targetBranch || !/^[A-Za-z0-9._/-]+$/.test(targetBranch)) throw new Error('Invalid target branch');
  const pull = number => api('github', `/repos/${repo}/pulls/${number}`);
  const currentHead = (pr, sha) => pr?.state === 'open' && pr.head?.repo?.full_name === repo && pr.head?.sha === sha && pr.base?.ref === targetBranch;
  const eligibleDeployment = (deployment, app, sha) => deployment?.projectId === app.project_id &&
    deployment.readyState === 'READY' && deployment.target !== 'production' && !deployment.customEnvironment &&
    `${deployment.meta?.githubCommitOrg}/${deployment.meta?.githubCommitRepo}` === repo &&
    deployment.meta?.githubCommitSha === sha;
  async function callback(app, pr, action) {
    for (const path of app.callback_paths) await api('account', '/redirect-uris', {
      action, redirect_uri: `https://${previewHost(app.app, pr, domain)}${path}`,
    }, app);
  }
  async function remove(app, pr, aliases) {
    const current = await pull(pr);
    if (current?.state === 'open' && current.base?.ref === targetBranch && current.head?.repo?.full_name === repo) return;
    await callback(app, pr, 'remove');
    const host = previewHost(app.app, pr, domain);
    if (aliases.some(a => a.alias === host)) await alias('rm', host, null, app);
  }
  if (eventName === 'pull_request_target') {
    const pr = event.pull_request;
    if (pr?.head?.repo?.full_name !== repo) return { state: 'ignored' };
    if (['opened', 'reopened', 'synchronize'].includes(event.action)) {
      const current = await pull(pr.number);
      if (!currentHead(current, pr.head.sha)) return { state: 'ignored' };
      return { state: matrix.some(app => provisioningState(app) === 'required-unavailable') ? 'required-unavailable' : 'awaiting-deployment' };
    }
    if (event.action !== 'closed') return { state: 'ignored' };
    for (const app of matrix) await remove(app, pr.number, await api('vercel', '/aliases', null, app));
    return { state: 'cleanup-checked' };
  }
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    const pushNeeded = [];
    for (const app of matrix) {
      const aliases = await api('vercel', '/aliases', null, app);
      const client = app.callback_paths.length ? await api('account', '', null, app) : {};
      const prs = new Set(aliases.map(a => ownedPr(a.alias, app.app, domain)).filter(Boolean));
      for (const uri of client.hydra?.redirect_uris ?? []) {
        let url;
        try { url = new URL(uri); } catch { continue; }
        const pr = ownedPr(url.hostname, app.app, domain);
        if (pr && app.callback_paths.some(path => uri === `https://${previewHost(app.app, pr, domain)}${path}`)) prs.add(pr);
      }
      for (const pr of prs) {
        const current = await pull(pr);
        if (!currentHead(current, current?.head?.sha)) { await remove(app, pr, aliases); continue; }
        const host = previewHost(app.app, pr, domain);
        const existing = aliases.find(a => a.alias === host);
        if (!existing) continue;
        // An absent ID is ambiguous; do not overwrite an alias whose target we cannot inspect.
        if (!existing.deploymentId) { pushNeeded.push(host); continue; }
        const target = await api('vercel', `/deployments/${encodeURIComponent(existing.deploymentId)}`, null, app);
        if (target?.readyState === 'READY') continue;
        if (target) { pushNeeded.push(host); continue; }
        const sha = current.head.sha;
        const candidates = await api('vercel', `/deployments?sha=${encodeURIComponent(sha)}`, null, app);
        let replacement;
        for (const candidate of candidates) {
          const detail = await api('vercel', `/deployments/${encodeURIComponent(candidate.uid)}`, null, app);
          if (eligibleDeployment(detail, app, sha)) { replacement = detail; break; }
        }
        if (!replacement || provisioningState(app) !== 'not-required') { pushNeeded.push(host); continue; }
        if (!currentHead(await pull(pr), sha)) continue;
        await alias('set', host, replacement.id, app);
        if (!currentHead(await pull(pr), sha)) await alias('rm', host, null, app);
      }
    }
    return { state: pushNeeded.length ? 'push-needed' : 'cleanup-checked', pushNeeded };
  }
  if (eventName !== 'deployment_status' || event.deployment_status?.state !== 'success') return { state: 'ignored' };
  let url;
  try { url = new URL(event.deployment_status.environment_url); } catch { return { state: 'ignored' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !url.hostname.endsWith('.vercel.app') || url.pathname !== '/' || url.search || url.hash) return { state: 'ignored' };
  if (!/^[a-f0-9]{40}$/.test(event.deployment?.sha ?? '')) return { state: 'ignored' };
  const deployment = await api('vercel', `/deployments/${encodeURIComponent(url.hostname)}`);
  const app = matrix.find(item => item.project_id === deployment.projectId);
  if (!app || !eligibleDeployment(deployment, app, event.deployment.sha)) return { state: 'ignored' };
  const matches = await api('github', `/repos/${repo}/commits/${event.deployment.sha}/pulls`);
  const pr = matches.find(p => currentHead(p, event.deployment.sha));
  if (!pr || !currentHead(await pull(pr.number), event.deployment.sha)) return { state: 'ignored' };
  const state = provisioningState(app);
  if (state !== 'not-required') return { state, app: app.app };
  const host = previewHost(app.app, pr.number, domain);
  await alias('set', host, deployment.id, app);
  if (!currentHead(await pull(pr.number), event.deployment.sha)) {
    await alias('rm', host, null, app);
    return { state: 'stale' };
  }
  // The Account endpoint replaces a redirect list; update paths sequentially.
  for (const path of app.callback_paths) await api('account', '/redirect-uris', {
    action: 'add', redirect_uri: `https://${host}${path}`,
  }, app);
  return { state: 'published', app: app.app };
}

async function main() {
  const env = process.env;
  for (const name of ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'VERCEL_TOKEN', 'TEAM_ID', 'APP_MATRIX', 'PREVIEW_DOMAIN', 'ACCOUNT_WIRING_MODE', 'TARGET_BRANCH']) {
    if (!env[name]) throw new Error(`Missing ${name}`);
  }
  if (env.ACCOUNT_WIRING_MODE !== 'existing-clients') throw new Error('Unsupported Account wiring mode');
  const matrix = validateMatrix(JSON.parse(env.APP_MATRIX), env.PREVIEW_DOMAIN, env.GITHUB_REPOSITORY);
  for (const app of matrix) if (app.callback_paths.length && !env[app.client_id_key]) throw new Error(`Missing client ID for ${app.app}`);
  let account;
  if (matrix.some(app => app.callback_paths.length)) {
    if (!env.ACCOUNT_ORIGIN || !env.ACCOUNT_ADMIN_TOKEN) throw new Error('Missing Account configuration');
    account = new URL(env.ACCOUNT_ORIGIN);
    if (account.protocol !== 'https:' || account.origin !== env.ACCOUNT_ORIGIN) throw new Error('Invalid ACCOUNT_ORIGIN');
  }
  async function request(base, path, token, body, allowMissing = false) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Preview auth API request failed (${response.status})`);
    return response.json();
  }
  const api = async (service, path, body, app) => {
    if (service === 'github') return request('https://api.github.com', path, env.GITHUB_TOKEN, body);
    if (service === 'account') return request(account.origin, `/api/admin/oauth-clients/${encodeURIComponent(env[app.client_id_key])}${path}`, env.ACCOUNT_ADMIN_TOKEN, body);
    if (path === '/aliases') {
      const aliases = []; let until = '';
      do {
        const page = await request('https://api.vercel.com', `/v4/aliases?teamId=${encodeURIComponent(env.TEAM_ID)}&projectId=${encodeURIComponent(app.project_id)}&limit=100${until}`, env.VERCEL_TOKEN);
        aliases.push(...page.aliases);
        until = page.pagination?.next ? `&until=${encodeURIComponent(page.pagination.next)}` : '';
      } while (until);
      return aliases;
    }
    if (path.startsWith('/deployments?sha=')) {
      const deployments = []; let until = '';
      do {
        const page = await request('https://api.vercel.com', `/v7/deployments?teamId=${encodeURIComponent(env.TEAM_ID)}&projectId=${encodeURIComponent(app.project_id)}&limit=100&${path.split('?')[1]}${until}`, env.VERCEL_TOKEN);
        deployments.push(...page.deployments);
        until = page.pagination?.next ? `&until=${encodeURIComponent(page.pagination.next)}` : '';
      } while (until);
      return deployments;
    }
    return request('https://api.vercel.com', `/v13${path}?teamId=${encodeURIComponent(env.TEAM_ID)}`, env.VERCEL_TOKEN, null, true);
  };
  const alias = async (action, host, deployment) => {
    const config = mkdtempSync(join(tmpdir(), 'preview-auth-'));
    try {
      writeFileSync(join(config, 'auth.json'), JSON.stringify({ token: env.VERCEL_TOKEN }), { mode: 0o600 });
      const args = ['alias', action, ...(action === 'set' ? [deployment, host] : [host, '--confirm-name', host]), '--scope', env.TEAM_ID, '--global-config', config];
      try { execFileSync('vercel', args, { stdio: 'pipe', timeout: 120_000 }); }
      catch { throw new Error(`Preview alias ${action} failed`); }
    } finally { rmSync(config, { recursive: true, force: true }); }
  };
  const result = await previewAuth({ eventName: env.GITHUB_EVENT_NAME, event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')),
    repo: env.GITHUB_REPOSITORY, matrix, domain: env.PREVIEW_DOMAIN, targetBranch: env.TARGET_BRANCH, api, alias });
  console.log(`Preview auth: ${result.state}${result.app ? ` (${result.app})` : ''}`);
  for (const host of result.pushNeeded ?? []) console.log(`Preview needs a new push: ${host}`);
  if (result.state === 'required-unavailable' || result.state === 'push-needed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Preview auth failed; check trusted configuration and API access'); process.exitCode = 1;
});
