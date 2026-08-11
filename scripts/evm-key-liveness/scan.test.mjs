// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectCandidatesFromReports,
  deriveAddress,
  findUsedAddresses,
  normalizeScalar,
  parseCli,
  reportAdvisory,
  sanitizeError,
} from "./scan.mjs";

const key = ["0xd1e5b1a0f6c8e3a94b7f2c5d8e0a3f6b", "9c2d5e8f1a4b7c0d3e6f9a2b5c8d1e4f"].join("");
const address = "0x0ceb6d5e139c6f79ab76d69a0d81d4ade23f0f3b";

function response(result, id) {
  return { ok: true, json: async () => ({ jsonrpc: "2.0", id, result }) };
}

test("accepts only valid secp256k1 scalar candidates", () => {
  assert.equal(normalizeScalar(key.toUpperCase()), key);
  assert.equal(normalizeScalar("0x" + "0".repeat(64)), null);
  assert.equal(normalizeScalar("0x" + "f".repeat(64)), null);
  assert.equal(normalizeScalar("not a scalar"), null);
});

test("derives the Ethereum address controlled by a scalar", () => {
  assert.equal(deriveAddress(key), address);
});

test("uses only Gitleaks report candidates and deduplicates the full range", () => {
  const secondKey = `0x${"0".repeat(63)}1`;
  const candidates = collectCandidatesFromReports([
    { commit: "a".repeat(40), findings: [{ Secret: key, File: "content/one.ts", StartLine: 3 }] },
    { commit: "b".repeat(40), findings: [{ Secret: key.slice(2), File: "metadata/commit-message.txt", StartLine: 1 }] },
    { commit: "b".repeat(40), findings: [{ Secret: secondKey, File: "metadata/commit-message.txt", StartLine: 1 }] },
    { commit: "c".repeat(40), findings: [{ Secret: "0x" + "0".repeat(64), File: "content/hash.ts", StartLine: 1 }] },
  ]);
  assert.equal(candidates.size, 2);
  assert.equal(candidates.get(key).length, 2);
  assert.equal(candidates.get(secondKey).length, 1);
});

test("caps candidate and location inventory", () => {
  const commit = "a".repeat(40);
  const findings = Array.from({ length: 129 }, (_, index) => ({
    Secret: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    File: "content/keys.ts",
    StartLine: index + 1,
  }));
  const candidates = collectCandidatesFromReports([{ commit, findings }]);
  assert.equal(candidates.size, 128);
  assert.equal(candidates.truncated, true);

  const repeated = collectCandidatesFromReports([{
    commit,
    findings: Array.from({ length: 9 }, (_, index) => ({ Secret: key, File: "content/keys.ts", StartLine: index + 1 })),
  }]);
  assert.equal(repeated.get(key).length, 8);
  assert.equal(repeated.truncated, true);
});

test("marks an active RPC address without querying a candidate twice", async () => {
  const calls = [];
  const fetchImpl = async (_url, request) => {
    const { method, id } = JSON.parse(request.body);
    calls.push(method);
    if (method === "eth_blockNumber") return response("0x10", id);
    if (method === "eth_getTransactionCount") return response("0x0", id);
    return response("0x1", id);
  };
  const result = await findUsedAddresses([address], [{ name: "mock", url: "https://rpc.example.invalid/token" }], { fetchImpl, attempts: 1, baseDelayMs: 0 });
  assert.deepEqual(result.used.get(address), ["mock"]);
  assert.deepEqual(result.status, [{ name: "mock", ok: true }]);
  assert.deepEqual(calls, ["eth_blockNumber", "eth_getTransactionCount", "eth_getBalance"]);
});

test("marks an inactive RPC address as checked", async () => {
  const result = await findUsedAddresses([address], [{ name: "mock", url: "https://rpc.example.invalid" }], {
    fetchImpl: async (_url, request) => {
      const { method, id } = JSON.parse(request.body);
      return response(method === "eth_blockNumber" ? "0x10" : "0x0", id);
    },
    attempts: 1,
    baseDelayMs: 0,
  });
  assert.equal(result.used.has(address), false);
  assert.deepEqual(result.status, [{ name: "mock", ok: true }]);
});

test("retries transient RPC errors", async () => {
  let attempts = 0;
  const result = await findUsedAddresses([address], [{ name: "mock", url: "https://rpc.example.invalid" }], {
    fetchImpl: async (_url, request) => {
      const { method, id } = JSON.parse(request.body);
      if (method === "eth_blockNumber" && attempts++ === 0) throw new Error("transient failure");
      return response(method === "eth_blockNumber" ? "0x10" : "0x0", id);
    },
    attempts: 2,
    baseDelayMs: 0,
  });
  assert.equal(attempts, 2);
  assert.deepEqual(result.status, [{ name: "mock", ok: true }]);
});

test("rejects malformed JSON-RPC envelopes", async () => {
  for (const payload of [
    { jsonrpc: "1.0", id: 1, result: "0x10" },
    { jsonrpc: "2.0", id: 2, result: "0x10" },
    { jsonrpc: "2.0", id: 1, result: null },
    { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "mock failure" } },
  ]) {
    const result = await findUsedAddresses([address], [{ name: "mock", url: "https://rpc.example.invalid" }], {
      fetchImpl: async () => ({ ok: true, json: async () => payload }),
      attempts: 1,
      baseDelayMs: 0,
    });
    assert.deepEqual(result.status, [{ name: "mock", ok: false, error: "RPC returned an invalid response" }]);
  }
});

test("retains a positive nonce when the balance request fails", async () => {
  const result = await findUsedAddresses([address], [{ name: "mock", url: "https://rpc.example.invalid" }], {
    fetchImpl: async (_url, request) => {
      const { method, id } = JSON.parse(request.body);
      if (method === "eth_blockNumber") return response("0x10", id);
      if (method === "eth_getTransactionCount") return response("0x1", id);
      throw new Error("balance request failed");
    },
    attempts: 1,
    baseDelayMs: 0,
  });
  assert.deepEqual(result.used.get(address), ["mock"]);
  assert.deepEqual(result.status, [{ name: "mock", ok: false, error: "balance request failed" }]);
});

test("retains a positive balance when the nonce result is malformed", async () => {
  const result = await findUsedAddresses([address], [{ name: "mock", url: "https://rpc.example.invalid" }], {
    fetchImpl: async (_url, request) => {
      const { method, id } = JSON.parse(request.body);
      if (method === "eth_blockNumber") return response("0x10", id);
      if (method === "eth_getTransactionCount") return response("not-a-quantity", id);
      return response("0x1", id);
    },
    attempts: 1,
    baseDelayMs: 0,
  });
  assert.deepEqual(result.used.get(address), ["mock"]);
  assert.equal(result.status[0].ok, false);
  assert.match(result.status[0].error, /Cannot convert/);
});

test("records timed-out RPC calls as incomplete", async () => {
  const result = await findUsedAddresses([address], [{ name: "mock", url: "https://rpc.example.invalid" }], {
    fetchImpl: async (_url, request) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
      }),
    }),
    attempts: 1,
    baseDelayMs: 0,
    timeoutMs: 5,
  });
  assert.deepEqual(result.status, [{ name: "mock", ok: false, error: "request timed out" }]);
});

test("records an incomplete RPC check and redacts its URL", async () => {
  const result = await findUsedAddresses([address], [{ name: "mock", url: "https://rpc.example.invalid/secret" }], {
    fetchImpl: async () => { throw new Error("request to https://rpc.example.invalid/secret failed"); },
    attempts: 1,
    baseDelayMs: 0,
  });
  assert.equal(result.status[0].ok, false);
  assert.equal(result.status[0].error.includes("/secret"), false);
  assert.equal(result.status[0].error.includes("rpc.example.invalid"), true);
});

test("advisory output warns for findings and incompleteness without exposing keys", () => {
  const firstHalf = key.slice(2, 34);
  const secondHalf = key.slice(34);
  const candidates = new Map([[key, [{ commit: "a".repeat(40), file: `source\u001b[2J-full-${key}/halves-${firstHalf}-${secondHalf}`, line: 2 }]]]);
  const lines = reportAdvisory(candidates, new Map([[address, ["mock"]]]), [{ name: "mock", ok: false, error: "timeout" }]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /active EVM key candidate/);
  assert.match(lines[0], /path-sha256=[0-9a-f]{16}/);
  assert.equal(lines.join("\n").includes(key), false);
  assert.equal(lines.join("\n").includes(key.slice(2, 10)), false);
  assert.equal(lines.join("\n").includes(firstHalf), false);
  assert.equal(lines.join("\n").includes(secondHalf), false);
  assert.equal(lines.join("\n").includes("\u001b"), false);
  assert.match(lines[1], /incomplete liveness check/);
  assert.equal(sanitizeError(new Error("https://rpc.example.invalid/private-token")).includes("private-token"), false);
  assert.equal(sanitizeError(new Error(`bad RPC result ${key}`)).includes(key.slice(2, 10)), false);
});

test("rejects malformed CLI arguments and normalizes accepted names", () => {
  assert.deepEqual(parseCli(["--snapshots", "snapshots", "--gitleaks", "gitleaks", "--config", "config"]), {
    snapshots: "snapshots",
    gitleaks: "gitleaks",
    config: "config",
  });
  for (const argv of [
    [],
    ["--snapshots", "snapshots", "--gitleaks", "gitleaks"],
    ["--snapshots", "snapshots", "--gitleaks", "gitleaks", "--config", "config", "--config", "other"],
    ["--snapshots", "snapshots", "--unknown", "value", "--config", "config"],
    ["--snapshots", "--gitleaks", "gitleaks", "--config", "config"],
  ]) assert.throws(() => parseCli(argv), /usage: scan\.mjs/);

  const result = spawnSync("node", ["scripts/evm-key-liveness/scan.mjs", "--snapshots", "snapshots", "--gitleaks", "gitleaks", "--config", "config", "--extra", "value"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /EVM liveness scanner error: usage: scan\.mjs/);
});

test("materializes every commit's full changed blob and commit message", () => {
  const root = mkdtempSync(join(tmpdir(), "vana-evm-materializer-test-"));
  const repo = join(root, "repo");
  const snapshots = join(root, "snapshots");
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    writeFileSync(join(repo, "key.ts"), "const privateKey =\n");
    execFileSync("git", ["-C", repo, "add", "key.ts"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(repo, "key.ts"), `const privateKey =\n  \"${key}\";\n`);
    execFileSync("git", ["-C", repo, "add", "key.ts"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add key"]);
    const added = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(repo, "key.ts"), "export const removed = true;\n");
    execFileSync("git", ["-C", repo, "add", "key.ts"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", `remove key ${key}`]);
    const removed = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync(join(process.cwd(), "scripts/materialize-commit-range.sh"), ["--repo", repo, "--range", `${base}..${removed}`, "--output", snapshots]);
    assert.equal(readFileSync(join(snapshots, "commits", added, "scan/content/key.ts"), "utf8").includes("const privateKey ="), true);
    assert.equal(readFileSync(join(snapshots, "commits", added, "scan/content/key.ts"), "utf8").includes(key), true);
    assert.equal(readFileSync(join(snapshots, "commits", removed, "scan/metadata/commit-message.txt"), "utf8").includes(key), true);
    const gitleaks = process.env.GITLEAKS_BIN ?? join(process.cwd(), ".tools/gitleaks/gitleaks");
    const output = execFileSync("node", ["scripts/evm-key-liveness/scan.mjs", "--snapshots", snapshots, "--config", ".gitleaks.toml", "--gitleaks", gitleaks], {
      cwd: process.cwd(),
      env: { ...process.env, EVM_KEY_LIVENESS_RPC_URLS: "" },
      encoding: "utf8",
    });
    assert.match(output, /::warning::liveness scan incomplete/);
    assert.match(output, /checked 1 unique Gitleaks candidate/);
    assert.equal(output.includes(key), false);
    assert.equal(output.includes(key.slice(2, 10)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
