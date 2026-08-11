// SPDX-License-Identifier: Apache-2.0
// Adapted from vana-com/vana-smart-contracts PR #69 (Maciej Witowski); see NOTICE.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { computeAddress, SigningKey } from "ethers";

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function normalizeScalar(candidate) {
  if (typeof candidate !== "string") return null;
  const hex = candidate.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const scalar = BigInt(`0x${hex}`);
  return scalar > 0n && scalar < SECP256K1_N ? `0x${hex}` : null;
}

export function deriveAddress(key) {
  const scalar = normalizeScalar(key);
  if (!scalar) throw new Error("invalid secp256k1 private-key scalar");
  return computeAddress(new SigningKey(scalar).publicKey).toLowerCase();
}

function redactScalarLikeText(value) {
  return value.replace(/(?:0x)?[0-9a-f]{64}/gi, "[REDACTED]");
}

export function sanitizeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s"'<>)\]},]+/gi, (url) => {
      try { return `[${new URL(url).hostname}]`; } catch { return "[rpc]"; }
    })
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/(?:0x)?[0-9a-f]{64}/gi, "[REDACTED]")
    .slice(0, 200);
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unnamed-rpc";
}

export function parseRpcUrls(raw) {
  if (!raw) return [];
  return raw.split(",").filter(Boolean).map((entry) => {
    const trimmed = entry.trim();
    const split = trimmed.indexOf("=");
    const named = split > 0 && !trimmed.slice(0, split).includes("://");
    const url = named ? trimmed.slice(split + 1).trim() : trimmed;
    let hostname;
    try { hostname = new URL(url).hostname; } catch { throw new Error("invalid liveness RPC URL"); }
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("liveness RPC URL must use HTTP(S)");
    return { name: safeName(named ? trimmed.slice(0, split).trim() : hostname), url };
  });
}

function candidateFromReport(finding, commit) {
  const key = normalizeScalar(finding.Secret);
  if (!key) return null;
  const file = typeof finding.File === "string" ? finding.File.replace(/^(content|metadata)\//, "") : "unknown";
  const line = Number.isInteger(finding.StartLine) ? finding.StartLine : 0;
  return { key, commit, file, line };
}

export function collectCandidatesFromReports(reports) {
  const byKey = new Map();
  byKey.truncated = false;
  for (const { commit, findings } of reports) {
    for (const finding of findings) {
      const candidate = candidateFromReport(finding, commit);
      if (!candidate) continue;
      let locations = byKey.get(candidate.key);
      if (!locations) {
        if (byKey.size >= 128) { byKey.truncated = true; continue; }
        locations = [];
        byKey.set(candidate.key, locations);
      }
      if (locations.some((location) => location.commit === candidate.commit && location.file === candidate.file && location.line === candidate.line)) continue;
      if (locations.length >= 8) { byKey.truncated = true; continue; }
      locations.push(candidate);
    }
  }
  return byKey;
}

function runGitleaksInventory({ snapshots, gitleaks, config }) {
  const reports = [];
  const resolvedConfig = resolve(config);
  for (const commit of readFileSync(join(snapshots, "commits.txt"), "utf8").trim().split("\n").filter(Boolean)) {
    const scanRoot = join(snapshots, "commits", commit, "scan");
    const reportDir = mkdtempSync(join(tmpdir(), "vana-evm-key-report-"));
    const reportPath = join(reportDir, "report.json");
    try {
      execFileSync(gitleaks, ["dir", "--config", resolvedConfig, "--report-format", "json", "--report-path", reportPath, "--exit-code", "0", "--no-banner", "--no-color", "--ignore-gitleaks-allow", "--log-level", "error", "."], { cwd: scanRoot, stdio: "pipe" });
      reports.push({ commit, findings: JSON.parse(readFileSync(reportPath, "utf8")) });
    } catch {
      throw new Error(`Gitleaks candidate inventory failed for commit ${commit.slice(0, 12)}`);
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }
  return collectCandidatesFromReports(reports);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function rpcCall(chain, method, params, fetchImpl, timeoutMs, requestId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(chain.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.jsonrpc !== "2.0" || payload.id !== requestId || Object.hasOwn(payload, "error") || typeof payload.result !== "string") {
      throw new Error("RPC returned an invalid response");
    }
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function withRetry(operation, attempts, baseDelayMs) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await operation(); } catch (caught) {
      error = caught;
      if (attempt + 1 < attempts) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw error;
}

async function mapPool(items, limit, worker) {
  const results = Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export async function findUsedAddresses(addresses, chains, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const concurrency = options.concurrency ?? 3;
  const timeoutMs = options.timeoutMs ?? 5000;
  let nextRequestId = 1;
  const callRpc = (chain, method, params) => rpcCall(chain, method, params, fetchImpl, timeoutMs, nextRequestId++);
  const used = new Map();
  const status = [];
  for (const chain of chains) {
    try {
      await withRetry(() => callRpc(chain, "eth_blockNumber", []), attempts, baseDelayMs);
    } catch (error) {
      status.push({ name: chain.name, ok: false, error: sanitizeError(error) });
      continue;
    }
    let failure;
    await mapPool(addresses, concurrency, async (address) => {
      const [nonce, balance] = await Promise.allSettled([
        withRetry(async () => BigInt(await callRpc(chain, "eth_getTransactionCount", [address, "latest"])), attempts, baseDelayMs),
        withRetry(async () => BigInt(await callRpc(chain, "eth_getBalance", [address, "latest"])), attempts, baseDelayMs),
      ]);
      if ((nonce.status === "fulfilled" && nonce.value > 0n) || (balance.status === "fulfilled" && balance.value > 0n)) {
        used.set(address, [...(used.get(address) ?? []), chain.name]);
      }
      const rejected = [nonce, balance].find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") failure ??= sanitizeError(rejected.reason);
    });
    status.push(failure ? { name: chain.name, ok: false, error: failure } : { name: chain.name, ok: true });
  }
  return { used, status };
}

export function reportAdvisory(candidates, used, status) {
  const lines = [];
  for (const [key, locations] of candidates) {
    const address = deriveAddress(key);
    const chains = used.get(address);
    if (!chains) continue;
    for (const location of locations) lines.push(`active EVM key candidate at ${safeLocation(location.commit).slice(0, 12)}:path-sha256=${pathDigest(location.file)}:${location.line} derives to ${address} (${chains.map(safeName).join(", ")})`);
  }
  for (const chain of status.filter((entry) => !entry.ok)) lines.push(`incomplete liveness check for ${safeName(String(chain.name))}: ${sanitizeError(chain.error)}`);
  return lines;
}

function safeLocation(value) {
  return redactScalarLikeText(value).replace(/[\x00-\x1f\x7f]/g, "_").replace(/::/g, "__").slice(0, 300);
}

function pathDigest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function emitWarning(message) {
  const safeMessage = message.replace(/%/g, "%25").replace(/[\r\n]/g, " ");
  console.log(`::warning::${safeMessage}`);
}

export function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--snapshots", "--gitleaks", "--config"]).has(name) || !value || value.startsWith("--")) {
      throw new Error("usage: scan.mjs --snapshots <directory> --gitleaks <path> --config <path>");
    }
    if (values.has(name)) throw new Error("usage: scan.mjs --snapshots <directory> --gitleaks <path> --config <path>");
    values.set(name, value);
  }
  if (values.size !== 3) throw new Error("usage: scan.mjs --snapshots <directory> --gitleaks <path> --config <path>");
  return {
    snapshots: values.get("--snapshots"),
    gitleaks: values.get("--gitleaks"),
    config: values.get("--config"),
  };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const { snapshots, gitleaks, config } = parseCli(argv);
  const candidates = runGitleaksInventory({ snapshots, gitleaks, config });
  const addresses = [...candidates.keys()].map(deriveAddress);
  const chains = parseRpcUrls(environment.EVM_KEY_LIVENESS_RPC_URLS);
  if (chains.length === 0) {
    emitWarning("liveness scan incomplete: EVM_KEY_LIVENESS_RPC_URLS is unset");
    console.log(`advisory: checked ${candidates.size} unique Gitleaks candidate(s) against 0 RPC endpoint(s)`);
    return 0;
  }
  const { used, status } = await findUsedAddresses(addresses, chains);
  for (const line of reportAdvisory(candidates, used, status)) emitWarning(line);
  if (candidates.truncated) emitWarning("candidate enrichment was truncated at 128 unique candidates or 8 locations per candidate");
  console.log(`advisory: checked ${candidates.size} unique Gitleaks candidate(s) against ${chains.length} RPC endpoint(s)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then((status) => process.exit(status)).catch((error) => {
    console.error(`EVM liveness scanner error: ${sanitizeError(error)}`);
    process.exit(2);
  });
}
