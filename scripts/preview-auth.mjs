// Trusted automation only. Caller code is never checked out or executed.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Keep retired entries until their aliases and callbacks have been drained.
export const APP_OWNERS = Object.freeze({
  web: ['vana-com/unity-surfaces', 'prj_9MpHdKQiODnS6V9m4MOtwAIKaabV'],
  account: ['vana-com/unity-surfaces', 'prj_Lz3rTFxqAddEOHCkqqdeep4zfj3M'],
  mobile: ['vana-com/unity-surfaces', 'prj_f3Hqy5lTO7KPRl9wVDNyhKEp5oGf'],
  community: ['vana-com/unity-surfaces', 'prj_fvIr1YrwTjWZIHwqfP2561OH9CY0'],
  metrics: ['vana-com/unity-surfaces', 'prj_OmkurTBlmnaSp1Z0sOzmKWEFwUvK'],
  open: ['vana-com/unity-surfaces', 'prj_QiRN1gRk8KBY5Do11tVQgTXisdja'],
  'my-two-cents': ['vana-com/my-two-cents', 'prj_u5iiNxoAsSv2bSJN0K45tjr9DB01'],
});
const ACCOUNT_ORIGIN = 'https://account-dev.vana.org';
const CLIENT_KEY = /^[A-Z0-9_]+_CLIENT_ID$/;
const CLIENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CALLBACK_PATH = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const PR_NUMBER = /^[1-9][0-9]*$/;

class PreviewError extends Error {}

function failureReason(error) {
  return error instanceof PreviewError ? error.message : 'Preview operation failed';
}

// Retry only transient failures. The optional preflight runs before every write attempt.
export async function retryRequest(fetchFn, sleep, url, options, {
  attempts = 3, maxDelayMs = 5000, timeoutMs = 10000, allowMissing = false, service = 'API', preflight,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (preflight && !await preflight(attempt)) return null;
    let response;
    try {
      response = await fetchFn(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      if (attempt === attempts - 1) throw new PreviewError(`${service} unavailable (network or timeout)`);
      await sleep(Math.min(500 * 2 ** attempt, maxDelayMs));
      continue;
    }
    if (response.ok || (allowMissing && response.status === 404)) return response;
    if ((response.status !== 429 && response.status < 500) || attempt === attempts - 1) {
      throw new PreviewError(`${service} request failed (${response.status})`);
    }
    const retryAfter = response.headers?.get('retry-after');
    const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const date = retryAfter ? Date.parse(retryAfter) : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 500 * 2 ** attempt;
    await sleep(Math.min(delay, maxDelayMs));
  }
}

export function previewHost(app, pr, domain) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app) || app.length > 40 ||
      !PR_NUMBER.test(String(pr)) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) || domain.length > 200) {
    throw new PreviewError('Invalid preview app, PR number or domain');
  }
  const host = `${app}-pr-${pr}.${domain}`;
  if (host.length > 253 || host.split('.')[0].length > 63) throw new PreviewError('Preview hostname is too long');
  return host;
}

function validCallbackPath(path) {
  return typeof path === 'string' && CALLBACK_PATH.test(path) && !path.split('/').some(segment => segment === '.' || segment === '..');
}

export function validateMatrix(matrix, domain, repo) {
  if (!Array.isArray(matrix)) throw new PreviewError('Invalid app matrix');
  const apps = new Set();
  for (const app of matrix) {
    if (!app || !Object.hasOwn(APP_OWNERS, app.app)) throw new PreviewError('Unknown preview app ownership');
    previewHost(app.app, 1, domain);
    const [owner, project] = APP_OWNERS[app.app];
    if (owner !== repo || project !== app.project_id || apps.has(app.app)) {
      throw new PreviewError('Preview app ownership mismatch');
    }
    if ((app.needs_neon !== undefined && typeof app.needs_neon !== 'boolean') ||
        (app.migrations_path != null && (typeof app.migrations_path !== 'string' || !app.migrations_path.trim())) ||
        !Array.isArray(app.callback_paths) || !app.callback_paths.every(validCallbackPath) ||
        (app.callback_paths.length ? typeof app.client_id_key !== 'string' || !CLIENT_KEY.test(app.client_id_key) : app.client_id_key != null)) {
      throw new PreviewError('Invalid app matrix entry');
    }
    apps.add(app.app);
  }
  return matrix;
}

function ownedPr(host, app, domain) {
  const prefix = `${app}-pr-`, suffix = `.${domain}`;
  if (typeof host !== 'string' || !host.startsWith(prefix) || !host.endsWith(suffix)) return null;
  const pr = host.slice(prefix.length, -suffix.length);
  return PR_NUMBER.test(pr) ? pr : null;
}

function previewUri(uri, domain) {
  let url;
  try { url = new URL(uri); } catch { return null; }
  for (const [app, [repo]] of Object.entries(APP_OWNERS)) {
    const pr = ownedPr(url.hostname, app, domain);
    if (pr && validCallbackPath(url.pathname) && uri === `https://${url.hostname}${url.pathname}`) {
      return { app, repo, pr, path: url.pathname };
    }
  }
  return null;
}

export function provisioningState(app) {
  return app.needs_neon === true && app.migrations_path ? 'required-unavailable' : 'not-required';
}

export async function previewAuth({ eventName, event, repo, matrix, domain, targetBranch, decommission = false, api, alias }) {
  const cleanupEvent = eventName === 'pull_request_target' && ['closed', 'edited'].includes(event.action);
  const sweep = ['schedule', 'workflow_dispatch'].includes(eventName);
  if (eventName === 'pull_request_target' && event.pull_request?.head?.repo?.full_name !== repo) return { state: 'ignored' };
  if (decommission && eventName !== 'workflow_dispatch') return { state: 'ignored' };
  const ownedApps = Object.entries(APP_OWNERS)
    .filter(([, [owner]]) => owner === repo)
    .map(([app, [, project_id]]) => ({ app, project_id }));
  if (!ownedApps.length) throw new PreviewError('Unknown preview repository ownership');
  const byApp = new Map();
  const failures = [], results = [], pushNeeded = new Set();
  const fail = (app, operation, error) => failures.push({ app, operation, reason: failureReason(error) });
  const attempt = async (app, operation, fn) => {
    try { return await fn(); }
    catch (error) { fail(app, operation, error); }
  };
  const matrixValid = Array.isArray(matrix) && (matrix.length > 0 || decommission);
  if (!matrixValid) {
    if (!(cleanupEvent || sweep)) throw new PreviewError('Invalid app matrix');
    fail('Configuration', 'read app matrix', new PreviewError('Invalid app matrix'));
    matrix = [];
  }
  const repeatedApps = new Set(matrix.filter((app, index) => matrix.findIndex(other => other?.app === app?.app) !== index).map(app => app?.app));
  for (const app of matrix) {
    await attempt(ownedApps.find(item => item.app === app?.app)?.app ?? 'Configuration', 'validate app matrix', () => {
      if (repeatedApps.has(app?.app)) throw new PreviewError('Duplicate preview app');
      validateMatrix([app], domain, repo);
      byApp.set(app.app, app);
    });
  }
  const canDetectRetiredApps = matrixValid && failures.length === 0;
  const finish = state => ({
    state: failures.length ? 'failed' : state,
    ...(failures.length ? { failures } : {}),
    ...(results.length ? { results } : {}),
    ...(pushNeeded.size ? { pushNeeded: [...pushNeeded] } : {}),
  });
  if (!targetBranch || !/^[A-Za-z0-9._/-]+$/.test(targetBranch)) throw new PreviewError('Invalid target branch');
  for (const { app } of ownedApps) previewHost(app, 1, domain);
  const pull = number => {
    if (!PR_NUMBER.test(String(number))) throw new PreviewError('Invalid pull request number');
    return api('github', `/repos/${repo}/pulls/${number}`);
  };
  const eligiblePr = pr => pr?.state === 'open' && pr.head?.repo?.full_name === repo && pr.base?.ref === targetBranch;
  const currentHead = (pr, sha) => eligiblePr(pr) && pr.head?.sha === sha;
  const ownedDeployment = (deployment, app) => deployment?.projectId === app.project_id &&
    deployment.target !== 'production' && !deployment.customEnvironment &&
    `${deployment.meta?.githubCommitOrg}/${deployment.meta?.githubCommitRepo}` === repo &&
    SHA.test(deployment.meta?.githubCommitSha ?? '');
  const eligibleDeployment = (deployment, app, sha) => ownedDeployment(deployment, app) &&
    deployment.readyState === 'READY' && deployment.meta.githubCommitSha === sha;

  const readTarget = id => api('vercel', `/deployments/${encodeURIComponent(id)}`);
  const readAlias = host => api('vercel', `/aliases/${encodeURIComponent(host)}`);
  const callbacks = app => [...new Set(app.callback_paths)];
  const shouldClean = async (app, pr) => {
    if (decommission || (sweep && canDetectRetiredApps && !byApp.has(app.app))) return true;
    return !eligiblePr(await pull(pr));
  };
  const recoveryPr = async (pr, deployment) => !currentHead(await pull(pr), deployment.meta.githubCommitSha);

  async function removeAlias(app, pr, shouldRemove, expectedDeployment) {
    const host = previewHost(app.app, pr, domain);
    const existing = await readAlias(host);
    if (!existing || (expectedDeployment && existing.deploymentId !== expectedDeployment.id)) return;
    if (!existing.uid || !existing.deploymentId) throw new PreviewError('Alias ownership unavailable');
    const target = await readTarget(existing.deploymentId);
    const verifiedTarget = target ?? expectedDeployment;
    if (!ownedDeployment(verifiedTarget, app) || verifiedTarget.id !== existing.deploymentId) {
      throw new PreviewError('Alias ownership refused');
    }
    if (!await shouldRemove()) return;
    const latest = await readAlias(host);
    if (!latest) return;
    if (latest.uid !== existing.uid || latest.deploymentId !== existing.deploymentId) {
      if (!expectedDeployment) throw new PreviewError('Alias changed during cleanup');
      return;
    }
    await alias('rm', host, latest);
  }

  async function updateCallback(app, uri, action) {
    await api('account', '/redirect-uris', { action, redirect_uri: uri }, app);
  }

  async function publish(app, pr, deployment, expiredAlias) {
    const sha = deployment.meta.githubCommitSha;
    if (!currentHead(await pull(pr), sha)) return 'stale';
    const state = provisioningState(app);
    if (state !== 'not-required') return state;
    const host = previewHost(app.app, pr, domain);
    const uris = callbacks(app).map(path => `https://${host}${path}`);
    const removeClosedCallbacks = async () => {
      for (const uri of uris) await attempt(app.app, `remove PR #${pr} callback`, async () => {
        if (!eligiblePr(await pull(pr))) await updateCallback(app, uri, 'remove');
      });
    };
    const existing = await readAlias(host);
    if (existing && existing.deploymentId !== deployment.id) {
      const target = await readTarget(existing.deploymentId);
      const knownExpired = !target && expiredAlias && existing.uid === expiredAlias.uid &&
        existing.deploymentId === expiredAlias.deploymentId;
      if (!knownExpired && !ownedDeployment(target, app)) throw new PreviewError('Alias ownership refused');
    }
    // Keep the last good alias until all callbacks are registered.
    for (const uri of uris) await updateCallback(app, uri, 'add');
    if (await recoveryPr(pr, deployment)) {
      await removeClosedCallbacks();
      return 'stale';
    }
    const latest = await readAlias(host);
    if (latest?.uid !== existing?.uid || latest?.deploymentId !== existing?.deploymentId) {
      throw new PreviewError('Alias changed during publication');
    }
    await alias('set', host, deployment);
    if (await recoveryPr(pr, deployment)) {
      await attempt(app.app, `remove stale PR #${pr} alias`, () =>
        removeAlias(app, pr, () => recoveryPr(pr, deployment), deployment));
      await removeClosedCallbacks();
      return 'stale';
    }
    return 'published';
  }

  async function findDeployment(app, sha) {
    const candidates = await api('vercel', `/deployments?sha=${encodeURIComponent(sha)}`, null, app);
    for (const { uid } of candidates) {
      if (!uid) continue;
      const deployment = await readTarget(uid);
      if (eligibleDeployment(deployment, app, sha)) return deployment;
    }
    return null;
  }

  if (eventName === 'pull_request_target' && !cleanupEvent) {
    const pr = event.pull_request;
    if (!['opened', 'reopened', 'synchronize'].includes(event.action) || !SHA.test(pr.head?.sha ?? '')) return finish('ignored');
    const current = await pull(pr.number);
    if (!currentHead(current, pr.head.sha)) return finish('ignored');
    for (const app of byApp.values()) {
      const state = await attempt(app.app, 'find current preview deployment', async () => {
        if (provisioningState(app) === 'required-unavailable') return 'required-unavailable';
        if (event.action === 'synchronize') return 'awaiting-deployment';
        const deployment = await findDeployment(app, current.head.sha);
        return deployment ? publish(app, pr.number, deployment) : 'awaiting-deployment';
      });
      if (state) results.push({ app: app.app, state });
    }
    const state = results.some(item => item.state === 'required-unavailable') ? 'required-unavailable'
      : results.some(item => item.state === 'published') ? 'published' : 'awaiting-deployment';
    return finish(state);
  }

  if (cleanupEvent || sweep) {
    const onlyPr = cleanupEvent ? String(event.pull_request.number) : null;
    if (onlyPr && !PR_NUMBER.test(onlyPr)) throw new PreviewError('Invalid pull request number');
    const repair = [];
    // Clean every owned Vercel project before trying Account, even when the matrix has drifted.
    for (const app of ownedApps) {
      const aliases = onlyPr ? [{ alias: previewHost(app.app, onlyPr, domain) }]
        : await attempt(app.app, 'list aliases', () => api('vercel', '/aliases', null, app));
      for (const item of aliases ?? []) {
        const pr = ownedPr(item.alias, app.app, domain);
        if (!pr) continue;
        await attempt(app.app, `reconcile PR #${pr} alias`, async () => {
          if (await shouldClean(app, pr)) await removeAlias(app, pr, () => shouldClean(app, pr));
          else if (sweep && byApp.has(app.app)) repair.push({ app: byApp.get(app.app), pr, host: item.alias });
        });
      }
    }

    const clients = await attempt('Account', 'read dev client allowlist', () => api('account', '/clients'));
    for (const client of clients ?? []) {
      const uris = await attempt('Account', 'list callbacks', () => api('account', '/redirect-uris', null, client));
      for (const uri of uris ?? []) {
        const entry = previewUri(uri, domain);
        if (!entry || entry.repo !== repo || (onlyPr && entry.pr !== onlyPr)) continue;
        const current = byApp.get(entry.app);
        if (!decommission && (current ? !current.callback_paths.includes(entry.path) : !canDetectRetiredApps)) continue;
        await attempt(entry.app, `remove PR #${entry.pr} callback`, async () => {
          if (await shouldClean(entry, entry.pr)) await updateCallback(client, uri, 'remove');
        });
      }
    }

    for (const { app, pr, host } of repair) {
      await attempt(app.app, `repair PR #${pr} alias`, async () => {
        const existing = await readAlias(host);
        if (!existing) return;
        if (!existing.deploymentId) { pushNeeded.add(host); return; }
        const target = await readTarget(existing.deploymentId);
        if (target?.readyState === 'READY') return;
        if (target) { pushNeeded.add(host); return; }
        const current = await pull(pr);
        if (!eligiblePr(current)) return;
        const replacement = await findDeployment(app, current.head.sha);
        if (!replacement || provisioningState(app) !== 'not-required') { pushNeeded.add(host); return; }
        const latest = await readAlias(host);
        if (latest?.uid !== existing.uid || latest?.deploymentId !== existing.deploymentId) return;
        const state = await publish(app, pr, replacement, existing);
        results.push({ app: app.app, state });
      });
    }
    return finish(decommission ? 'decommissioned' : pushNeeded.size ? 'push-needed' : 'cleanup-checked');
  }

  if (eventName !== 'deployment_status' || !['success', 'failure', 'error'].includes(event.deployment_status?.state)) return finish('ignored');
  let url;
  try { url = new URL(event.deployment_status.environment_url); } catch { return finish('ignored'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !url.hostname.endsWith('.vercel.app') || url.pathname !== '/' || url.search || url.hash ||
      !SHA.test(event.deployment?.sha ?? '')) return finish('ignored');
  const deployment = await attempt('Vercel', 'read deployment', () => readTarget(url.hostname));
  const app = [...byApp.values()].find(item => item.project_id === deployment?.projectId);
  if (!app || !ownedDeployment(deployment, app) || deployment.meta.githubCommitSha !== event.deployment.sha) return finish('ignored');
  if (event.deployment_status.state !== 'success') {
    fail(app.app, 'build preview', new PreviewError('Deployment failed'));
    return finish('failed');
  }
  if (deployment.readyState !== 'READY') return finish('ignored');
  const sha = event.deployment.sha;
  const state = await attempt(app.app, 'publish preview', async () => {
    const matches = await api('github', `/repos/${repo}/commits/${sha}/pulls`);
    const pr = matches.find(candidate => currentHead(candidate, sha));
    return pr ? publish(app, pr.number, deployment) : 'ignored';
  });
  return { ...finish(state), app: app.app };
}

export function createApi(env, {
  fetchFn = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const services = {
    github: ['GitHub', 'https://api.github.com', 'GITHUB_TOKEN'],
    vercel: ['Vercel', 'https://api.vercel.com', 'VERCEL_TOKEN'],
    account: ['Account', ACCOUNT_ORIGIN, 'ACCOUNT_ADMIN_TOKEN'],
  };
  async function request(service, path, { method = 'GET', body, allowMissing = false, preflight, decode = true } = {}) {
    const [name, origin, tokenKey] = services[service];
    if (!env[tokenKey]) throw new PreviewError(`Missing ${name} credentials`);
    const response = await retryRequest(fetchFn, sleep, origin + path, {
      method, redirect: 'error',
      headers: { Authorization: `Bearer ${env[tokenKey]}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, { allowMissing, service: name, preflight });
    if (!response || (allowMissing && response.status === 404) || !decode) return null;
    let data;
    try { data = await response.json(); } catch {}
    if (!data || typeof data !== 'object') throw new PreviewError(`${name} returned an invalid response`);
    return data;
  }
  function allowlist() {
    const raw = env.PREVIEW_DEV_CLIENT_IDS?.trim();
    if (!raw) throw new PreviewError('Missing Account dev client allowlist');
    let ids;
    try { ids = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map(id => id.trim()); }
    catch { throw new PreviewError('Invalid Account dev client allowlist'); }
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !CLIENT_ID.test(id))) {
      throw new PreviewError('Invalid Account dev client allowlist');
    }
    return [...new Set(ids)];
  }
  function clientPath(app) {
    if (env.ACCOUNT_WIRING_MODE && env.ACCOUNT_WIRING_MODE !== 'existing-clients') throw new PreviewError('Unsupported Account wiring mode');
    if (env.ACCOUNT_ORIGIN && env.ACCOUNT_ORIGIN !== ACCOUNT_ORIGIN) throw new PreviewError('Account origin ownership refused');
    if (!app?.clientId && !CLIENT_KEY.test(app?.client_id_key ?? '')) throw new PreviewError('Invalid Account client key');
    const id = app.clientId ?? env[app.client_id_key];
    if (!id) throw new PreviewError('Missing Account client ID');
    if (typeof id !== 'string' || !CLIENT_ID.test(id) || !allowlist().includes(id)) {
      throw new PreviewError('Account dev client ownership refused');
    }
    return `/api/admin/oauth-clients/${encodeURIComponent(id)}/redirect-uris`;
  }
  function callbackList(client) {
    if (client === null) return null;
    if (!Array.isArray(client?.redirect_uris) || client.redirect_uris.some(uri => typeof uri !== 'string')) {
      throw new PreviewError('Account returned an invalid callback list');
    }
    return client.redirect_uris;
  }
  function team() {
    if (!env.TEAM_ID) throw new PreviewError('Missing Vercel team configuration');
    return `teamId=${encodeURIComponent(env.TEAM_ID)}`;
  }
  async function pages(path, field) {
    const items = [];
    let until = '';
    do {
      const page = await request('vercel', path + until);
      if (!Array.isArray(page?.[field])) throw new PreviewError('Vercel returned an invalid list');
      items.push(...page[field]);
      until = page.pagination?.next ? `&until=${encodeURIComponent(page.pagination.next)}` : '';
    } while (until);
    return items;
  }
  const api = async (service, path, body, app) => {
    if (service === 'github') return request(service, path);
    if (service === 'account') {
      if (path === '/clients') return allowlist().map(clientId => ({ clientId }));
      const endpoint = clientPath(app);
      const readCallbacks = async () => callbackList(await request('account', endpoint, { allowMissing: true }));
      if (!body) return readCallbacks();
      const preflight = async () => {
        const uris = await readCallbacks();
        if (!uris && body.action === 'remove') return false;
        if (!uris) throw new PreviewError('Account client unavailable (404)');
        const foreign = uris.some(uri => [env.PREVIEW_DOMAIN, 'vana.boo'].some(domain => {
          const owned = previewUri(uri, domain);
          return owned && owned.repo !== env.GITHUB_REPOSITORY;
        }));
        if (foreign) throw new PreviewError('Account client has callbacks owned by another repository');
        return body.action === 'add' ? !uris.includes(body.redirect_uri) : uris.includes(body.redirect_uri);
      };
      const client = await request(service, endpoint, { method: 'POST', body, allowMissing: body.action === 'remove', preflight });
      if (client !== null && callbackList(client).includes(body.redirect_uri) !== (body.action === 'add')) {
        throw new PreviewError('Account callback update unconfirmed');
      }
      return null;
    }
    if (path === '/aliases') return pages(`/v4/aliases?${team()}&projectId=${encodeURIComponent(app.project_id)}&limit=100`, 'aliases');
    if (path.startsWith('/aliases/')) {
      const mapping = await request(service, `/v4${path}?${team()}`, { allowMissing: true });
      if (mapping && mapping.alias !== decodeURIComponent(path.slice('/aliases/'.length))) {
        throw new PreviewError('Vercel returned an invalid alias');
      }
      return mapping;
    }
    if (path.startsWith('/deployments?sha=')) {
      return pages(`/v7/deployments?${team()}&projectId=${encodeURIComponent(app.project_id)}&limit=100&${path.split('?')[1]}`, 'deployments');
    }
    return request(service, `/v13${path}?${team()}`, { allowMissing: true });
  };
  const alias = async (action, host, target) => {
    const read = () => api('vercel', `/aliases/${encodeURIComponent(host)}`);
    if (action === 'rm') {
      const preflight = async attempt => {
        if (attempt === 0) return true; // The core re-reads immediately before the first delete.
        const current = await read();
        if (!current) return false;
        if (current.uid !== target.uid || current.deploymentId !== target.deploymentId) {
          throw new PreviewError('Alias changed during cleanup');
        }
        return true;
      };
      await request('vercel', `/v2/aliases/${encodeURIComponent(target.uid)}?${team()}`, {
        method: 'DELETE', allowMissing: true, preflight, decode: false,
      });
    } else {
      await request('vercel', `/v2/deployments/${encodeURIComponent(target.id)}/aliases?${team()}`, {
        method: 'POST', body: { alias: host }, decode: false,
      });
    }
    for (const delay of [0, 250, 1000]) {
      if (delay) await sleep(delay);
      const current = await read();
      if (action === 'rm' ? current === null : current?.deploymentId === target.id) return;
    }
    throw new PreviewError(action === 'rm' ? 'Alias removal unconfirmed' : 'Alias assignment unconfirmed');
  };
  return { api, alias };
}

async function main() {
  const env = process.env;
  if (!env.GITHUB_EVENT_PATH) throw new PreviewError('Missing GitHub event path');
  const parse = text => {
    try { return JSON.parse(text); } catch { return null; }
  };
  const event = parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (!event) throw new PreviewError('Invalid GitHub event');
  const result = await previewAuth({
    eventName: env.GITHUB_EVENT_NAME, event, repo: env.GITHUB_REPOSITORY, matrix: parse(env.APP_MATRIX),
    domain: env.PREVIEW_DOMAIN, targetBranch: env.TARGET_BRANCH, decommission: env.PREVIEW_AUTH_DECOMMISSION === 'true', ...createApi(env),
  });
  console.log(`Preview auth: ${result.state}${result.app ? ` (${result.app})` : ''}`);
  for (const host of result.pushNeeded ?? []) console.log(`Preview needs a new push: ${host}`);
  const lines = [
    ...(result.results ?? []).map(r => `- ${r.app}: ${r.state}`),
    ...(result.failures ?? []).map(f => `- ${f.app}: ${f.operation} failed — ${f.reason}`),
  ];
  for (const line of lines) console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Preview authentication\n- Overall: ${result.state}\n${lines.length ? lines.join('\n') + '\n' : ''}`);
  if (['required-unavailable', 'failed', 'push-needed'].includes(result.state)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  const reason = failureReason(error);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Preview authentication\n- Overall: failed — ${reason}\n`);
  console.error(`Preview auth failed — ${reason}`);
  process.exitCode = 1;
});
