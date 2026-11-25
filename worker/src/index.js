// Preview Worker deployment trigger: 2026-11-24
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

const ETHERSCAN_API = "https://api.etherscan.io/v2/api";
const GOPLUS_API = "https://api.gopluslabs.io";
const PROVIDER_COOLDOWNS = new Map();
const GOPLUS_DEFAULT_COOLDOWN_MS = 60 * 1000;

function retryAfterMilliseconds(response, fallbackMs = GOPLUS_DEFAULT_COOLDOWN_MS) {
  const value = response?.headers?.get("retry-after");
  if (!value) return fallbackMs;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, 1000), 5 * 60 * 1000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 1000), 5 * 60 * 1000);
  }

  return fallbackMs;
}

const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

const APPROVAL_FOR_ALL_TOPIC =
  "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";

let nextEtherscanRequestAt = 0;
const ETHERSCAN_REQUEST_INTERVAL_MS = 400;

const DECIMALS_CACHE = new Map();
const DECIMALS_CACHE_TTL = 60 * 60 * 1000;
const TOKEN_METADATA_CACHE = new Map();
const TOKEN_METADATA_CACHE_TTL = 24 * 60 * 60 * 1000;

const KNOWN_SPENDERS = {
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": {
    name: "Uniswap V2 Router02",
    category: "DEX router",
    identity: "known_protocol"
  },
  "0x000000000022d473030f116ddee9f6b43ac78ba3": {
    name: "Uniswap Permit2",
    category: "Token approval manager",
    identity: "known_protocol"
  },
};

const json = (data, status = 200) => new Response(
  JSON.stringify(data),
  {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  }
);

function withCors(response, request) {
  const origin = request.headers.get("Origin") || "";

  const allowed = new Set([
    "https://nexorascope.xyz",
    "https://www.nexorascope.xyz",
    "https://nexorascope.pages.dev"
  ]);

  const isNexoraPreview =
    /^https:\/\/[a-z0-9-]+\.nexorascope\.pages\.dev$/i.test(origin);

  const headers = new Headers(response.headers);

  if (allowed.has(origin) || isNexoraPreview) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-allow-headers", "Content-Type");
    headers.set("access-control-max-age", "86400");
    headers.append("vary", "Origin");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

const truthy = v =>
  v === true || v === 1 || v === "1" || v === "true" || v === "yes";

const asText = v => v == null ? "" : String(v);

function classifyFailure(status, message = "") {
  const m = String(message).toLowerCase();

  if (
    status === 429 ||
    /too many requests|rate.?limit|frequency limit/.test(m)
  ) {
    return "rate_limited";
  }

  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|invalid api.?key|api key.*(invalid|missing)|authentication/.test(m)
  ) {
    return "auth_error";
  }

  if (
    /quota|daily limit|monthly limit|limit exceeded|plan limit/.test(m)
  ) {
    return "quota_exceeded";
  }

  if (
    status === 404 ||
    status >= 500 ||
    /timeout|timed out|aborterror|network error|fetch failed|connection reset|connection refused/.test(m)
  ) {
    return "unavailable";
  }

  return "error";
}

async function waitForEtherscanSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextEtherscanRequestAt);

  nextEtherscanRequestAt =
    scheduledAt + ETHERSCAN_REQUEST_INTERVAL_MS;

  if (scheduledAt > now) {
    await new Promise(resolve =>
      setTimeout(resolve, scheduledAt - now)
    );
  }
}

async function fetchEtherscanJson(url, timeout = 15000) {
  let lastError;

  for (let attempt = 0; attempt <= 2; attempt++) {
    await waitForEtherscanSlot();

    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeout)
      });

      let data;

      try {
        data = await response.json();
      } catch {
        throw new Error("Etherscan returned invalid JSON");
      }

      const message = [
        data?.message,
        data?.result,
        data?.error?.message
      ].filter(Boolean).join(" ");

      const rateLimited =
        response.status === 429 ||
        /rate.?limit|too many requests|max rate limit/i.test(message);

      if (!response.ok || rateLimited) {
        const error = new Error(
          message || `Etherscan HTTP ${response.status}`
        );

        error.httpStatus = response.status;
        error.status = rateLimited
          ? "rate_limited"
          : classifyFailure(response.status, message);

        if (attempt < 2 && (
          rateLimited ||
          response.status >= 500
        )) {
          lastError = error;

          await new Promise(resolve =>
            setTimeout(resolve, 700 * (attempt + 1))
          );

          continue;
        }

        throw error;
      }

      if (
        String(data?.status) === "0" &&
        !/no records found/i.test(String(data?.result || ""))
      ) {
        const apiError = new Error(
          String(data?.result || data?.message || "Etherscan API error")
        );

        apiError.status = classifyFailure(200, apiError.message);

        if (
          attempt < 2 &&
          apiError.status === "rate_limited"
        ) {
          lastError = apiError;

          await new Promise(resolve =>
            setTimeout(resolve, 700 * (attempt + 1))
          );

          continue;
        }

        throw apiError;
      }

      return data;

    } catch (error) {
      lastError = error;

      if (
        attempt < 2 &&
        (
          error?.status === "rate_limited" ||
          error?.status === "unavailable"
        )
      ) {
        await new Promise(resolve =>
          setTimeout(resolve, 700 * (attempt + 1))
        );

        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("Etherscan request failed");
}

function cacheKeyFor(url) {
  return new Request(
    `https://nexorascope-cache.invalid/${encodeURIComponent(url)}`,
    { method: "GET" }
  );
}

async function cachedProviderGet(
  provider,
  url,
  env,
  { ttl = CACHE_TTL_SECONDS, headers = {}, rateLimitScope = null } = {}
) {
  const key = cacheKeyFor(url);
  const inflightKey = `${provider}:${url}`;
  const now = Date.now();

  const mem = MEMORY_CACHE.get(inflightKey);

  if (mem && mem.expires > now) {
    return { ...mem.value, cache: "memory" };
  }

  if (IN_FLIGHT.has(inflightKey)) {
    return {
      ...(await IN_FLIGHT.get(inflightKey)),
      cache: "inflight"
    };
  }

  const job = (async () => {
    try {
      if (typeof caches !== "undefined" && caches.default) {
        const hit = await caches.default.match(key);

        if (hit) {
          const payload = await hit.json();

          MEMORY_CACHE.set(inflightKey, {
            value: payload,
            expires: now + ttl * 1000
          });

          return { ...payload, cache: "edge" };
        }
      }
    } catch (_) {}

    const cooldownKey = rateLimitScope
      ? `${provider}:${rateLimitScope}`
      : null;
    const cooldownUntil = cooldownKey
      ? (PROVIDER_COOLDOWNS.get(cooldownKey) || 0)
      : 0;

    if (cooldownUntil > Date.now()) {
      const retryAfterSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
      throw Object.assign(
        new Error(`${provider} rate limit cooldown is active; retry in about ${retryAfterSeconds} seconds`),
        {
          status: "rate_limited",
          httpStatus: null,
          retryAfterSeconds
        }
      );
    }

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const requestHeaders = {
          accept: "application/json",
          ...headers
        };

        if (provider === "goplus" && env.GOPLUS_TOKEN) {
          requestHeaders.authorization =
            `Bearer ${env.GOPLUS_TOKEN}`;
        }

        const response = await fetch(url, {
          headers: requestHeaders,
          signal: AbortSignal.timeout(12000)
        });

        let data;

        try {
          data = await response.json();
        } catch (_) {
          throw Object.assign(
            new Error("Provider returned invalid JSON"),
            { httpStatus: response.status }
          );
        }

        const providerMessage =
          data?.message || data?.msg || data?.error || "";

        const providerCode = data?.code;

        const appError =
          providerCode !== undefined &&
          String(providerCode) !== "1" &&
          provider !== "etherscan";

        if (!response.ok || appError) {
          const failureStatus = classifyFailure(
            response.status,
            providerMessage || JSON.stringify(data)
          );

          const err = Object.assign(
            new Error(providerMessage || `HTTP ${response.status}`),
            {
              status: failureStatus,
              httpStatus: response.status
            }
          );

          if (failureStatus === "rate_limited" && cooldownKey) {
            const cooldownMs = retryAfterMilliseconds(response);
            PROVIDER_COOLDOWNS.set(cooldownKey, Date.now() + cooldownMs);
            err.retryAfterMs = cooldownMs;
            err.retryAfterSeconds = Math.ceil(cooldownMs / 1000);
            throw err;
          }

          if (
            attempt < MAX_RETRIES &&
            (
              failureStatus === "rate_limited" ||
              failureStatus === "unavailable"
            )
          ) {
            await new Promise(resolve =>
              setTimeout(resolve, 350 * (attempt + 1))
            );

            lastError = err;
            continue;
          }

          throw err;
        }

        const value = {
          status: "success",
          data,
          httpStatus: response.status,
          message: "Provider request completed"
        };

        MEMORY_CACHE.set(inflightKey, {
          value,
          expires: Date.now() + ttl * 1000
        });

        if (typeof caches !== "undefined" && caches.default) {
          try {
            await caches.default.put(
              key,
              new Response(JSON.stringify(value), {
                headers: {
                  "content-type": "application/json",
                  "cache-control": `public, max-age=${ttl}`
                }
              })
            );
          } catch (_) {}
        }

        return { ...value, cache: "miss" };

      } catch (error) {
        lastError = error;

        const failureStatus = error?.status || classifyFailure(
          error?.httpStatus || 0,
          error?.message || ""
        );

        if (failureStatus === "rate_limited" && cooldownKey) {
          const cooldownMs = error?.retryAfterMs ||
            (error?.retryAfterSeconds ? error.retryAfterSeconds * 1000 : GOPLUS_DEFAULT_COOLDOWN_MS);
          PROVIDER_COOLDOWNS.set(cooldownKey, Date.now() + cooldownMs);
          error.status = "rate_limited";
          error.retryAfterSeconds = error.retryAfterSeconds ||
            Math.ceil(cooldownMs / 1000);
          throw error;
        }

        if (error?.status) throw error;

        if (          attempt < MAX_RETRIES &&
          failureStatus === "unavailable"
        ) {
          await new Promise(resolve =>
            setTimeout(resolve, 350 * (attempt + 1))
          );

          continue;
        }

        throw Object.assign(error, {
          status: failureStatus,
          httpStatus: error?.httpStatus || null
        });
      }
    }

    throw lastError ||
      Object.assign(new Error("Provider request failed"), {
        status: "error"
      });
  })();

  IN_FLIGHT.set(inflightKey, job);

  try {
    return await job;
  } finally {
    IN_FLIGHT.delete(inflightKey);
  }
}

function unwrapResult(data) {
  return data?.result ?? data?.data ?? data;
}

function addFinding(
  findings,
  title,
  detail,
  level = "neutral",
  weight = 0
) {
  findings.push({ title, detail, level, weight });
}

function scoreFindings(findings) {
  const assessed = findings.filter(f => f.weight > 0);

  if (!assessed.length) return 95;

  return Math.max(
    0,
    Math.min(
      100,
      100 - assessed.reduce((sum, f) => sum + f.weight, 0)
    )
  );
}

function walkObject(obj, path = "", out = [], depth = 0) {
  if (
    !obj ||
    typeof obj !== "object" ||
    depth > 6 ||
    out.length > 1500
  ) return out;

  if (Array.isArray(obj)) {
    obj.slice(0, 100).forEach((v, i) =>
      walkObject(v, `${path}[${i}]`, out, depth + 1)
    );

    return out;
  }

  for (const [key, value] of Object.entries(obj)) {
    const p = path ? `${path}.${key}` : key;

    if (value && typeof value === "object") {
      walkObject(value, p, out, depth + 1);
    } else {
      out.push({ key, path: p, value });
    }
  }

  return out;
}

function summarizeAddressRisk(data, findings) {
  const obj = unwrapResult(data);
  const rows = walkObject(obj);

  const badTerms = [
    "is_malicious",
    "is_blacklisted",
    "is_sanctioned",
    "is_phishing",
    "is_scam",
    "is_fraud",
    "is_stealing",
    "is_honeypot",
    "is_money_laundering",
    "is_criminal"
  ];

  const hits = rows.filter(r =>
    badTerms.some(t => r.key.toLowerCase().includes(t)) &&
    truthy(r.value)
  );

  const doubt =
    obj && typeof obj === "object" && truthy(obj.doubt_list);

  const behaviors = Array.isArray(obj?.malicious_behavior)
    ? obj.malicious_behavior
    : [];

  if (hits.length || doubt || behaviors.length) {
    const details = [
      ...hits.slice(0, 8).map(h => `${h.key}: ${h.value}`),
      ...(doubt ? ["doubt_list: suspected malicious contract"] : []),
      ...behaviors.slice(0, 8).map(x => `behavior: ${String(x)}`)
    ];

    addFinding(
      findings,
      "Known address risk signals",
      details.join("; "),
      "bad",
      55
    );

  } else if (obj && typeof obj === "object" && Object.keys(obj).length) {
    addFinding(
      findings,
      "Malicious-address lookup",
      "No positive flag was returned in the fields inspected. This is not proof that the address is safe.",
      "good",
      0
    );

  } else {
    addFinding(
      findings,
      "Malicious-address lookup",
      "The provider returned no usable result for this address.",
      "neutral",
      0
    );
  }
}

function summarizeTokenRisk(data, findings) {
  const result = unwrapResult(data);

  const token =
    result && typeof result === "object"
      ? Object.values(result)[0] || result
      : null;

  if (!token || typeof token !== "object") {
    addFinding(
      findings,
      "Token security data",
      "No token security record was returned for this contract and network.",
      "neutral",
      0
    );
    return;
  }

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
    if (truthy(token[key])) {
      addFinding(findings, title, detail, weight >= 20 ? "bad" : "warn", weight);
    } else if (
      token[key] === "0" ||
      token[key] === 0 ||
      token[key] === false
    ) {
      addFinding(findings, title, "No positive flag was returned for this check.", "good", 0);
    } else {
      addFinding(findings, title, "Not reported by the provider.", "neutral", 0);
    }
  }

  if (token.is_open_source === "0" || token.is_open_source === 0) {
    addFinding(
      findings,
      "Source verification",
      "The provider reports that source code is not open-source/verified.",
      "warn",
      15
    );
  } else if (truthy(token.is_open_source)) {
    addFinding(
      findings,
      "Source verification",
      "The provider reports verified/open source code. Verification does not mean the code is safe.",
      "good",
      0
    );
  } else {
    addFinding(findings, "Source verification", "Verification status was not reported.", "neutral", 0);
  }

  for (const key of ["buy_tax", "sell_tax"]) {
    const n = Number(token[key]);

    if (Number.isFinite(n) && token[key] !== "" && n > 0.1) {
      addFinding(
        findings,
        key === "buy_tax" ? "Buy tax" : "Sell tax",
        `Provider-reported value: ${token[key]}. Confirm units and current behavior before relying on this figure.`,
        n > 0.25 ? "bad" : "warn",
        n > 0.25 ? 15 : 8
      );
    }
  }

  if (token.owner_address) {
    addFinding(findings, "Owner address", `Reported owner: ${String(token.owner_address)}`, "neutral", 0);
  }
}

const FIELD_ALIASES = {
  token: ["token_name", "token_symbol", "nft_name", "nft_symbol", "collection_name"],
  tokenAddress: ["token_address", "contract_address", "token_contract_address", "nft_address", "collection_address"],
  spender: ["spender", "spender_address", "approved_spender", "approved_contract", "operator", "operator_address", "approved_address"],
  allowance: ["allowance", "amount", "approved_amount", "value", "approved_value"],
  tokenId: ["token_id", "tokenid", "nft_token_id", "approved_token_id"],
  risky: ["risky_approval", "is_risky", "risk"],
  symbol: ["token_symbol", "symbol", "nft_symbol"]
};

function findField(obj, aliases) {
  const entries = Object.entries(obj || {});

  for (const alias of aliases) {
    const found = entries.find(([k, v]) =>
      k.toLowerCase() === alias &&
      (typeof v !== "object" || v === null)
    );

    if (found) return found[1];
  }

  return "";
}

function collectRecordObjects(value, out = [], depth = 0) {
  if (
    !value ||
    typeof value !== "object" ||
    depth > 6 ||
    out.length >= 500
  ) return out;

  if (Array.isArray(value)) {
    for (const v of value) collectRecordObjects(v, out, depth + 1);
    return out;
  }

  const keys = Object.keys(value).map(k => k.toLowerCase());

  const looksLikeRecord = keys.some(k =>
    FIELD_ALIASES.tokenAddress.includes(k) ||
    FIELD_ALIASES.spender.includes(k) ||
    FIELD_ALIASES.allowance.includes(k) ||
    FIELD_ALIASES.tokenId.includes(k) ||
    FIELD_ALIASES.risky.includes(k)
  );

  if (looksLikeRecord) {
    out.push(value);
    return out;
  }

  for (const v of Object.values(value)) {
    if (v && typeof v === "object") collectRecordObjects(v, out, depth + 1);
  }

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
      risky:
        truthy(findField(item, FIELD_ALIASES.risky)) ||
        truthy(item?.risky_approval?.value) ||
        truthy(item?.risky_approval?.is_risky),
      rawRisk: asText(
        findField(item, FIELD_ALIASES.risky) ||
        item?.risky_approval?.value ||
        item?.risky_approval?.is_risky
      )
    };

    unique.set(JSON.stringify(row), row);
  }

  return [...unique.values()];
}

function approvalFinding(standard, records, findings) {
  const risky = records.filter(r => r.risky);

  if (risky.length) {
    addFinding(
      findings,
      `${standard} approval risk`,
      `${risky.length} provider-reported risky approval record(s) found. Review the spender/operator and permission scope.`,
      "bad",
      standard === "ERC-20" ? 22 : 18
    );
  } else if (records.length) {
    addFinding(
      findings,
      `${standard} approvals returned`,
      `${records.length} approval record(s) returned. No explicit risky flag was extracted; inspect each permission before deciding it is safe.`,
      "neutral",
      0
    );
  } else {
    addFinding(
      findings,
      `${standard} approval data`,
      "The provider returned no parseable approval records. This does not prove that no approvals exist.",
      "neutral",
      0
    );
  }
}

function providerStatus(provider, result) {
  if (result?.status) {
    return {
      provider,
      status: result.status,
      httpStatus: result.httpStatus ?? null,
      message: result.message || "",
      retryAfterSeconds: result.retryAfterSeconds ?? null,
      cache: result.cache || "none"
    };
  }

  return {
    provider,
    status: "unknown",
    httpStatus: null,
    message: "No provider result was recorded",
    cache: "none"
  };
}

async function getEtherscanSource(address, chainId, env) {
  if (!env.ETHERSCAN_API_KEY) {
    return {
      status: "unavailable",
      configured: false,
      message: "ETHERSCAN_API_KEY is not configured"
    };
  }

  const url = new URL(ETHERSCAN_API);

  url.search = new URLSearchParams({
    chainid: chainId,
    module: "contract",
    action: "getsourcecode",
    address,
    apikey: env.ETHERSCAN_API_KEY
  });

  try {
    const result = await cachedProviderGet("etherscan", url.toString(), env, { ttl: 120 });
    const data = result.data;
    const item = data?.result?.[0];
    if (String(data?.status) === "0" && !item?.SourceCode) {
      const msg =        `${data?.message || "Explorer returned no source"} ` +
        `${Array.isArray(data?.result) ? data.result[0] : ""}`.trim();

      return {
        ...result,
        status: classifyFailure(200, msg),
        configured: true,
        verified: null,
        message: msg
      };
    }

    if (!item) {
      return {
        ...result,
        configured: true,
        verified: null,
        message: data?.message || "No source metadata returned"
      };
    }

    return {
      ...result,
      configured: true,
      verified: Boolean(item.SourceCode),
      contractName: item.ContractName || "",
      compilerVersion: item.CompilerVersion || "",
      proxy: item.Proxy || "0",
      implementation: item.Implementation || ""
    };

  } catch (e) {
    return {
      status: e.status || "error",
      configured: true,
      httpStatus: e.httpStatus || null,
      message: e.message || "Explorer request failed"
    };
  }
}

function decodeErc20Text(hex) {
  if (!/^0x[0-9a-f]+$/i.test(hex || "")) return null;
  const data = hex.slice(2);
  if (data.length === 64) {
    const bytes = data.match(/.{2}/g).map(x => parseInt(x, 16));
    const text = new TextDecoder().decode(new Uint8Array(bytes)).replace(/\\0+$/g, "").trim();
    return text || null;
  }
  if (data.length < 128) return null;
  try {
    const offset = Number(BigInt("0x" + data.slice(0, 64))) * 2;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 64 > data.length) return null;
    const length = Number(BigInt("0x" + data.slice(offset, offset + 64)));
    if (!Number.isSafeInteger(length) || length < 0 || length > 1024) return null;
    const start = offset + 64;
    const end = start + length * 2;
    if (end > data.length) return null;
    const bytes = data.slice(start, end).match(/.{2}/g).map(x => parseInt(x, 16));
    const text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes))
      .replace(/\\0/g, "").trim();
    return text || null;
  } catch (_) {
    return null;
  }
}


function ankrBlockchainForChain(chainId) {
  const id = String(chainId);
  const chains = {
    "56": "bsc",
    "8453": "base"
  };
  return chains[id] || null;
}

async function ankrAdvancedCall(env, method, params) {
  const endpoint = String(env.BSC_RPC_URL || "").trim();

  if (!endpoint || !endpoint.includes("/multichain/")) {
    throw Object.assign(
      new Error("BSC_RPC_URL must contain the Ankr Advanced API Multichain endpoint"),
      { status: "unavailable" }
    );
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    }),
    signal: AbortSignal.timeout(20000)
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw Object.assign(
      new Error("Ankr returned invalid JSON"),
      {
        status: "unavailable",
        httpStatus: response.status
      }
    );
  }

  if (!response.ok || payload?.error) {
    const message =
      payload?.error?.message || `Ankr HTTP ${response.status}`;

    throw Object.assign(
      new Error(message),
      {
        status: classifyFailure(response.status, message),
        httpStatus: response.status
      }
    );
  }

  return payload?.result;
}

async function ankrEthCall(env, chainId, to, data) {
  const id = String(chainId);
  const endpoint = id === "8453"
    ? String(env.ANKR_BASE_RPC_URL || "").trim()
    : id === "56"
      ? String(env.ANKR_BSC_RPC_URL || "").trim()
      : "";

  if (!endpoint) {
    throw Object.assign(
      new Error(id === "8453"
        ? "ANKR_BASE_RPC_URL is not configured; set it to the Ankr Base Chain RPC endpoint"
        : id === "56"
          ? "ANKR_BSC_RPC_URL is not configured; set it to the Ankr BNB Chain RPC endpoint"
          : `Ankr Chain RPC does not support chainId ${id} in this configuration`),
      { status: "unavailable", failureType: "missing_chain_rpc_endpoint" }
    );
  }

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"]
      }),
      signal: AbortSignal.timeout(20000)
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw Object.assign(new Error("Ankr Chain RPC returned invalid JSON"), {
        status: "unavailable",
        httpStatus: response.status
      });
    }

    if (!response.ok || payload?.error) {
      const message = payload?.error?.message || `Ankr Chain RPC HTTP ${response.status}`;
      const failureStatus = classifyFailure(response.status, message);
      const error = Object.assign(new Error(message), {
        status: failureStatus,
        httpStatus: response.status,
        failureType: failureStatus
      });
      lastError = error;

      if (attempt === 0 && failureStatus === "rate_limited") {
        const retryAfter = Number(response.headers.get("retry-after") || 10);
        const waitMs = Math.min(Math.max(retryAfter * 1000, 1000), 15000);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      throw error;
    }

    const result = payload?.result;
    if (typeof result !== "string" || !/^0x[0-9a-f]*$/i.test(result)) {
      throw Object.assign(new Error("Ankr Chain RPC returned an invalid eth_call result"), {
        status: "error",
        httpStatus: response.status,
        failureType: "invalid_eth_call_result"
      });
    }
    return result;
  }

  throw lastError || Object.assign(new Error("Ankr Chain RPC request failed"), {
    status: "unavailable"
  });
}

// Compatibility wrappers for existing BNB Chain-only endpoints.
async function bscAdvancedCall(env, method, params) {
  return ankrAdvancedCall(env, method, params);
}

async function bscEthCall(env, to, data) {
  return ankrEthCall(env, "56", to, data);
}




const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

async function chainRpcRequest(env, chainId, method, params) {
  const id = String(chainId);

  if (id === "1") {
    if (!env.ETHERSCAN_API_KEY) {
      throw Object.assign(new Error("ETHERSCAN_API_KEY is not configured for Ethereum RPC reads"), {
        status: "unavailable",
        failureType: "missing_rpc_configuration"
      });
    }

    const query = new URLSearchParams({
      chainid: id,
      module: "proxy",
      action: method,
      apikey: env.ETHERSCAN_API_KEY
    });

    if (method === "eth_call") {
      query.set("to", params[0].to);
      query.set("data", params[0].data);
      query.set("tag", params[1] || "latest");
    } else if (method === "eth_getCode") {
      query.set("address", params[0]);
      query.set("tag", params[1] || "latest");
    } else if (method === "eth_getStorageAt") {
      query.set("address", params[0]);
      query.set("position", params[1]);
      query.set("tag", params[2] || "latest");
    } else {
      throw Object.assign(new Error("Unsupported Ethereum RPC method: " + method), {
        status: "error",
        failureType: "unsupported_rpc_method"
      });
    }

    const response = await fetchEtherscanJson(ETHERSCAN_API + "?" + query.toString());
    if (response?.result === undefined || response?.result === null) {
      throw Object.assign(new Error("Etherscan RPC response did not contain a result"), {
        status: "error",
        failureType: "missing_rpc_result"
      });
    }
    return response.result;
  }

  const endpoint = id === "8453"
    ? String(env.ANKR_BASE_RPC_URL || "").trim()
    : id === "56"
      ? String(env.ANKR_BSC_RPC_URL || "").trim()
      : "";

  if (!endpoint) {
    throw Object.assign(new Error("Ankr RPC endpoint is not configured for chainId " + id), {
      status: "unavailable",
      failureType: "missing_rpc_configuration"
    });
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    }),
    signal: AbortSignal.timeout(20000)
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error("Chain RPC returned invalid JSON"), {
      status: "unavailable",
      httpStatus: response.status
    });
  }

  if (!response.ok || payload?.error) {
    const message = payload?.error?.message || ("Chain RPC HTTP " + response.status);
    throw Object.assign(new Error(message), {
      status: classifyFailure(response.status, message),
      httpStatus: response.status
    });
  }

  if (payload?.result === undefined || payload?.result === null) {
    throw Object.assign(new Error("Chain RPC response did not contain a result"), {
      status: "error",
      httpStatus: response.status
    });
  }

  return payload.result;
}

function decodeWordAddress(raw) {
  if (!/^0x[0-9a-f]{64}$/i.test(raw || "")) return null;
  const address = "0x" + raw.slice(-40);
  return /^0x0{40}$/i.test(address) ? null : address;
}

function decodeWordUint(raw) {
  if (!/^0x[0-9a-f]{64}$/i.test(raw || "")) return null;
  try {
    return BigInt(raw).toString(10);
  } catch (_) {
    return null;
  }
}

function extractPushedSelectors(bytecode) {
  if (typeof bytecode !== "string" || !/^0x[0-9a-f]*$/i.test(bytecode)) {
    return [];
  }

  const hex = bytecode.slice(2).toLowerCase();
  const selectors = new Set();

  // Walk EVM instructions so PUSH4 data is not confused with embedded bytes
  // inside other PUSH instructions.
  for (let offset = 0; offset + 2 <= hex.length;) {
    const opcode = Number.parseInt(hex.slice(offset, offset + 2), 16);

    if (opcode >= 0x60 && opcode <= 0x7f) {
      const pushBytes = opcode - 0x5f;
      const dataStart = offset + 2;
      const dataEnd = dataStart + pushBytes * 2;
      if (dataEnd > hex.length) break;

      if (opcode === 0x63) {
        selectors.add(hex.slice(dataStart, dataEnd));
      }

      offset = dataEnd;
    } else {
      offset += 2;
    }
  }

  return [...selectors];
}

const ERC20_DISPATCH_SELECTORS = {
  "06fdde03": "name",
  "95d89b41": "symbol",
  "313ce567": "decimals",
  "18160ddd": "totalSupply",
  "70a08231": "balanceOf",
  "a9059cbb": "transfer",
  "dd62ed3e": "allowance",
  "095ea7b3": "approve",
  "23b872dd": "transferFrom"
};

async function scanContractOnChain(address, chainId, env, findings) {
  const call = async selector => {
    try {
      return await chainRpcRequest(
        env,
        chainId,
        "eth_call",
        [{ to: address, data: selector }, "latest"]
      );
    } catch (_) {
      return null;
    }
  };

  const storage = async slot => {
    try {
      return await chainRpcRequest(
        env,
        chainId,
        "eth_getStorageAt",
        [address, slot, "latest"]
      );
    } catch (_) {
      return null;
    }
  };

  try {
    const code = await chainRpcRequest(
      env,
      chainId,
      "eth_getCode",
      [address, "latest"]
    );

    if (typeof code !== "string" || !/^0x[0-9a-f]*$/i.test(code)) {
      throw Object.assign(new Error("RPC returned invalid contract bytecode"), {
        status: "error"
      });
    }

    const bytecodeBytes = Math.max(0, (code.length - 2) / 2);
    if (bytecodeBytes === 0) {
      addFinding(
        findings,
        "On-chain contract code",
        "The selected chain returned no deployed bytecode at this address. This may be an externally owned account, a wrong network, or a contract that no longer has code.",
        "warn",
        10
      );
      return {
        provider: "Direct chain RPC",
        status: "partial",
        incomplete: true,
        message: "RPC confirmed that no deployed bytecode exists at the target address; this is not a deployed contract.",
        bytecodeBytes: 0
      };
    }

    let codeHash = null;
    try {
      const bytecode = Uint8Array.from(
        code.slice(2).match(/.{2}/g).map(byte => parseInt(byte, 16))
      );
      const digest = await crypto.subtle.digest("SHA-256", bytecode);
      codeHash = Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
    } catch (_) {}

    addFinding(
      findings,
      "On-chain contract code",
      "Live RPC confirms deployed runtime bytecode. Bytecode size: " +
        bytecodeBytes +
        " bytes" +
        (codeHash ? "; SHA-256: " + codeHash : "") +
        ". A code hash identifies this bytecode snapshot; it is not a safety verdict.",
      "good",
      0
    );

    const targetSelectors = extractPushedSelectors(code);
    const targetErc20Selectors = targetSelectors
      .filter(selector => ERC20_DISPATCH_SELECTORS[selector])
      .map(selector => ERC20_DISPATCH_SELECTORS[selector]);

    const [nameRaw, symbolRaw, decimalsRaw, supplyRaw, ownerRaw, getOwnerRaw, pausedRaw,
      implementationRaw, adminRaw, beaconRaw] = await Promise.all([
      call("0x06fdde03"),
      call("0x95d89b41"),
      call("0x313ce567"),
      call("0x18160ddd"),
      call("0x8da5cb5b"),
      call("0x893d20e8"),
      call("0x5c975abb"),
      storage(EIP1967_IMPLEMENTATION_SLOT),
      storage(EIP1967_ADMIN_SLOT),
      storage(EIP1967_BEACON_SLOT)
    ]);

    const name = decodeErc20Text(nameRaw);
    const symbol = decodeErc20Text(symbolRaw);
    const decimals = decodeWordUint(decimalsRaw);
    const totalSupply = decodeWordUint(supplyRaw);
    const owner = decodeWordAddress(ownerRaw) || decodeWordAddress(getOwnerRaw);
    const paused = /^0x0{63}1$/i.test(pausedRaw || "")
      ? true
      : /^0x0{64}$/i.test(pausedRaw || "")
        ? false
        : null;

    if (name || symbol || decimals !== null || totalSupply !== null) {
      addFinding(
        findings,
        "On-chain token metadata",
        "Live contract calls returned " +
          [name ? "name: " + name : null,
           symbol ? "symbol: " + symbol : null,
           decimals !== null ? "decimals: " + decimals : null,
           totalSupply !== null ? "raw totalSupply: " + totalSupply : null]
            .filter(Boolean).join("; ") +
          ". These are contract-reported values and may be non-standard.",
        "good",
        0
      );
    } else {
      addFinding(
        findings,
        "ERC-20 interface checks",
        "The common ERC-20 metadata and supply calls did not return decodable values. This address may not be an ERC-20 token, or it may use a non-standard interface.",
        "neutral",
        0
      );
    }

    if (owner) {
      addFinding(
        findings,
        "On-chain owner control",
        "The contract returned owner address " + owner +
          ". An active owner can represent privileged control; inspect its permissions and whether ownership is renounced or governed by a multisig/timelock.",
        "warn",
        5
      );
    }

    if (paused === true) {
      addFinding(
        findings,
        "Contract pause state",
        "The contract's paused() call currently returns true.",
        "warn",
        12
      );
    } else if (paused === false) {
      addFinding(
        findings,
        "Contract pause state",
        "The contract's paused() call currently returns false. This does not prove that transfers cannot be restricted through other mechanisms.",
        "good",
        0
      );
    }

    const implementation = decodeWordAddress(implementationRaw);
    const admin = decodeWordAddress(adminRaw);
    const beacon = decodeWordAddress(beaconRaw);

    // EIP-1167 minimal clones embed their fixed implementation address in runtime code.
    const cloneMatch = code.match(
      /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i
    );
    const cloneImplementation = cloneMatch
      ? "0x" + cloneMatch[1]
      : null;

    // EIP-1967 beacon proxies expose implementation() on the beacon contract.
    let beaconImplementation = null;
    if (beacon) {
      try {
        const beaconRaw = await chainRpcRequest(
          env,
          chainId,
          "eth_call",
          [{ to: beacon, data: "0x5c60da1b" }, "latest"]
        );
        beaconImplementation = decodeWordAddress(beaconRaw);
      } catch (_) {}
    }

    const resolvedImplementation =
      implementation || beaconImplementation || cloneImplementation;
    let implementationCodeBytes = null;
    let implementationHasCode = null;
    let implementationErc20Selectors = [];
    let uupsProxiableUUID = null;

    if (resolvedImplementation) {
      try {
        const implementationCode = await chainRpcRequest(
          env,
          chainId,
          "eth_getCode",
          [resolvedImplementation, "latest"]
        );
        if (typeof implementationCode === "string" &&
            /^0x[0-9a-f]*$/i.test(implementationCode)) {
          implementationCodeBytes = Math.max(0, (implementationCode.length - 2) / 2);
          implementationHasCode = implementationCodeBytes > 0;
          implementationErc20Selectors = extractPushedSelectors(implementationCode)
            .filter(selector => ERC20_DISPATCH_SELECTORS[selector])
            .map(selector => ERC20_DISPATCH_SELECTORS[selector]);
        }
      } catch (_) {}

      // EIP-1822/UUPS implementations commonly expose proxiableUUID().
      try {
        const uuidRaw = await chainRpcRequest(
          env,
          chainId,
          "eth_call",
          [{ to: resolvedImplementation, data: "0x52d1902d" }, "latest"]
        );
        uupsProxiableUUID = /^0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc$/i.test(uuidRaw || "");
      } catch (_) {}
    }

    const allErc20Selectors = [...new Set([
      ...targetErc20Selectors,
      ...implementationErc20Selectors
    ])];

    addFinding(
      findings,
      "Contract bytecode interface fingerprint",
      allErc20Selectors.length >= 3
        ? `Runtime bytecode exposes ${allErc20Selectors.length} common ERC-20 dispatch selectors (${allErc20Selectors.join(", ")}). Selector presence is a heuristic and does not prove standard-compliant behavior.`
        : `Only ${allErc20Selectors.length} common ERC-20 dispatch selector(s) were detected. No standard ERC-20 metadata was decoded; this may be a non-token contract, a custom dispatcher, or a proxy whose implementation needs separate inspection.`,
      "neutral",
      0
    );

    const proxyType = implementation
      ? "eip1967"
      : beacon
        ? "eip1967_beacon"
        : cloneImplementation
          ? "eip1167_minimal_clone"
          : "not_detected";

    if (implementation) {
      addFinding(
        findings,
        "EIP-1967 proxy implementation",
        "Live storage read identifies implementation " + implementation +
          ". Proxy logic and implementation permissions must be reviewed separately.",
        "warn",
        8
      );
    }
    if (admin) {
      addFinding(
        findings,
        "EIP-1967 proxy administrator",
        "Live storage read identifies proxy administrator " + admin +
          ". This address may have upgrade control depending on the proxy implementation.",
        "warn",
        5
      );
    }
    if (beacon) {
      addFinding(
        findings,
        "EIP-1967 beacon",
        "Live storage read identifies beacon contract " + beacon +
          (beaconImplementation ? "; its implementation() call returned " + beaconImplementation : "; implementation() could not be resolved") +
          ". The beacon's upgrade authority requires separate review.",
        "warn",
        5
      );
    }
    if (cloneImplementation) {
      addFinding(
        findings,
        "EIP-1167 minimal proxy",
        "Runtime bytecode begins with the standard EIP-1167 minimal-clone delegatecall sequence and embeds fixed implementation " +
          cloneImplementation + ". Trailing bytes may contain immutable clone data; this is a bytecode-pattern heuristic, and the implementation still requires review.",
        "warn",
        5
      );
    }
    if (resolvedImplementation && implementationHasCode === false) {
      addFinding(
        findings,
        "Proxy implementation code missing",
        "The resolved implementation address " + resolvedImplementation +
          " returned no runtime bytecode. Proxy behavior may be broken or the implementation reference may be invalid.",
        "warn",
        12
      );
    }
    if (uupsProxiableUUID === true) {
      addFinding(
        findings,
        "UUPS upgrade interface",
        "The resolved implementation returned the EIP-1967 implementation slot from proxiableUUID(), indicating a UUPS-compatible upgrade interface. Upgrade authorization must be reviewed.",
        "warn",
        8
      );
    }

    return {
      provider: "Direct chain RPC",
      status: "success",
      incomplete: false,
      message: "Live bytecode, token-interface, proxy implementation and upgrade-interface checks completed where supported.",
      bytecodeBytes,
      bytecodeSha256: codeHash,
      tokenMetadata: {
        name: name || null,
        symbol: symbol || null,
        decimals: decimals,
        totalSupplyRaw: totalSupply
      },
      owner: owner,
      paused: paused,
      proxy: {
        type: proxyType,
        implementation: resolvedImplementation,
        eip1967Implementation: implementation,
        cloneImplementation: cloneImplementation,
        admin: admin,
        beacon: beacon,
        beaconImplementation: beaconImplementation,
        implementationCodeBytes: implementationCodeBytes,
        implementationHasCode: implementationHasCode,
        uupsProxiableUUID: uupsProxiableUUID
      },
      interfaceFingerprint: {
        erc20Selectors: allErc20Selectors,
        targetSelectorCount: targetSelectors.length,
        implementationSelectorCount: implementationErc20Selectors.length
      }
    };
  } catch (error) {
    addFinding(
      findings,
      "On-chain contract scan unavailable",
      String(error?.message || "Direct chain RPC check failed").slice(0, 240),
      "neutral",
      0
    );
    return {
      provider: "Direct chain RPC",
      status: error?.status || "error",
      incomplete: true,
      httpStatus: error?.httpStatus || null,
      message: String(error?.message || "Direct chain RPC check failed").slice(0, 240),
      failureType: error?.failureType || null
    };
  }
}

async function readErc20Metadata(token, chainId, env) {
  const id = String(chainId);
  const key = `${id}:${token.toLowerCase()}`;
  const cached = TOKEN_METADATA_CACHE.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const useAnkr = Boolean(ankrBlockchainForChain(id));
  const result = {
    name: null,
    symbol: null,
    metadataStatus: "partial"
  };

  for (const [field, selector] of [
    ["name", "0x06fdde03"],
    ["symbol", "0x95d89b41"]
  ]) {
    try {
      let raw;

      if (useAnkr) {
        raw = await ankrEthCall(env, id, token, selector);
      } else {
        const params = new URLSearchParams({
          chainid: id,
          module: "proxy",
          action: "eth_call",
          to: token,
          data: selector,
          tag: "latest",
          apikey: env.ETHERSCAN_API_KEY
        });

        const response = await fetchEtherscanJson(
          `${ETHERSCAN_API}?${params.toString()}`
        );
        raw = response.result;
      }

      result[field] = decodeErc20Text(raw);
    } catch (_) {
      result[field] = null;
    }
  }

  result.metadataStatus =
    result.name || result.symbol ? "success" : "unavailable";

  TOKEN_METADATA_CACHE.set(key, {
    value: result,
    expires: Date.now() + TOKEN_METADATA_CACHE_TTL
  });

  return result;
}

function spenderIdentity(address) {
  const key = String(address || "").toLowerCase();
  const known = KNOWN_SPENDERS[key];

  return known
    ? {
        spenderName: known.name,
        spenderCategory: known.category,
        spenderIdentity: known.identity
      }
    : {
        spenderName: null,
        spenderCategory: "Unknown contract",
        spenderIdentity: "unknown"
      };
}

async function readErc20Allowance(token, owner, spender, chainId, env) {
  const id = String(chainId);
  const useAnkr = Boolean(ankrBlockchainForChain(id));

  const chainRpcConfigured = id === "8453"
    ? Boolean(env.ANKR_BASE_RPC_URL)
    : id === "56"
      ? Boolean(env.ANKR_BSC_RPC_URL)
      : false;

  if (useAnkr ? !chainRpcConfigured : !env.ETHERSCAN_API_KEY) {
    return {
      status: "unavailable",
      failureType: useAnkr ? "missing_chain_rpc_endpoint" : "missing_api_key",
      message: useAnkr
        ? (id === "8453"
            ? "ANKR_BASE_RPC_URL is not configured"
            : "ANKR_BSC_RPC_URL is not configured")
        : "ETHERSCAN_API_KEY is not configured"
    };
  }

  if (
    !ADDRESS_RE.test(token || "") ||
    !ADDRESS_RE.test(owner || "") ||
    !ADDRESS_RE.test(spender || "")
  ) {
    return {
      status: "error",
      failureType: "invalid_address",
      message: "Invalid token, owner or spender address"
    };
  }

  const padAddress = value =>
    value.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  const allowanceData =
    "0xdd62ed3e" + padAddress(owner) + padAddress(spender);

  const baseParams = {
    chainid: id,
    module: "proxy",
    action: "eth_call",
    to: token,
    tag: "latest",
    apikey: env.ETHERSCAN_API_KEY
  };

  try {
    let allowanceResult;

    try {
      if (useAnkr) {
        allowanceResult = {
          result: await ankrEthCall(env, id, token, allowanceData)
        };
      } else {
        const params = new URLSearchParams({
          ...baseParams,
          data: allowanceData
        });

        allowanceResult = await fetchEtherscanJson(
          `${ETHERSCAN_API}?${params.toString()}`
        );
      }
    } catch (error) {
      return {
        status: error.status || "error",
        failureType: error.status || "allowance_request_error",
        httpStatus: error.httpStatus || null,
        message: error.message || "Allowance request failed"
      };
    }

    if (!/^0x[0-9a-f]+$/i.test(allowanceResult.result || "")) {
      return {
        status: "unavailable",
        failureType: "invalid_allowance_response",
        message: String(
          allowanceResult.message ||
          allowanceResult.result ||
          "Provider returned no valid allowance hex value"
        ).slice(0, 300)
      };
    }

    const raw = BigInt(allowanceResult.result);
    const active = raw > 0n;
    const maxUint256 = (1n << 256n) - 1n;

    const unlimited =
      raw > 0n &&
      raw * 100000000n >= maxUint256 * 99999999n;

    if (!active) {
      return {
        status: "success",
        rawAllowance: raw.toString(),
        decimals: null,
        allowance: "0",
        unlimited: false,
        active: false,
        checkedAt: new Date().toISOString()
      };
    }

    let decimals = null;
    let formattedAllowance = null;
    let decimalsError = null;

    const tokenKey = `${id}:${token.toLowerCase()}`;
    const cachedDecimals = DECIMALS_CACHE.get(tokenKey);

    if (cachedDecimals && cachedDecimals.expires > Date.now()) {
      decimals = cachedDecimals.value;
    } else {
      try {
        let decimalsResult;

        if (useAnkr) {
          decimalsResult = {
            result: await ankrEthCall(env, id, token, "0x313ce567")
          };
        } else {
          const params = new URLSearchParams({
            ...baseParams,
            data: "0x313ce567"
          });

          decimalsResult = await fetchEtherscanJson(
            `${ETHERSCAN_API}?${params.toString()}`
          );
        }

        if (/^0x[0-9a-f]+$/i.test(decimalsResult.result || "")) {
          const parsed = Number(BigInt(decimalsResult.result));

          if (
            Number.isInteger(parsed) &&
            parsed >= 0 &&
            parsed <= 36
          ) {
            decimals = parsed;

            DECIMALS_CACHE.set(tokenKey, {
              value: decimals,
              expires: Date.now() + DECIMALS_CACHE_TTL
            });
          } else {
            decimalsError = "Invalid decimals value";
          }
        } else {
          decimalsError = String(
            decimalsResult.result ||
            decimalsResult.message ||
            "Invalid decimals response"
          ).slice(0, 200);
        }
      } catch (error) {
        decimalsError = String(
          error.message || "Decimals request failed"
        ).slice(0, 200);
      }
    }

    if (decimals !== null) {
      const divisor = 10n ** BigInt(decimals);
      const whole = raw / divisor;

      const fraction = (raw % divisor)
        .toString()
        .padStart(decimals, "0")
        .replace(/0+$/, "");

      formattedAllowance = fraction
        ? `${whole}.${fraction}`
        : whole.toString();
    }

    return {
      status: "success",
      rawAllowance: raw.toString(),
      decimals,
      allowance: formattedAllowance,
      unlimited,
      active,
      checkedAt: new Date().toISOString(),
      decimalsError,
      formattingComplete: decimals !== null,
      metadata: await readErc20Metadata(token, id, env)
    };
  } catch (error) {
    return {
      status: error.status || "error",
      failureType: error.status || "allowance_unknown_error",
      httpStatus: error.httpStatus || null,
      message: String(
        error.message || "Allowance request failed"
      ).slice(0, 300)
    };
  }
}

function blockNumberToBigInt(value) {
  try {
    if (typeof value === "bigint") return value;

    const text = String(value || "0");

    if (/^0x[0-9a-f]+$/i.test(text)) return BigInt(text);
    if (/^\d+$/.test(text)) return BigInt(text);

    return 0n;
  } catch (_) {
    return 0n;
  }
}

async function discoverErc20Approvals(owner, chainId, env) {
  const id = String(chainId);
  const blockchain = ankrBlockchainForChain(id);

  if (blockchain) {
    try {
      const ownerTopic =
        "0x" + owner.slice(2).toLowerCase().padStart(64, "0");

      const PAGE_SIZE = 10000;
      const MAX_LOG_PAGES = 20;
      const logs = [];

      let pageToken = null;
      let logLimitReached = false;
      let pagesFetched = 0;
      let nextPageTokenSeen = false;
      let rawLogCount = 0;

      for (let page = 0; page < MAX_LOG_PAGES; page++) {
        const params = {
          blockchain: [blockchain],
          fromBlock: "earliest",
          toBlock: "latest",
          topics: [[APPROVAL_TOPIC], [ownerTopic]],
          pageSize: PAGE_SIZE,
          descOrder: true
        };

        if (pageToken) params.pageToken = pageToken;

        const result = await ankrAdvancedCall(
          env,
          "ankr_getLogs",
          params
        );

        pagesFetched += 1;

        const pageLogs = Array.isArray(result?.logs)
          ? result.logs
          : [];

        rawLogCount += pageLogs.length;
        logs.push(...pageLogs);

        pageToken = result?.nextPageToken || null;

        if (pageToken) nextPageTokenSeen = true;
        if (!pageToken) break;

        if (page === MAX_LOG_PAGES - 1) {
          logLimitReached = true;
        }
      }

      const candidates = new Map();

      for (const log of logs) {
        const topics = log?.topics || [];

        if (
          topics.length < 3 ||
          String(topics[0] || "").toLowerCase() !==
            APPROVAL_TOPIC.toLowerCase() ||
          String(topics[1] || "").toLowerCase() !==
            ownerTopic.toLowerCase() ||
          !ADDRESS_RE.test(log.address || "")
        ) {
          continue;
        }

        const spender = "0x" + String(topics[2]).slice(-40);
        if (!ADDRESS_RE.test(spender)) continue;

        const key =
          `${log.address.toLowerCase()}:${spender.toLowerCase()}`;

        const previous = candidates.get(key);

        if (
          !previous ||
          blockNumberToBigInt(log.blockNumber) >
            blockNumberToBigInt(previous.lastSeenBlock)
        ) {
          candidates.set(key, {
            tokenAddress: log.address,
            spender,
            lastSeenBlock: log.blockNumber || "0x0",
            lastTransactionHash: log.transactionHash || null
          });
        }
      }

      const all = [...candidates.values()].sort((a, b) => {
        const blockA = blockNumberToBigInt(a.lastSeenBlock);
        const blockB = blockNumberToBigInt(b.lastSeenBlock);

        return blockA === blockB ? 0 : blockA > blockB ? -1 : 1;
      });

      const selected = all.slice(0, 150);
      const candidateLimitReached = all.length > 150;
      const incomplete = logLimitReached || candidateLimitReached;

      return {
        status: "success",
        message: logLimitReached
          ? `Ankr ${blockchain} Approval history reached the 20-page safety limit; results may be incomplete.`
          : candidateLimitReached
            ? "Approval records were found; the display is limited to the newest 150 candidates."
            : all.length
              ? `Ankr ${blockchain} Approval history scan completed; matching records were found.`
              : `Ankr ${blockchain} Approval history scan completed; no matching Approval logs were found for this wallet.`,
        candidates: selected,
        candidateCount: all.length,
        logCount: logs.length,
        rawLogCount,
        pagesFetched,
        nextPageTokenSeen,
        logLimitReached,
        candidateLimitReached,
        incomplete,
        latestBlock: null,
        pageToken: logLimitReached ? pageToken : null
      };
    } catch (error) {
      return {
        status: error.status || "error",
        message: String(
          error.message || "Ankr Approval log query failed"
        ).slice(0, 300),
        candidates: [],
        candidateCount: 0,
        logCount: 0,
        rawLogCount: 0,
        pagesFetched: 0,
        nextPageTokenSeen: false,
        logLimitReached: false,
        candidateLimitReached: false,
        incomplete: true
      };
    }
  }

  if (!env.ETHERSCAN_API_KEY) {
    return {
      status: "unavailable",
      message: "ETHERSCAN_API_KEY is missing",
      candidates: [],
      candidateCount: 0,
      logCount: 0,
      logLimitReached: false,
      candidateLimitReached: false,
      incomplete: true
    };
  }

  const ownerTopic =
    "0x" + owner.slice(2).toLowerCase().padStart(64, "0");

  try {
    const blockUrl = new URL(ETHERSCAN_API);

    blockUrl.search = new URLSearchParams({
      chainid: id,
      module: "proxy",
      action: "eth_blockNumber",
      apikey: env.ETHERSCAN_API_KEY
    });

    const blockData = await fetchEtherscanJson(blockUrl.toString());

    if (!/^0x[0-9a-f]+$/i.test(blockData.result || "")) {
      throw new Error(
        blockData.message ||
        blockData.result ||
        "Could not retrieve latest block"
      );
    }

    const latestBlock = parseInt(blockData.result, 16);
    const PAGE_SIZE = 1000;
    const MAX_LOG_PAGES = 5;
    const logs = [];

    let logLimitReached = false;

    for (let page = 1; page <= MAX_LOG_PAGES; page++) {
      const logsUrl = new URL(ETHERSCAN_API);

      logsUrl.search = new URLSearchParams({
        chainid: id,
        module: "logs",
        action: "getLogs",
        fromBlock: "0",
        toBlock: String(latestBlock),
        topic0: APPROVAL_TOPIC,
        topic0_1_opr: "and",
        topic1: ownerTopic,
        page: String(page),
        offset: String(PAGE_SIZE),
        apikey: env.ETHERSCAN_API_KEY
      });

      const logsData = await fetchEtherscanJson(
        logsUrl.toString(),
        20000
      );

      if (
        String(logsData.status) === "0" &&
        !Array.isArray(logsData.result)
      ) {
        const message = String(
          logsData.result || logsData.message || ""
        );

        if (/no records found/i.test(message)) break;

        throw new Error(message || "Approval log query failed");
      }

      const pageLogs = Array.isArray(logsData.result)
        ? logsData.result
        : [];

      logs.push(...pageLogs);

      if (pageLogs.length < PAGE_SIZE) break;
      if (page === MAX_LOG_PAGES) logLimitReached = true;
    }

    const candidates = new Map();

    for (const log of logs) {
      const topics = log?.topics || [];

      if (
        topics.length < 3 ||
        String(topics[1] || "").toLowerCase() !==
          ownerTopic.toLowerCase() ||
        !ADDRESS_RE.test(log.address || "")
      ) {
        continue;
      }

      const spender = "0x" + topics[2].slice(-40);
      if (!ADDRESS_RE.test(spender)) continue;

      const tokenAddress = log.address.toLowerCase();
      const spenderAddress = spender.toLowerCase();
      const key = `${tokenAddress}:${spenderAddress}`;
      const blockNumber = log.blockNumber || "0x0";

      if (!candidates.has(key)) {
        candidates.set(key, {
          tokenAddress: log.address,
          spender,
          lastSeenBlock: blockNumber,
          lastTransactionHash: log.transactionHash || null
        });
      } else {
        const previous = candidates.get(key);

        if (
          blockNumberToBigInt(blockNumber) >
          blockNumberToBigInt(previous.lastSeenBlock)
        ) {
          previous.lastSeenBlock = blockNumber;
          previous.lastTransactionHash =
            log.transactionHash || null;
        }
      }
    }

    const allCandidates = [...candidates.values()];

    allCandidates.sort((a, b) => {
      const blockA = blockNumberToBigInt(a.lastSeenBlock);
      const blockB = blockNumberToBigInt(b.lastSeenBlock);

      if (blockA === blockB) return 0;
      return blockA > blockB ? -1 : 1;
    });

    const MAX_CANDIDATES = 150;
    const selected = allCandidates.slice(0, MAX_CANDIDATES);
    const candidateLimitReached =
      allCandidates.length > MAX_CANDIDATES;

    return {
      status: "success",
      message: "Approval logs discovered; current allowances will be checked in separate batches",
      candidates: selected,
      candidateCount: allCandidates.length,
      logCount: logs.length,
      logLimitReached,
      candidateLimitReached,
      incomplete: logLimitReached || candidateLimitReached,
      latestBlock
    };
  } catch (error) {
    return {
      status: error.status || "error",
      message: String(
        error.message || "On-chain approval discovery failed"
      ).slice(0, 300),
      candidates: [],
      candidateCount: 0,
      logCount: 0,
      logLimitReached: false,
      candidateLimitReached: false,
      incomplete: true
    };
  }
}


async function handleApprovalLogBatch(body, env) {
  const chainId = String(body?.chainId || "");
  const blockchain = ankrBlockchainForChain(chainId);
  const owner = String(body?.address || "").trim();
  const pageToken = String(body?.pageToken || "");

  if (
    !blockchain ||
    !ADDRESS_RE.test(owner) ||
    !pageToken ||
    pageToken.length > 4096
  ) {
    return json({
      error: "Invalid chain, wallet address or Ankr page token."
    }, 400);
  }

  try {
    const ownerTopic =
      "0x" + owner.slice(2).toLowerCase().padStart(64, "0");

    const result = await ankrAdvancedCall(
      env,
      "ankr_getLogs",
      {
        blockchain: [blockchain],
        fromBlock: "earliest",
        toBlock: "latest",
        topics: [[APPROVAL_TOPIC], [ownerTopic]],
        pageSize: 10000,
        pageToken,
        descOrder: true
      }
    );

    const logs = Array.isArray(result?.logs) ? result.logs : [];
    const candidates = new Map();

    for (const log of logs) {
      const topics = log?.topics || [];

      if (
        topics.length < 3 ||
        String(topics[1] || "").toLowerCase() !== ownerTopic ||
        !ADDRESS_RE.test(log.address || "")
      ) {
        continue;
      }

      const spender = "0x" + String(topics[2]).slice(-40);

      if (!ADDRESS_RE.test(spender)) continue;

      const key =
        `${log.address.toLowerCase()}:${spender.toLowerCase()}`;

      const previous = candidates.get(key);

      if (
        !previous ||
        blockNumberToBigInt(log.blockNumber) >
          blockNumberToBigInt(previous.lastSeenBlock)
      ) {
        candidates.set(key, {
          tokenAddress: log.address,
          spender,
          lastSeenBlock: log.blockNumber || "0x0",
          lastTransactionHash: log.transactionHash || null
        });
      }
    }

    return json({
      status: "success",
      chainId,
      blockchain,
      candidates: [...candidates.values()],
      logCount: logs.length,
      pageToken: result?.nextPageToken || null,
      done: !result?.nextPageToken
    });

  } catch (error) {
    return json({
      status: error.status || "error",
      error: String(
        error.message || "Ankr log pagination failed"
      ).slice(0, 300)
    }, 502);
  }
}









async function handleAllowanceBatch(body, env) {
  const chainId = String(body?.chainId || "");
  const owner = String(body?.address || "").trim();
  const candidates = body?.candidates;
  const cursor = Number(body?.cursor);

  if (!CHAINS[chainId] || !ADDRESS_RE.test(owner)) {
    return json({ error: "Invalid chain or wallet address for allowance batch." }, 400);
  }

  if (!Array.isArray(candidates) || candidates.length > 150) {
    return json({ error: "Invalid candidate list." }, 400);
  }

  if (!Number.isInteger(cursor) || cursor < 0 || cursor > candidates.length) {
    return json({ error: "Invalid allowance batch cursor." }, 400);
  }

  const BATCH_SIZE = 3;
  const slice = candidates.slice(cursor, cursor + BATCH_SIZE);
  const approvals = [];
  const failureStats = {};
  const failureSamples = [];

  let checkedCount = 0;
  let failedCount = 0;
  let formattingIncompleteCount = 0;

  const discoverySource =
    ankrBlockchainForChain(chainId)
      ? "Ankr Advanced API Approval logs"
      : "Etherscan Approval logs";

  for (const candidate of slice) {
    if (
      !ADDRESS_RE.test(String(candidate?.tokenAddress || "")) ||
      !ADDRESS_RE.test(String(candidate?.spender || ""))
    ) {
      failedCount++;
      failureStats.invalid_candidate =
        (failureStats.invalid_candidate || 0) + 1;

      if (failureSamples.length < 5) {
        failureSamples.push({
          type: "invalid_candidate",
          message: "Candidate token or spender address is invalid"
        });
      }

      continue;
    }

    let result;

    try {
      result = await readErc20Allowance(
        candidate.tokenAddress,
        owner,
        candidate.spender,
        chainId,
        env
      );
    } catch (error) {
      result = {
        status: "error",
        failureType: "unexpected_allowance_error",
        message: error?.message || "Unexpected allowance error"
      };
    }

    if (result.status !== "success") {
      failedCount++;

      const type = result.failureType || result.status || "unknown";
      failureStats[type] = (failureStats[type] || 0) + 1;

      const unresolvedIdentity = spenderIdentity(candidate.spender);
      approvals.push({
        standard: "ERC-20",
        tokenAddress: candidate.tokenAddress,
        tokenName: null,
        tokenSymbol: null,
        spender: candidate.spender,
        ...unresolvedIdentity,
        allowance: null,
        rawCurrentAllowance: null,
        tokenDecimals: null,
        unlimited: null,
        currentlyActive: null,
        currentAllowanceStatus: "failed",
        currentAllowanceFailure: type,
        currentAllowanceMessage: String(result.message || "Current allowance could not be read").slice(0, 220),
        lastSeenBlock: candidate.lastSeenBlock,
        lastTransactionHash: candidate.lastTransactionHash,
        discoverySource
      });

      if (failureSamples.length < 5) {
        failureSamples.push({
          type,
          status: result.status || "error",
          httpStatus: result.httpStatus ?? null,
          message: String(result.message || "").slice(0, 220),
          token: candidate.tokenAddress,
          spender: candidate.spender
        });
      }

      continue;
    }

    checkedCount++;

    if (result.decimalsError) {
      formattingIncompleteCount++;
    }

    if (!result.active) continue;

    const raw = BigInt(result.rawAllowance);
    const maxUint256 = (1n << 256n) - 1n;

    const unlimited =
      raw > 0n &&
      raw * 100000000n >= maxUint256 * 99999999n;

    const tokenMetadata = result.metadata || {
      name: null,
      symbol: null,
      metadataStatus: "unavailable"
    };

    approvals.push({
      standard: "ERC-20",
      tokenAddress: candidate.tokenAddress,
      tokenName: tokenMetadata.name || null,
      tokenSymbol: tokenMetadata.symbol || null,
      tokenMetadataStatus: tokenMetadata.metadataStatus || "unavailable",
      spender: candidate.spender,
      ...spenderIdentity(candidate.spender),
      allowance: result.allowance,
      rawCurrentAllowance: result.rawAllowance,
      tokenDecimals: result.decimals,
      unlimited,
      currentlyActive: true,
      currentAllowanceStatus: "success",
      currentAllowanceCheckedAt: result.checkedAt,
      decimalsError: result.decimalsError || null,
      formattingComplete: result.decimals !== null,
      discoverySource,
      lastSeenBlock: candidate.lastSeenBlock,
      lastTransactionHash: candidate.lastTransactionHash
    });
  }

  const nextCursor = cursor + slice.length;

  return json({
    status: "success",
    approvals,
    cursor,
    nextCursor,
    processedCount: slice.length,
    checkedCount,
    failedCount,
    formattingIncompleteCount,
    failureStats,
    failureSamples,
    done: nextCursor >= candidates.length
  });
}


async function handleScan(request, env) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body?.phase === "approval_log_batch") return handleApprovalLogBatch(body, env);

  if (body?.phase === "allowance_batch") {
    return handleAllowanceBatch(body, env);
  }

  const mode = body?.mode;
  const chainId = String(body?.chainId || "");
  const address = String(body?.address || "").trim();

  if (!CHAINS[chainId]) {
    return json({
      error: "Unsupported network. Choose Ethereum, BNB Chain or Base."
    }, 400);
  }

  if (!ADDRESS_RE.test(address)) {
    return json({ error: "Invalid EVM address format." }, 400);
  }

  if (!["wallet", "contract"].includes(mode)) {
    return json({ error: "Invalid scan mode." }, 400);
  }

  const findings = [];
  const approvals = [];
  const providers = {};
  const sources = [];
  const jobs = [];

  const runGoPlus = async (key, url, onSuccess, providerOptions = {}) => {
    try {
      const result = await cachedProviderGet("goplus", url, env, providerOptions);

      providers[key] = providerStatus("GoPlus", result);
      sources.push(`GoPlus ${key}`);

      const raw = result.data;
      const data = raw?.result ?? raw?.data ?? raw;

      providers[key].diagnostic = {
        code: raw?.code ?? null,
        message: raw?.message ?? raw?.msg ?? null,
        resultType: Array.isArray(data) ? "array" : typeof data,
        arrayLength: Array.isArray(data) ? data.length : null,
        resultKeys:
          data && typeof data === "object" && !Array.isArray(data)
            ? Object.keys(data).slice(0, 20)
            : [],
        parsedRecordCount: collectRecordObjects(data).length
      };

      await onSuccess(result.data);

    } catch (e) {
      providers[key] = {
        provider: "GoPlus",
        status: e.status || "error",
        httpStatus: e.httpStatus || null,
        message: e.retryAfterSeconds
          ? `${e.message || "Provider rate limited"} (retry after approximately ${e.retryAfterSeconds}s)`
          : (e.message || "Provider request failed"),
        retryAfterSeconds: e.retryAfterSeconds || null,
        cache: "none"
      };

      addFinding(
        findings,        `${key} unavailable`,
        `${providers[key].status}: ${providers[key].message}`,
        "neutral",
        0      );
    }
  };

  if (mode === "wallet") {
    jobs.push(
      runGoPlus(
        "address_security",
        `${GOPLUS_API}/api/v1/address_security/${address}?chain_id=${chainId}`,
        data => summarizeAddressRisk(data, findings)
      )
    );

    const approvalEndpoints = chainId === "8453"
      ? [["token_approval_security", "ERC-20"]]
      : [
          ["token_approval_security", "ERC-20"],
          ["nft721_approval_security", "ERC-721"],
          ["nft1155_approval_security", "ERC-1155"]
        ];

    if (chainId === "8453") {
      for (const endpoint of ["nft721_approval_security", "nft1155_approval_security"]) {
        providers[endpoint] = {
          provider: "GoPlus",
          status: "not_applicable",
          httpStatus: null,
          message: "GoPlus does not provide this NFT approval endpoint for Base; skipped by design.",
          cache: "none"
        };
        addFinding(
          findings,
          `${endpoint} not applicable`,
          "This GoPlus endpoint does not support Base. It was skipped and is not treated as a successful safety check.",
          "neutral",
          0
        );
      }
    }

    for (const [endpoint, standard] of approvalEndpoints) {
      jobs.push(
        runGoPlus(
          endpoint,
          `${GOPLUS_API}/api/v2/${endpoint}/${chainId}?addresses=${address}`,
          data => {
            const records = normalizeApprovals(data, standard);
            approvals.push(...records);
            approvalFinding(standard, records, findings);
          }
        )
      );
    }

  } else {
    jobs.push((async () => {
      providers.onchain_contract = await scanContractOnChain(
        address,
        chainId,
        env,
        findings
      );
      if (providers.onchain_contract.status === "success") {
        sources.push("Direct chain RPC contract inspection");
      }
    })());

    jobs.push(
      runGoPlus(
        "token_security",
        `${GOPLUS_API}/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
        data => summarizeTokenRisk(data, findings),
        { ttl: 300, rateLimitScope: "token_security" }
      )
    );

    jobs.push((async () => {
      const meta = await getEtherscanSource(address, chainId, env);

      providers.etherscan = {
        provider: "Etherscan API V2",
        status: meta.status || "success",
        httpStatus: meta.httpStatus || null,
        message: meta.message || "",
        cache: meta.cache || "none"
      };

      if (!meta.configured) {
        addFinding(
          findings,
          "Explorer source metadata",
          "Not configured. Add ETHERSCAN_API_KEY as a Worker secret to retrieve verified-source metadata.",
          "neutral",
          0
        );

      } else if (meta.verified === true) {
        addFinding(
          findings,
          "Verified source metadata",
          `Explorer reports verified source${meta.contractName ? ` for ${meta.contractName}` : ""}. This is not a security audit. Proxy: ${meta.proxy === "1" ? "yes" : "no"}${meta.implementation ? `; implementation: ${meta.implementation}` : ""}.`,
          "good",
          0
        );

      } else if (meta.verified === false) {
        addFinding(
          findings,
          "Source verification",
          "Explorer did not return verified source code for this address.",
          "warn",
          15
        );

      } else {
        addFinding(
          findings,
          "Explorer source metadata",
          meta.message || "No metadata returned.",
          "neutral",
          0
        );
      }

      if (meta.configured && meta.status === "success") {
        sources.push("Etherscan API V2");
      }
    })());
  }

  await Promise.all(jobs);

  let scanSession = null;

  if (mode === "wallet") {
    const discovery = await discoverErc20Approvals(address, chainId, env);

    providers.erc20_onchain_discovery = {
      provider: ankrBlockchainForChain(chainId) ? "Ankr Advanced API" : "Etherscan API V2",
      status: discovery.status === "success"
        ? (discovery.candidateCount > 0 ? "pending" : "success")
        : discovery.status,
      message: discovery.message,
      candidateCount: discovery.candidateCount,
      checkedCount: 0,
      failedCount: 0,
      formattingIncompleteCount: 0,
      failureStats: {},
      failureSamples: [],
      logCount: discovery.logCount ?? null,
      rawLogCount: discovery.rawLogCount ?? null,
      pagesFetched: discovery.pagesFetched ?? null,
      nextPageTokenSeen: discovery.nextPageTokenSeen ?? null,
      logLimitReached: discovery.logLimitReached ?? false,
      candidateLimitReached: discovery.candidateLimitReached ?? false,
      incomplete: discovery.incomplete === true
    };

    if (discovery.status === "success") {
      sources.push(ankrBlockchainForChain(chainId) ? "Ankr Advanced API on-chain ERC-20 approval discovery" : "Etherscan on-chain ERC-20 approval discovery");
      scanSession = {
        candidates: discovery.candidates,
        candidateCount: discovery.candidateCount,
        logCount: discovery.logCount,
        logLimitReached: discovery.logLimitReached,
        candidateLimitReached: discovery.candidateLimitReached,
        latestBlock: discovery.latestBlock,
        batchSize: 3,
        pageToken: discovery.pageToken || null
      };
    } else {
      addFinding(
        findings,
        "ERC-20 approval discovery unavailable",
        discovery.message || "Historical Approval logs could not be retrieved.",
        "neutral",
        0
      );
    }
  }

  if (!findings.length) {
    addFinding(
      findings,
      "No data returned",
      "The configured providers did not return usable data. No safety conclusion can be made.",
      "neutral",
      0
    );
  }

  const providerValues = Object.values(providers);

  const requiredProviderValues = providerValues.filter(
    p => p.status !== "not_applicable"
  );
  const successful = requiredProviderValues.filter(
    p => p.status === "success"
  ).length;

  const hasIncompleteDiscovery =
    providers.erc20_onchain_discovery?.incomplete === true;

  const overallStatus =
    successful === requiredProviderValues.length &&
    successful > 0 &&
    !hasIncompleteDiscovery
      ? "complete"
      : successful > 0
        ? "partial"
        : "unavailable";

  // Contract scores require a successful, complete GoPlus token-security check.
  const contractCoreCheckSuccessful =
    mode !== "contract" ||
    (
      providers.token_security?.status === "success" &&
      providers.token_security?.incomplete !== true &&
      providers.onchain_contract?.status === "success" &&
      providers.onchain_contract?.incomplete !== true
    );
  const score = contractCoreCheckSuccessful
    ? scoreFindings(findings)
    : null;

  return json({
    schemaVersion: 3,
    mode,
    chainId,
    chain: CHAINS[chainId].name,
    target: address,
    checkedAt: new Date().toISOString(),
    overallStatus,
    score,
    scoreLabel:
      score === null
        ? "Insufficient data"
        : "Indicator score",
    findings,
    approvals,
    providers,
    scanSession,
    sources: [...new Set(sources)],
    disclaimer:
      "Automated indicators only; not an audit or guarantee. Missing provider data, incomplete historical logs, and failed allowance calls must not be interpreted as proof of safety or absence of approvals."
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Internal diagnostic endpoints are intentionally disabled on public
    // deployments. Keep these routes unavailable to prevent unauthenticated
    // third parties from consuming provider quotas or retrieving test data.
    const disabledDiagnosticRoutes = new Set([
      "/api/ankr-diagnostics",
      "/api/etherscan-test",
      "/api/approval-log-test",
      "/api/usdc-allowance-test"
    ]);
    if (disabledDiagnosticRoutes.has(url.pathname)) {
      return withCors(json({ error: "Not found" }, 404), request);
    }

    if (
      ["/api/scan", "/api/health", "/api/ankr-diagnostics"].includes(url.pathname) &&
      request.method === "OPTIONS"
    ) {
      return withCors(new Response(null, { status: 204 }), request);
    }

    if (url.pathname === "/api/bsc-nft-approvals") {
      if (request.method !== "GET") {
        return withCors(json({ error: "Method not allowed" }, 405), request);
      }
      const owner = String(url.searchParams.get("address") || "").trim().toLowerCase();
      if (!ADDRESS_RE.test(owner)) {
        return withCors(json({ status: "error", message: "A valid owner address is required." }, 400), request);
      }
      try {
        const ownerTopic = "0x" + owner.slice(2).padStart(64, "0");
        const params = {
          blockchain: ["bsc"],
          fromBlock: "earliest",
          toBlock: "latest",
          topics: [[APPROVAL_FOR_ALL_TOPIC], [ownerTopic]],
          pageSize: 1000,
          descOrder: true
        };
        const inputPageToken = url.searchParams.get("pageToken");
        if (inputPageToken) params.pageToken = inputPageToken;
        const result = await bscAdvancedCall(env, "ankr_getLogs", params);
        const logs = Array.isArray(result?.logs) ? result.logs : [];
        const pairs = new Map();
        for (const log of logs) {
          const topics = Array.isArray(log?.topics) ? log.topics : [];
          if (String(topics[0] || "").toLowerCase() !== APPROVAL_FOR_ALL_TOPIC ||
              String(topics[1] || "").toLowerCase() !== ownerTopic) continue;
          const operator = "0x" + String(topics[2] || "").slice(-40);
          const tokenContract = String(log?.address || "").toLowerCase();
          if (!ADDRESS_RE.test(operator) || !ADDRESS_RE.test(tokenContract)) continue;
          pairs.set(tokenContract + ":" + operator.toLowerCase(), { tokenContract, operator });
        }
        const allowanceChecks = [];
        for (const pair of Array.from(pairs.values()).slice(0, 20)) {
          try {
            const pad = value => value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
            const callData = "0xe985e9c5" + pad(owner) + pad(pair.operator);
            const raw = await bscEthCall(env, pair.tokenContract, callData);
            const isApproved = /^0x[0-9a-f]*$/i.test(raw) && BigInt(raw || "0x0") !== 0n;
            allowanceChecks.push({
              tokenContract: pair.tokenContract,
              ownerAddress: owner,
              operatorAddress: pair.operator,
              status: "success",
              active: isApproved,
              isApprovedForAll: isApproved,
              rawResult: raw
            });
          } catch (error) {
            allowanceChecks.push({
              tokenContract: pair.tokenContract,
              ownerAddress: owner,
              operatorAddress: pair.operator,
              status: error?.status || "unavailable",
              active: null,
              isApprovedForAll: null,
              message: String(error?.message || "isApprovedForAll call failed").slice(0, 180)
            });
          }
        }
        const eventRows = logs.filter(log => {
          const topics = Array.isArray(log?.topics) ? log.topics : [];
          return String(topics[0] || "").toLowerCase() === APPROVAL_FOR_ALL_TOPIC &&
            String(topics[1] || "").toLowerCase() === ownerTopic;
        }).map(log => ({
          tokenContract: log.address || null,
          operatorAddress: "0x" + String(log.topics?.[2] || "").slice(-40),
          approvedInEvent: /^0x0*1$/i.test(String(log.data || "")),
          blockNumber: log.blockNumber || null,
          transactionHash: log.transactionHash || null
        }));
        return withCors(json({
          status: "success",
          chainId: "56",
          owner,
          method: "ankr_getLogs",
          filter: "ApprovalForAll topic with topics[1] equal to owner",
          rawLogCount: logs.length,
          matchedApprovalForAllEventCount: eventRows.length,
          events: eventRows,
          uniqueTokenOperatorPairCount: pairs.size,
          allowanceChecks,
          allowanceChecksLimited: pairs.size > allowanceChecks.length,
          nextPageToken: result?.nextPageToken || null,
          nextPageTokenSeen: Boolean(result?.nextPageToken),
          checkedAt: new Date().toISOString()
        }), request);
      } catch (error) {
        return withCors(json({
          status: "error",
          provider: "Ankr Advanced API",
          failureType: error?.status || "error",
          httpStatus: error?.httpStatus || null,
          message: String(error?.message || "NFT approval query failed").slice(0, 240),
          checkedAt: new Date().toISOString()
        }, 502), request);
      }
    }

    if (url.pathname === "/api/bsc-nft-operator-approvals") {
      if (request.method !== "GET") {
        return withCors(json({ error: "Method not allowed" }, 405), request);
      }
      const operator = String(url.searchParams.get("address") || "").trim().toLowerCase();
      if (!ADDRESS_RE.test(operator)) {
        return withCors(json({ status: "error", message: "A valid operator address is required." }, 400), request);
      }
      try {
        const operatorTopic = "0x" + operator.slice(2).padStart(64, "0");
        const params = {
          blockchain: ["bsc"],
          fromBlock: "earliest",
          toBlock: "latest",
          topics: [[APPROVAL_FOR_ALL_TOPIC], [], [operatorTopic]],
          pageSize: 1000,
          descOrder: true
        };
        const inputPageToken = url.searchParams.get("pageToken");
        if (inputPageToken) params.pageToken = inputPageToken;
        const result = await bscAdvancedCall(env, "ankr_getLogs", params);
        const logs = Array.isArray(result?.logs) ? result.logs : [];
        const pairs = new Map();
        for (const log of logs) {
          const topics = Array.isArray(log?.topics) ? log.topics : [];
          if (String(topics[0] || "").toLowerCase() !== APPROVAL_FOR_ALL_TOPIC ||
              String(topics[2] || "").toLowerCase() !== operatorTopic) continue;
          const owner = "0x" + String(topics[1] || "").slice(-40);
          const tokenContract = String(log?.address || "").toLowerCase();
          if (!ADDRESS_RE.test(owner) || !ADDRESS_RE.test(tokenContract)) continue;
          pairs.set(tokenContract + ":" + owner.toLowerCase(), { tokenContract, owner });
        }
        const allowanceChecks = [];
        for (const pair of Array.from(pairs.values()).slice(0, 20)) {
          try {
            const pad = value => value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
            const raw = await bscEthCall(env, pair.tokenContract, "0xe985e9c5" + pad(pair.owner) + pad(operator));
            const active = /^0x[0-9a-f]*$/i.test(raw) && BigInt(raw || "0x0") !== 0n;
            allowanceChecks.push({ tokenContract: pair.tokenContract, ownerAddress: pair.owner, operatorAddress: operator, status: "success", active, isApprovedForAll: active, rawResult: raw });
          } catch (error) {
            allowanceChecks.push({ tokenContract: pair.tokenContract, ownerAddress: pair.owner, operatorAddress: operator, status: error?.status || "unavailable", active: null, isApprovedForAll: null, message: String(error?.message || "isApprovedForAll call failed").slice(0, 180) });
          }
        }
        const events = logs.filter(log => {
          const topics = Array.isArray(log?.topics) ? log.topics : [];
          return String(topics[0] || "").toLowerCase() === APPROVAL_FOR_ALL_TOPIC &&
            String(topics[2] || "").toLowerCase() === operatorTopic;
        }).map(log => ({
          tokenContract: log.address || null,
          ownerAddress: "0x" + String(log.topics?.[1] || "").slice(-40),
          operatorAddress: operator,
          approvedInEvent: /^0x0*1$/i.test(String(log.data || "")),
          blockNumber: log.blockNumber || null,
          transactionHash: log.transactionHash || null
        }));
        return withCors(json({
          status: "success", chainId: "56", operator, method: "ankr_getLogs",
          filter: "ApprovalForAll topic with topics[2] equal to operator",
          rawLogCount: logs.length, matchedApprovalForAllEventCount: events.length,
          events, uniqueTokenOwnerPairCount: pairs.size, allowanceChecks,
          allowanceChecksLimited: pairs.size > allowanceChecks.length,
          nextPageToken: result?.nextPageToken || null,
          nextPageTokenSeen: Boolean(result?.nextPageToken), checkedAt: new Date().toISOString()
        }), request);
      } catch (error) {
        return withCors(json({
          status: "error", provider: "Ankr Advanced API",
          failureType: error?.status || "error", httpStatus: error?.httpStatus || null,
          message: String(error?.message || "NFT operator approval query failed").slice(0, 240),
          checkedAt: new Date().toISOString()
        }, 502), request);
      }
    }

    if (url.pathname === "/api/bsc-nft-token-approval") {
      if (request.method !== "GET") return withCors(json({ error: "Method not allowed" }, 405), request);
      const owner = String(url.searchParams.get("owner") || "").trim().toLowerCase();
      const tokenContract = String(url.searchParams.get("contract") || "").trim().toLowerCase();
      const tokenId = String(url.searchParams.get("tokenId") || "").trim();
      if (!ADDRESS_RE.test(owner) || !ADDRESS_RE.test(tokenContract) || !/^(0|[1-9][0-9]*)$/.test(tokenId)) {
        return withCors(json({ status: "error", message: "Valid owner, contract and decimal tokenId are required." }, 400), request);
      }
      try {
        const encodedId = BigInt(tokenId).toString(16).padStart(64, "0");
        const raw = await bscEthCall(env, tokenContract, "0x081812fc" + encodedId);
        if (!/^0x[0-9a-f]{64}$/i.test(raw)) throw new Error("Contract returned an invalid getApproved result");
        const approved = "0x" + raw.slice(-40);
        const active = !/^0x0{40}$/i.test(approved);
        return withCors(json({
          status: "success", chainId: "56", owner, tokenContract, tokenId,
          method: "ERC-721 getApproved(uint256)", approvedAddress: approved,
          active, checkedAt: new Date().toISOString()
        }), request);
      } catch (error) {
        return withCors(json({
          status: "error", chainId: "56", owner, tokenContract, tokenId,
          failureType: error?.status || "call_error",
          message: String(error?.message || "getApproved call failed").slice(0, 200),
          checkedAt: new Date().toISOString()
        }, 502), request);
      }
    }

    if (url.pathname === "/api/bsc-owned-nfts") {
      if (request.method !== "GET") return withCors(json({ error: "Method not allowed" }, 405), request);
      const owner = String(url.searchParams.get("address") || "").trim().toLowerCase();
      if (!ADDRESS_RE.test(owner)) return withCors(json({ status: "error", message: "A valid wallet address is required." }, 400), request);
      try {
        const params = { blockchain: ["bsc"], walletAddress: owner, pageSize: 50 };
        const pageToken = url.searchParams.get("pageToken");
        if (pageToken) params.pageToken = pageToken;
        const result = await bscAdvancedCall(env, "ankr_getNFTsByOwner", params);
        const assets = Array.isArray(result?.assets) ? result.assets : [];
        return withCors(json({
          status: "success", chainId: "56", owner, method: "ankr_getNFTsByOwner",
          nftCount: assets.length,
          assets: assets.map(asset => ({
            contractAddress: asset.contractAddress || null,
            contractType: asset.contractType || null,
            tokenId: asset.tokenId || null,
            name: asset.name || null,
            collectionName: asset.collectionName || null,
            symbol: asset.symbol || null,
            quantity: asset.quantity || null
          })),
          nextPageToken: result?.nextPageToken || null,
          nextPageTokenSeen: Boolean(result?.nextPageToken),
          checkedAt: new Date().toISOString()
        }), request);
      } catch (error) {
        return withCors(json({
          status: "error", provider: "Ankr Advanced API",
          failureType: error?.status || "error", httpStatus: error?.httpStatus || null,
          message: String(error?.message || "NFT ownership query failed").slice(0, 240),
          checkedAt: new Date().toISOString()
        }, 502), request);
      }
    }

    if (url.pathname === "/api/bsc-owner-approvals") {
      if (request.method !== "GET") {
        return withCors(json({ error: "Method not allowed" }, 405), request);
      }
      const owner = String(url.searchParams.get("address") || "").trim().toLowerCase();
      if (!ADDRESS_RE.test(owner)) {
        return withCors(json({ status: "error", message: "A valid owner address is required." }, 400), request);
      }
      try {
        const ownerTopic = "0x" + owner.slice(2).padStart(64, "0");
        const params = {
          blockchain: ["bsc"],
          fromBlock: "earliest",
          toBlock: "latest",
          topics: [[APPROVAL_TOPIC], [ownerTopic]],
          pageSize: 1000,
          descOrder: true
        };
        const inputPageToken = url.searchParams.get("pageToken");
        if (inputPageToken) params.pageToken = inputPageToken;
        const result = await bscAdvancedCall(env, "ankr_getLogs", params);
        const logs = Array.isArray(result?.logs) ? result.logs : [];
        const pairs = new Map();
        let matchedApprovalEventCount = 0;
        for (const log of logs) {
          const topics = Array.isArray(log?.topics) ? log.topics : [];
          if (String(topics[0] || "").toLowerCase() !== APPROVAL_TOPIC ||
              String(topics[1] || "").toLowerCase() !== ownerTopic) continue;
          matchedApprovalEventCount += 1;
          const spender = "0x" + String(topics[2] || "").slice(-40);
          const token = String(log?.address || "").toLowerCase();
          if (!ADDRESS_RE.test(spender) || !ADDRESS_RE.test(token)) continue;
          pairs.set(token + ":" + spender.toLowerCase(), { token, spender });
        }
        const allowanceChecks = [];
        for (const pair of Array.from(pairs.values()).slice(0, 20)) {
          const check = await readErc20Allowance(pair.token, owner, pair.spender, "56", env);
          allowanceChecks.push({
            tokenAddress: pair.token,
            ownerAddress: owner,
            spenderAddress: pair.spender,
            status: check.status,
            active: check.active ?? null,
            allowance: check.allowance ?? null,
            rawAllowance: check.rawAllowance ?? null,
            unlimited: check.unlimited ?? null,
            failureType: check.failureType ?? null,
            message: check.message ?? null
          });
        }
        return withCors(json({
          status: "success",
          chainId: "56",
          owner,
          method: "ankr_getLogs",
          filter: "Approval topic with topics[1] equal to owner",
          rawLogCount: logs.length,
          matchedApprovalEventCount,
          uniqueTokenSpenderPairCount: pairs.size,
          allowanceChecks,
          allowanceChecksLimited: pairs.size > allowanceChecks.length,
          nextPageToken: result?.nextPageToken || null,
          nextPageTokenSeen: Boolean(result?.nextPageToken),
          checkedAt: new Date().toISOString()
        }), request);
      } catch (error) {
        return withCors(json({
          status: "error",
          provider: "Ankr Advanced API",
          failureType: error?.status || "error",
          httpStatus: error?.httpStatus || null,
          message: String(error?.message || "Owner approval query failed").slice(0, 240),
          checkedAt: new Date().toISOString()
        }, 502), request);
      }
    }

    if (url.pathname === "/api/bsc-spender-approvals") {
      if (request.method !== "GET") {
        return withCors(json({ error: "Method not allowed" }, 405), request);
      }
      const spender = String(url.searchParams.get("address") || "").trim().toLowerCase();
      if (!ADDRESS_RE.test(spender)) {
        return withCors(json({ status: "error", message: "A valid spender address is required." }, 400), request);
      }
      try {
        const spenderTopic = "0x" + spender.slice(2).padStart(64, "0");
        const params = {
          blockchain: ["bsc"],
          fromBlock: "earliest",
          toBlock: "latest",
          topics: [[APPROVAL_TOPIC], [], [spenderTopic]],
          pageSize: 1000,
          descOrder: true
        };
        const inputPageToken = url.searchParams.get("pageToken");
        if (inputPageToken) params.pageToken = inputPageToken;
        const result = await bscAdvancedCall(env, "ankr_getLogs", params);
        const logs = Array.isArray(result?.logs) ? result.logs : [];
        const pairs = new Map();
        for (const log of logs) {
          const topics = Array.isArray(log?.topics) ? log.topics : [];
          if (String(topics[0] || "").toLowerCase() !== APPROVAL_TOPIC ||
              String(topics[2] || "").toLowerCase() !== spenderTopic) continue;
          const owner = "0x" + String(topics[1] || "").slice(-40);
          const token = String(log?.address || "").toLowerCase();
          if (!ADDRESS_RE.test(owner) || !ADDRESS_RE.test(token)) continue;
          pairs.set(token + ":" + owner.toLowerCase(), { token, owner });
        }
        const allowanceChecks = [];
        for (const pair of Array.from(pairs.values()).slice(0, 20)) {
          const check = await readErc20Allowance(pair.token, pair.owner, spender, "56", env);
          allowanceChecks.push({
            tokenAddress: pair.token,
            ownerAddress: pair.owner,
            status: check.status,
            active: check.active ?? null,
            allowance: check.allowance ?? null,
            rawAllowance: check.rawAllowance ?? null,
            unlimited: check.unlimited ?? null,
            failureType: check.failureType ?? null,
            message: check.message ?? null
          });
        }
        return withCors(json({
          status: "success",
          chainId: "56",
          spender,
          method: "ankr_getLogs",
          filter: "Approval topic with topics[2] equal to spender",
          rawLogCount: logs.length,
          matchedApprovalCount: pairs.size,
          allowanceChecks,
          allowanceChecksLimited: pairs.size > allowanceChecks.length,
          nextPageToken: result?.nextPageToken || null,
          nextPageTokenSeen: Boolean(result?.nextPageToken),
          checkedAt: new Date().toISOString()
        }), request);
      } catch (error) {
        return withCors(json({
          status: "error",
          provider: "Ankr Advanced API",
          failureType: error?.status || "error",
          httpStatus: error?.httpStatus || null,
          message: String(error?.message || "Spender approval query failed").slice(0, 240),
          checkedAt: new Date().toISOString()
        }, 502), request);
      }
    }

    if (url.pathname === "/api/ankr-diagnostics") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      const wallet = "0x2a7fa743178b83fab841000d57144c7cb1ded359";
      const ownerTopic = "0x" + wallet.slice(2).padStart(64, "0");
      const summarize = (result, expectedOwner, includeLogSamples = false) => {
        const logs = Array.isArray(result?.logs) ? result.logs : null;
        const first = logs?.[0] || null;
        const firstTopics = Array.isArray(first?.topics) ? first.topics : [];
        return {
          resultType: Array.isArray(result) ? "array" : typeof result,
          resultKeys: result && typeof result === "object" && !Array.isArray(result)
            ? Object.keys(result).slice(0, 20)
            : [],
          logsFieldType: Array.isArray(result?.logs) ? "array" : typeof result?.logs,
          logCount: logs?.length ?? null,
          hasNextPageToken: Boolean(result?.nextPageToken),
          syncStatus: result?.syncStatus ?? null,
          firstLogKeys: first && typeof first === "object"
            ? Object.keys(first).slice(0, 20)
            : [],
          firstLogTopicCount: firstTopics.length || null,
          firstLogTopic0MatchesApproval: firstTopics.length > 0
            ? String(firstTopics[0]).toLowerCase() === APPROVAL_TOPIC
            : null,
          firstLogTopic1MatchesWallet: expectedOwner && firstTopics.length > 1
            ? String(firstTopics[1]).toLowerCase() === expectedOwner
            : null,
          logSamples: includeLogSamples
            ? (logs || []).slice(0, 5).map(log => ({
                address: log?.address ?? null,
                topics: Array.isArray(log?.topics) ? log.topics : [],
                blockNumber: log?.blockNumber ?? null,
                transactionHash: log?.transactionHash ?? null,
                logIndex: log?.logIndex ?? null,
                timestamp: log?.timestamp ?? null
              }))
            : undefined
        };
      };
      try {
        // Cross-check Ankr's topic filtering by fetching a bounded sample of
        // global Approval logs, then matching the indexed owner locally.
        const crossCheck = {
          pageSize: 1000,
          maxPages: 1,
          pagesFetched: 0,
          rawLogCount: 0,
          matchingOwnerCount: 0,
          matchingSpenderCount: 0,
          nextPageTokenSeen: false,
          sampleMatches: []
        };
        // Continue a bounded diagnostic scan with ?pageToken=<returned token>.
        let crossCheckPageToken = url.searchParams.get("pageToken") || null;
        const inputPageTokenProvided = Boolean(crossCheckPageToken);
        for (let page = 0; page < crossCheck.maxPages; page++) {
          const params = {
            blockchain: ["bsc"],
            fromBlock: "earliest",
            toBlock: "latest",
            topics: [[APPROVAL_TOPIC]],
            pageSize: crossCheck.pageSize,
            descOrder: true
          };
          if (crossCheckPageToken) params.pageToken = crossCheckPageToken;
          const result = await bscAdvancedCall(env, "ankr_getLogs", params);
          crossCheck.pagesFetched += 1;
          const pageLogs = Array.isArray(result?.logs) ? result.logs : [];
          crossCheck.rawLogCount += pageLogs.length;
          for (const log of pageLogs) {
            const topics = Array.isArray(log?.topics) ? log.topics : [];
            if (String(topics[0] || "").toLowerCase() !== APPROVAL_TOPIC) continue;
            const ownerMatches = String(topics[1] || "").toLowerCase() === ownerTopic;
            const spenderMatches = String(topics[2] || "").toLowerCase() === ownerTopic;
            if (ownerMatches) crossCheck.matchingOwnerCount += 1;
            if (spenderMatches) crossCheck.matchingSpenderCount += 1;
            if ((ownerMatches || spenderMatches) && crossCheck.sampleMatches.length < 10) {
              crossCheck.sampleMatches.push({
                matchedRole: ownerMatches && spenderMatches
                  ? "owner_and_spender"
                  : ownerMatches ? "owner" : "spender",
                tokenAddress: log?.address ?? null,
                ownerTopic: topics[1] ?? null,
                spenderTopic: topics[2] ?? null,
                blockNumber: log?.blockNumber ?? null,
                transactionHash: log?.transactionHash ?? null
              });
            }
          }
          crossCheckPageToken = result?.nextPageToken || null;
          if (crossCheckPageToken) crossCheck.nextPageTokenSeen = true;
          if (!crossCheckPageToken) break;
        }
        crossCheck.stoppedAtPageLimit = Boolean(crossCheckPageToken);
        crossCheck.inputPageTokenProvided = inputPageTokenProvided;
        crossCheck.nextPageToken = crossCheckPageToken;

        return withCors(json({
          status: "success",
          provider: "Ankr Advanced API",
          method: "ankr_getLogs",
          query: {
            blockchain: ["bsc"],
            fromBlock: "earliest",
            toBlock: "latest",
            pageSize: 10,
            descOrder: true,
            approvalTopicConfigured: true,
            walletTopicLength: ownerTopic.length
          },
          globalApprovalLocalOwnerCrossCheck: crossCheck,
          checkedAt: new Date().toISOString()
        }), request);
      } catch (error) {
        return withCors(json({
          status: "error",
          provider: "Ankr Advanced API",
          failureType: error?.status || "error",
          httpStatus: error?.httpStatus || null,
          message: String(error?.message || "Ankr diagnostic failed").slice(0, 240),
          checkedAt: new Date().toISOString()
        }, 502), request);
      }
    }

    if (url.pathname === "/api/etherscan-test") {
      if (!env.ETHERSCAN_API_KEY) {
        return json({
          status: "error",
          message: "ETHERSCAN_API_KEY is missing"
        }, 500);
      }

      const address = "0x2a7FA743178B83fAB841000d57144C7CB1DEd359";
      const apiUrl = new URL(ETHERSCAN_API);

      apiUrl.search = new URLSearchParams({
        chainid: "1",
        module: "account",
        action: "tokentx",
        address,
        page: "1",
        offset: "5",
        sort: "desc",
        apikey: env.ETHERSCAN_API_KEY
      });

      const data = await fetchEtherscanJson(apiUrl.toString());

      return json({
        httpStatus: 200,        apiStatus: data.status,        apiMessage: data.message,
        resultCount: Array.isArray(data.result) ? data.result.length : null,
        result: Array.isArray(data.result) ? data.result.slice(0, 5) : data.result
      });
    }

    if (url.pathname === "/api/approval-log-test") {
      try {
        const wallet = "0x2a7fa743178b83fab841000d57144c7cb1ded359";

        const ownerTopic =
          "0x" + wallet.slice(2).toLowerCase().padStart(64, "0");

        if (!env.ETHERSCAN_API_KEY) {
          return json({
            status: "error",
            message: "ETHERSCAN_API_KEY is missing"
          }, 500);
        }

        const blockUrl = new URL(ETHERSCAN_API);

        blockUrl.search = new URLSearchParams({
          chainid: "1",
          module: "proxy",
          action: "eth_blockNumber",
          apikey: env.ETHERSCAN_API_KEY
        });

        const blockData = await fetchEtherscanJson(blockUrl.toString());

        if (!/^0x[0-9a-f]+$/i.test(blockData.result || "")) {
          return json({
            step: "get_latest_block",
            response: blockData
          });
        }

        const latestBlock = parseInt(blockData.result, 16);
        const logsUrl = new URL(ETHERSCAN_API);

        logsUrl.search = new URLSearchParams({
          chainid: "1",
          module: "logs",
          action: "getLogs",
          fromBlock: "0",
          toBlock: String(latestBlock),
          topic0: APPROVAL_TOPIC,
          topic0_1_opr: "and",
          topic1: ownerTopic,
          page: "1",
          offset: "1000",
          apikey: env.ETHERSCAN_API_KEY
        });

        const logsData = await fetchEtherscanJson(logsUrl.toString());
        const logs = Array.isArray(logsData.result) ? logsData.result : [];

        return json({
          httpStatus: 200,
          fromBlock: 0,
          toBlock: latestBlock,
          scannedBlocks: latestBlock,
          apiStatus: logsData.status ?? null,
          apiMessage: logsData.message ?? null,
          resultCount: logs.length,
          result: logs.slice(0, 10).map(log => ({
            contract: log.address,
            topics: log.topics,
            data: log.data,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash
          }))
        });

      } catch (error) {
        return json({
          status: "error",
          message: error.message || "Approval log test failed"
        }, 500);
      }
    }

    if (url.pathname === "/api/usdc-allowance-test") {
      const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const owner = "0x2a7FA743178B83fAB841000d57144C7CB1DEd359";
      const spender = "0xb300000b72DEAEb607a12d5f54773D1C19c7028d";

      const result = await readErc20Allowance(
        token,
        owner,
        spender,
        "1",
        env
      );

      return json({
        success: result.status === "success",
        network: "Ethereum Mainnet",
        token: "USDC",
        owner,
        spender,
        rawAllowance: result.rawAllowance ?? null,
        allowanceUSDC: result.allowance ?? null,
        decimals: result.decimals ?? null,
        unlimited: result.unlimited ?? null,
        active: result.active ?? null,
        checkedAt: result.checkedAt ?? null,
        failureType: result.failureType ?? null,
        httpStatus: result.httpStatus ?? null,
        error: result.message || null
      }, result.status === "success" ? 200 : 502);
    }

    if (url.pathname === "/api/scan") {
      try {
        return withCors(await handleScan(request, env), request);
      } catch (_) {
        return withCors(
          json({
            error: "Unexpected scan error. Please try again later."
          }, 500),
          request
        );
      }
    }

    if (url.pathname === "/api/health") {
      return withCors(
        json({
          status: "ok",
          service: "nexorascope-security-api",
          apiVersion: 8,
          features: {
            batchedErc20AllowanceChecks: true,
            allowanceBatchSize: 3,
            separateBatchInvocations: true,
            erc20TokenMetadata: true,
            knownSpenderLabels: true,
            bscAnkrAdvancedLogs: true,
            bscRpcAllowanceReads: true,
            baseAnkrAdvancedLogs: true,
            baseAnkrAllowanceReads: true,
            separateAnkrChainRpcForEthCall: true,
            unresolvedApprovalCandidatesVisible: true,
            partialIndicatorScore: true
          },
          supportedChains: Object.keys(CHAINS)
        }),
        request
      );
    }

    return withCors(json({ error: "Not found" }, 404), request);
  }
};
