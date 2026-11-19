const CHAINS = {
  "1": { name: "Ethereum", chainId: "1" },
  "56": { name: "BNB Chain", chainId: "56" },
  "8453": { name: "Base", chainId: "8453" }
};
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MEMORY_CACHE = new Map();
const IN_FLIGHT = new Map();
const CACHE_TTL_SECONDS = 45;
const MAX_RETRIES = 1;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
});
function withCors(response, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = new Set(["https://nexorascope.xyz", "https://www.nexorascope.xyz"]);
  const headers = new Headers(response.headers);
  if (allowed.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-allow-headers", "Content-Type");
    headers.set("access-control-max-age", "86400");
    headers.append("vary", "Origin");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
const truthy = v => v === true || v === 1 || v === "1" || v === "true" || v === "yes";
const asText = v => v == null ? "" : String(v);

function classifyFailure(status, message = "") {
  const m = String(message).toLowerCase();
  if (status === 429 || /too many requests|rate.?limit|frequency limit/.test(m)) return "rate_limited";
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api.?key|api key.*(invalid|missing)|authentication/.test(m)) return "auth_error";
  if (/quota|daily limit|monthly limit|limit exceeded|plan limit/.test(m)) return "quota_exceeded";
  if (status === 404) return "unavailable";
  if (status >= 500) return "unavailable";
  return "error";
}
function cacheKeyFor(url) {
  return new Request(`https://nexorascope-cache.invalid/${encodeURIComponent(url)}`, { method: "GET" });
}
async function cachedProviderGet(provider, url, env, { ttl = CACHE_TTL_SECONDS, headers = {} } = {}) {
  const key = cacheKeyFor(url);
  const inflightKey = `${provider}:${url}`;
  const now = Date.now();
  const mem = MEMORY_CACHE.get(inflightKey);
  if (mem && mem.expires > now) return { ...mem.value, cache: "memory" };
  if (IN_FLIGHT.has(inflightKey)) return { ...(await IN_FLIGHT.get(inflightKey)), cache: "inflight" };

  const job = (async () => {
    try {
      if (typeof caches !== "undefined" && caches.default) {
        const hit = await caches.default.match(key);
        if (hit) {
          const payload = await hit.json();
          MEMORY_CACHE.set(inflightKey, { value: payload, expires: now + ttl * 1000 });
          return { ...payload, cache: "edge" };
        }
      }
    } catch (_) { /* Cache is an optimization; continue with the live provider. */ }

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const requestHeaders = { accept: "application/json", ...headers };
        if (provider === "goplus" && env.GOPLUS_TOKEN) requestHeaders.authorization = `Bearer ${env.GOPLUS_TOKEN}`;
        const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(12000) });
        let data = null;
        try { data = await response.json(); } catch (_) { throw Object.assign(new Error("Provider returned invalid JSON"), { httpStatus: response.status }); }
        const providerMessage = data?.message || data?.msg || data?.error || "";
        const providerCode = data?.code;
        const appError = providerCode !== undefined && String(providerCode) !== "1" && provider !== "etherscan";
        if (!response.ok || appError) {
          const failureStatus = classifyFailure(response.status, providerMessage || JSON.stringify(data));
          const err = Object.assign(new Error(providerMessage || `HTTP ${response.status}`), { status: failureStatus, httpStatus: response.status });
          if (attempt < MAX_RETRIES && (failureStatus === "rate_limited" || failureStatus === "unavailable")) {
            await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
            lastError = err;
            continue;
          }
          throw err;
        }
        const value = { status: "success", data, httpStatus: response.status, message: "Provider request completed" };
        MEMORY_CACHE.set(inflightKey, { value, expires: Date.now() + ttl * 1000 });
        if (typeof caches !== "undefined" && caches.default) {
          try {
            const cacheResponse = new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } });
            await caches.default.put(key, cacheResponse);
          } catch (_) { /* Ignore cache write failures. */ }
        }
        return { ...value, cache: "miss" };
      } catch (error) {
        lastError = error;
        if (error?.status) throw error;
        const failureStatus = classifyFailure(error?.httpStatus || 0, error?.message || "");
        if (attempt < MAX_RETRIES && failureStatus === "unavailable") {
          await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
          continue;
        }
        throw Object.assign(error, { status: failureStatus, httpStatus: error?.httpStatus || null });
      }
    }
    throw lastError || Object.assign(new Error("Provider request failed"), { status: "error" });
  })();
  IN_FLIGHT.set(inflightKey, job);
  try { return await job; }
  finally { IN_FLIGHT.delete(inflightKey); }
}
function unwrapResult(data) { return data?.result ?? data?.data ?? data; }
function addFinding(findings, title, detail, level = "neutral", weight = 0) {
  findings.push({ title, detail, level, weight });
}
function scoreFindings(findings) {
  const assessed = findings.filter(f => f.weight > 0);
  if (!assessed.length) return null;
  return Math.max(0, Math.min(100, 100 - assessed.reduce((sum, f) => sum + f.weight, 0)));
}
function walkObject(obj, path = "", out = [], depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6 || out.length > 1500) return out;
  if (Array.isArray(obj)) { obj.slice(0, 100).forEach((v, i) => walkObject(v, `${path}[${i}]`, out, depth + 1)); return out; }
  for (const [key, value] of Object.entries(obj)) {
    const p = path ? `${path}.${key}` : key;
    if (value && typeof value === "object") walkObject(value, p, out, depth + 1);
    else out.push({ key, path: p, value });
  }
  return out;
}
function summarizeAddressRisk(data, findings) {
  const obj = unwrapResult(data);
  const rows = walkObject(obj);
  const badTerms = ["is_malicious", "is_blacklisted", "is_sanctioned", "is_phishing", "is_scam", "is_fraud", "is_stealing", "is_honeypot", "is_money_laundering", "is_criminal"];
  const hits = rows.filter(r => badTerms.some(t => r.key.toLowerCase().includes(t)) && truthy(r.value));
  const doubt = obj && typeof obj === "object" && truthy(obj.doubt_list);
  const behaviors = Array.isArray(obj?.malicious_behavior) ? obj.malicious_behavior : [];
  if (hits.length || doubt || behaviors.length) {
    const details = [...hits.slice(0, 8).map(h => `${h.key}: ${h.value}`), ...(doubt ? ["doubt_list: suspected malicious contract"] : []), ...behaviors.slice(0, 8).map(x => `behavior: ${String(x)}`)];
    addFinding(findings, "Known address risk signals", details.join("; "), "bad", 55);
  } else if (obj && typeof obj === "object" && Object.keys(obj).length) {
    addFinding(findings, "Malicious-address lookup", "No positive flag was returned in the fields inspected. This is not proof that the address is safe.", "good", 0);
  } else addFinding(findings, "Malicious-address lookup", "The provider returned no usable result for this address.", "neutral", 0);
}
function summarizeTokenRisk(data, findings) {
  const result = unwrapResult(data);
  const token = result && typeof result === "object" ? Object.values(result)[0] || result : null;
  if (!token || typeof token !== "object") { addFinding(findings, "Token security data", "No token security record was returned for this contract and network.", "neutral", 0); return; }
  const checks = [
    ["is_honeypot", "Honeypot signal", "The provider flagged a possible honeypot characteristic.", 45],
    ["is_mintable", "Minting capability", "The provider reports that the token may be mintable. Review who controls this capability.", 18],
    ["is_blacklisted", "Blacklist capability", "The provider reports a blacklist-related control or risk flag.", 22],
    ["transfer_pausable", "Transfer pause capability", "Transfers may be pausable by a privileged role.", 12],
    ["slippage_modifiable", "Modifiable trading tax", "The provider reports that buy/sell tax or slippage may be modifiable.", 18],
    ["is_proxy", "Proxy contract", "This token is reported as a proxy. Review implementation and upgrade authority.", 8],
    ["can_take_back_ownership", "Ownership recovery capability", "The provider reports a possible ownership recovery capability.", 20]
  ];
  for (const [key, title, detail, weight] of checks) {
    if (truthy(token[key])) addFinding(findings, title, detail, weight >= 20 ? "bad" : "warn", weight);
    else if (token[key] === "0" || token[key] === 0 || token[key] === false) addFinding(findings, title, "No positive flag was returned for this check.", "good", 0);
    else addFinding(findings, title, "Not reported by the provider.", "neutral", 0);
  }
  if (token.is_open_source === "0" || token.is_open_source === 0) addFinding(findings, "Source verification", "The provider reports that source code is not open-source/verified.", "warn", 15);
  else if (truthy(token.is_open_source)) addFinding(findings, "Source verification", "The provider reports verified/open source code. Verification does not mean the code is safe.", "good", 0);
  else addFinding(findings, "Source verification", "Verification status was not reported.", "neutral", 0);
  for (const key of ["buy_tax", "sell_tax"]) {
    const n = Number(token[key]);
    if (Number.isFinite(n) && token[key] !== "" && n > 0.1) addFinding(findings, key === "buy_tax" ? "Buy tax" : "Sell tax", `Provider-reported value: ${token[key]}. Confirm units and current behavior before relying on this figure.`, n > 0.25 ? "bad" : "warn", n > 0.25 ? 15 : 8);
  }
  if (token.owner_address) addFinding(findings, "Owner address", `Reported owner: ${String(token.owner_address)}`, "neutral", 0);
}
const FIELD_ALIASES = {
  token: ["token_name", "token_symbol", "nft_name", "nft_symbol", "collection_name"],
  tokenAddress: ["token_address", "contract_address", "token_contract_address", "nft_address", "collection_address"],
  spender: ["spender", "spender_address", "approved_spender", "operator", "operator_address", "approved_address"],
  allowance: ["allowance", "amount", "approved_amount", "value", "approved_value"],
  tokenId: ["token_id", "tokenid", "nft_token_id"],
  risky: ["risky_approval", "is_risky", "risk"],
  symbol: ["token_symbol", "symbol", "nft_symbol"]
};
function findField(obj, aliases) {
  const entries = Object.entries(obj || {});
  for (const alias of aliases) {
    const found = entries.find(([k, v]) => k.toLowerCase() === alias && (typeof v !== "object" || v === null));
    if (found) return found[1];
  }
  return "";
}
function collectRecordObjects(value, out = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 6 || out.length >= 500) return out;
  if (Array.isArray(value)) { for (const v of value) collectRecordObjects(v, out, depth + 1); return out; }
  const keys = Object.keys(value).map(k => k.toLowerCase());
  const looksLikeRecord = keys.some(k => FIELD_ALIASES.tokenAddress.includes(k) || FIELD_ALIASES.spender.includes(k) || FIELD_ALIASES.allowance.includes(k) || FIELD_ALIASES.tokenId.includes(k) || FIELD_ALIASES.risky.includes(k));
  if (looksLikeRecord) { out.push(value); return out; }
  for (const [k, v] of Object.entries(value)) if (v && typeof v === "object") collectRecordObjects(v, out, depth + 1);
  return out;
}
function normalizeApprovals(data, standard) {
  const result = unwrapResult(data);
  const objects = collectRecordObjects(result);
  const unique = new Map();
  for (const item of objects) {
    const row = {
      standard,
      token: asText(findField(item, FIELD_ALIASES.token) || findField(item, FIELD_ALIASES.symbol)),
      tokenAddress: asText(findField(item, FIELD_ALIASES.tokenAddress)),
      spender: asText(findField(item, FIELD_ALIASES.spender)),
      allowance: asText(findField(item, FIELD_ALIASES.allowance)),
      tokenId: asText(findField(item, FIELD_ALIASES.tokenId)),
      risky: truthy(findField(item, FIELD_ALIASES.risky)) || truthy(item?.risky_approval?.value) || truthy(item?.risky_approval?.is_risky),
      rawRisk: asText(findField(item, FIELD_ALIASES.risky) || item?.risky_approval?.value || item?.risky_approval?.is_risky)
    };
    const key = JSON.stringify(row);
    unique.set(key, row);
  }
  return [...unique.values()];
}
function approvalFinding(standard, records, findings) {
  const risky = records.filter(r => r.risky);
  if (risky.length) addFinding(findings, `${standard} approval risk`, `${risky.length} provider-reported risky approval record(s) found. Review the spender/operator and permission scope.`, "bad", standard === "ERC-20" ? 22 : 18);
  else if (records.length) addFinding(findings, `${standard} approvals returned`, `${records.length} approval record(s) returned. No explicit risky flag was extracted; inspect each permission before deciding it is safe.`, "neutral", 0);
  else addFinding(findings, `${standard} approval data`, "The provider returned no parseable approval records. This does not prove that no approvals exist.", "neutral", 0);
}
function providerStatus(provider, result) {
  if (result?.status) return { provider, status: result.status, httpStatus: result.httpStatus ?? null, message: result.message || "", cache: result.cache || "none" };
  return { provider, status: "unknown", httpStatus: null, message: "No provider result was recorded", cache: "none" };
}
async function getEtherscanSource(address, chainId, env) {
  if (!env.ETHERSCAN_API_KEY) return { status: "unavailable", configured: false, message: "ETHERSCAN_API_KEY is not configured" };
  const url = new URL("https://api.etherscan.io/v2/api");
  url.search = new URLSearchParams({ chainid: chainId, module: "contract", action: "getsourcecode", address, apikey: env.ETHERSCAN_API_KEY });
  try {
    const result = await cachedProviderGet("etherscan", url.toString(), env, { ttl: 120 });
    const data = result.data;
    const item = data?.result?.[0];
    if (String(data?.status) === "0" && !item?.SourceCode) {
      const msg = `${data?.message || "Explorer returned no source"} ${Array.isArray(data?.result) ? data.result[0] : ""}`.trim();
      return { ...result, status: classifyFailure(200, msg), configured: true, verified: null, message: msg };
    }
    if (!item) return { ...result, configured: true, verified: null, message: data?.message || "No source metadata returned" };
    return { ...result, configured: true, verified: Boolean(item.SourceCode), contractName: item.ContractName || "", compilerVersion: item.CompilerVersion || "", proxy: item.Proxy || "0", implementation: item.Implementation || "" };
  } catch (e) { return { status: e.status || "error", configured: true, httpStatus: e.httpStatus || null, message: e.message || "Explorer request failed" }; }
}
async function handleScan(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const mode = body?.mode;
  const chainId = String(body?.chainId || "");
  const address = String(body?.address || "").trim();
  if (!CHAINS[chainId]) return json({ error: "Unsupported network. Choose Ethereum, BNB Chain or Base." }, 400);
  if (!ADDRESS_RE.test(address)) return json({ error: "Invalid EVM address format." }, 400);
  if (!["wallet", "contract"].includes(mode)) return json({ error: "Invalid scan mode." }, 400);
  const findings = [];
  const approvals = [];
  const providers = {};
  const sources = [];
  const base = "https://api.gopluslabs.io";
  const jobs = [];
  const runGoPlus = async (key, url, onSuccess) => {
    try {
      const result = await cachedProviderGet("goplus", url, env);
      providers[key] = providerStatus("GoPlus", result);
      sources.push(`GoPlus ${key}`);
      onSuccess(result.data);
    } catch (e) {
      providers[key] = { provider: "GoPlus", status: e.status || "error", httpStatus: e.httpStatus || null, message: e.message || "Provider request failed", cache: "none" };
      addFinding(findings, `${key} unavailable`, `${providers[key].status}: ${providers[key].message}`, "neutral", 0);
    }
  };
  if (mode === "wallet") {
    jobs.push(runGoPlus("address_security", `${base}/api/v1/address_security/${address}?chain_id=${chainId}`, data => summarizeAddressRisk(data, findings)));
    for (const [endpoint, standard] of [["token_approval_security", "ERC-20"], ["nft721_approval_security", "ERC-721"], ["nft1155_approval_security", "ERC-1155"]]) {
      jobs.push(runGoPlus(endpoint, `${base}/api/v2/${endpoint}/${chainId}?addresses=${address}`, data => {
        const records = normalizeApprovals(data, standard);
        approvals.push(...records);
        approvalFinding(standard, records, findings);
      }));
    }
  } else {
    jobs.push(runGoPlus("token_security", `${base}/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`, data => summarizeTokenRisk(data, findings)));
    jobs.push((async () => {
      const meta = await getEtherscanSource(address, chainId, env);
      providers.etherscan = { provider: "Etherscan API V2", status: meta.status || "success", httpStatus: meta.httpStatus || null, message: meta.message || "", cache: meta.cache || "none" };
      if (!meta.configured) addFinding(findings, "Explorer source metadata", "Not configured. Add ETHERSCAN_API_KEY as a Worker secret to retrieve verified-source metadata.", "neutral", 0);
      else if (meta.verified === true) addFinding(findings, "Verified source metadata", `Explorer reports verified source${meta.contractName ? ` for ${meta.contractName}` : ""}. This is not a security audit. Proxy: ${meta.proxy === "1" ? "yes" : "no"}${meta.implementation ? `; implementation: ${meta.implementation}` : ""}.`, "good", 0);
      else if (meta.verified === false) addFinding(findings, "Source verification", "Explorer did not return verified source code for this address.", "warn", 15);
      else addFinding(findings, "Explorer source metadata", meta.message || "No metadata returned.", "neutral", 0);
      if (meta.configured && meta.status === "success") sources.push("Etherscan API V2");
    })());
  }
  await Promise.all(jobs);
  if (!findings.length) addFinding(findings, "No data returned", "The configured providers did not return usable data. No safety conclusion can be made.", "neutral", 0);
  const successful = Object.values(providers).filter(p => p.status === "success").length;
  const overallStatus = successful === Object.keys(providers).length && successful > 0 ? "complete" : successful > 0 ? "partial" : "unavailable";
  return json({ schemaVersion: 2, mode, chainId, chain: CHAINS[chainId].name, target: address, checkedAt: new Date().toISOString(), overallStatus, score: scoreFindings(findings), scoreLabel: scoreFindings(findings) === null ? "Insufficient data" : "Indicator score", findings, approvals, providers, sources: [...new Set(sources)], disclaimer: "Automated indicators only; not an audit or guarantee. Missing provider data must not be interpreted as proof of safety or absence of approvals." });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (["/api/scan", "/api/health"].includes(url.pathname) && request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }
    if (url.pathname === "/api/scan") {
      try { return withCors(await handleScan(request, env), request); }
      catch (_) { return withCors(json({ error: "Unexpected scan error. Please try again later." }, 500), request); }
    }
    if (url.pathname === "/api/health") return withCors(json({ status: "ok", service: "nexorascope-security-api", apiVersion: 2, supportedChains: Object.keys(CHAINS) }), request);
    return withCors(json({ error: "Not found" }, 404), request);
  }
};
