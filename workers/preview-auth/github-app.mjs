// No credentials are persisted or logged. One provider per Durable Object.
const encoder = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const encode = value => b64url(encoder.encode(JSON.stringify(value)));
export function createGitHubApp({ fetchFn = fetch, cryptoImpl = crypto, now = Date.now } = {}) {
  const cache = new Map();
  async function jwt(env) {
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error('Missing GitHub App configuration');
    const pem = env.GITHUB_APP_PRIVATE_KEY.trim();
    if (!pem.startsWith('-----BEGIN PRIVATE KEY-----') || !pem.endsWith('-----END PRIVATE KEY-----')) throw new Error('Expected PKCS8 private key');
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), c => c.charCodeAt(0));
    const key = await cryptoImpl.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const seconds = Math.floor(now() / 1000);
    const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: seconds - 60, exp: seconds + 540, iss: String(env.GITHUB_APP_ID) });
    const signature = await cryptoImpl.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
    return unsigned + '.' + b64url(new Uint8Array(signature));
  }
  async function request(path, auth, body) {
    const response = await fetchFn('https://api.github.com' + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vana-preview-auth', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub App request failed (${response.status})`);
    return response.json();
  }
  return async (env, repo) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository');
    const cached = cache.get(repo);
    if (cached && cached.app === env.GITHUB_APP_ID && cached.key === env.GITHUB_APP_PRIVATE_KEY && cached.expires > now() + 120000) return cached.value;
    const auth = await jwt(env);
    const app = await request('/app', auth);
    if (!/^[a-zA-Z0-9_-]+$/.test(app.slug ?? '')) throw new Error('Invalid GitHub App identity');
    const installation = await request(`/repos/${repo}/installation`, auth);
    if (!Number.isSafeInteger(installation.id) || installation.id <= 0) throw new Error('Invalid installation');
    const token = await request(`/app/installations/${installation.id}/access_tokens`, auth, {
      repositories: [repo.split('/')[1]], permissions: { contents: 'read', pull_requests: 'write', issues: 'write' },
    });
    const expires = Date.parse(token.expires_at);
    if (typeof token.token !== 'string' || !token.token || !Number.isFinite(expires) || expires <= now() + 120000) throw new Error('Invalid installation access response');
    const value = { token: token.token, commentAuthor: `${app.slug}[bot]` };
    cache.set(repo, { value, expires, app: env.GITHUB_APP_ID, key: env.GITHUB_APP_PRIVATE_KEY });
    return value;
  };
}
