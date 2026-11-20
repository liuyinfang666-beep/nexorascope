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

const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

let nextEtherscanRequestAt = 0;
const ETHERSCAN_REQUEST_INTERVAL_MS = 400;

const DECIMALS_CACHE = new Map();
const DECIMALS_CACHE_TTL = 60 * 60 * 1000;

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
    "https://www.nexorascope.xyz"
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
  { ttl = CACHE_TTL_SECONDS, headers = {} } = {}
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

        if (error?.status) throw error;

        const failureStatus = classifyFailure(
          error?.httpStatus || 0,
          error?.message || ""
        );

        if (
          attempt < MAX_RETRIES &&
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

  if (!assessed.length) return null;

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
      const msg =
        `${data?.message || "Explorer returned no source"} ` +
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

async function readErc20Allowance(token, owner, spender, chainId, env) {
  if (!env.ETHERSCAN_API_KEY) {
    return {
      status: "unavailable",
      failureType: "missing_api_key",
      message: "ETHERSCAN_API_KEY is not configured"
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

  const baseParams = {
    chainid: chainId,
    module: "proxy",
    action: "eth_call",
    to: token,
    tag: "latest",
    apikey: env.ETHERSCAN_API_KEY
  };

  try {
    const allowanceParams = new URLSearchParams({
      ...baseParams,
      data: "0xdd62ed3e" + padAddress(owner) + padAddress(spender)
    });

    let allowanceResult;

    try {
      allowanceResult = await fetchEtherscanJson(
        `${ETHERSCAN_API}?${allowanceParams.toString()}`
      );
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
          "Etherscan returned no valid allowance hex value"
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

    const tokenKey = `${chainId}:${token.toLowerCase()}`;
    const cachedDecimals = DECIMALS_CACHE.get(tokenKey);

    if (cachedDecimals && cachedDecimals.expires > Date.now()) {
      decimals = cachedDecimals.value;
    } else {
      const decimalsParams = new URLSearchParams({
        ...baseParams,
        data: "0x313ce567"
      });

      try {
        const decimalsResult = await fetchEtherscanJson(
          `${ETHERSCAN_API}?${decimalsParams.toString()}`
        );

        if (/^0x[0-9a-f]+$/i.test(decimalsResult.result || "")) {
          const parsed = Number(BigInt(decimalsResult.result));

          if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 36) {
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
        decimalsError = String(error.message || "Decimals request failed").slice(0, 200);
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
      decimalsError
    };

  } catch (error) {
    return {
      status: error.status || "error",
      failureType: error.status || "allowance_unknown_error",
      httpStatus: error.httpStatus || null,
      message: String(error.message || "Allowance request failed").slice(0, 300)
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
  if (!env.ETHERSCAN_API_KEY) {
    return {
      status: "unavailable",
      message: "ETHERSCAN_API_KEY is missing",
      approvals: [],
      candidateCount: 0,
      checkedCount: 0,
      failedCount: 0,
      failureStats: { missing_api_key: 1 },
      failureSamples: [{
        type: "missing_api_key",
        status: "unavailable",
        message: "ETHERSCAN_API_KEY is missing"
      }],
      incomplete: true
    };
  }

  const ownerTopic =
    "0x" + owner.slice(2).toLowerCase().padStart(64, "0");

  try {
    const blockUrl = new URL(ETHERSCAN_API);

    blockUrl.search = new URLSearchParams({
      chainid: chainId,
      module: "proxy",
      action: "eth_blockNumber",
      apikey: env.ETHERSCAN_API_KEY
    });

    const blockData = await fetchEtherscanJson(blockUrl.toString());

    if (!/^0x[0-9a-f]+$/i.test(blockData.result || "")) {
      throw new Error(
        blockData.message || blockData.result || "Could not retrieve latest block"
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
        chainid: chainId,
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

      const logsData = await fetchEtherscanJson(logsUrl.toString(), 20000);

      if (
        String(logsData.status) === "0" &&
        !Array.isArray(logsData.result)
      ) {
        const message = String(logsData.result || logsData.message || "");

        if (/no records found/i.test(message)) break;

        throw new Error(message || "Approval log query failed");
      }

      const pageLogs = Array.isArray(logsData.result) ? logsData.result : [];
      logs.push(...pageLogs);

      if (pageLogs.length < PAGE_SIZE) break;

      if (page === MAX_LOG_PAGES) logLimitReached = true;
    }

    const candidates = new Map();

    for (const log of logs) {
      const topics = log?.topics || [];

      if (topics.length < 3 || !ADDRESS_RE.test(log.address || "")) continue;

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
          previous.lastTransactionHash = log.transactionHash || null;
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

    const verified = [];
    let checkedCount = 0;
    let failedCount = 0;
    let cursor = 0;

    // NEW: Aggregate allowance-check failure diagnostics.
    const failureStats = {};
    const failureSamples = [];

    function recordFailure(result, candidate) {
      const type =
        result.failureType ||
        result.status ||
        "unknown";

      failureStats[type] = (failureStats[type] || 0) + 1;

      if (failureSamples.length < 12) {
        failureSamples.push({
          type,
          status: result.status || "error",
          httpStatus: result.httpStatus ?? null,
          message: String(result.message || "").slice(0, 250),
          token: candidate.tokenAddress,
          spender: candidate.spender
        });
      }
    }

    const CONCURRENCY = 2;

    async function worker() {
      while (cursor < selected.length) {
        const index = cursor++;
        const candidate = selected[index];

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
            message: error.message || "Unexpected allowance error"
          };
        }

        checkedCount++;

        if (result.status !== "success") {
          failedCount++;
          recordFailure(result, candidate);
          continue;
        }

        if (!result.active) continue;

        let unlimited = false;

        try {
          const raw = BigInt(result.rawAllowance);
          const maxUint256 = (1n << 256n) - 1n;

          unlimited =
            raw > 0n &&
            raw * 100000000n >= maxUint256 * 99999999n;
        } catch (_) {
          unlimited = false;
        }

        verified.push({
          standard: "ERC-20",
          tokenAddress: candidate.tokenAddress,
          spender: candidate.spender,
          allowance: result.allowance,
          rawCurrentAllowance: result.rawAllowance,
          tokenDecimals: result.decimals,
          unlimited,
          currentlyActive: true,
          currentAllowanceStatus: "success",
          currentAllowanceCheckedAt: result.checkedAt,
          decimalsError: result.decimalsError || null,
          discoverySource: "Etherscan Approval logs",
          lastSeenBlock: candidate.lastSeenBlock,
          lastTransactionHash: candidate.lastTransactionHash
        });
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(CONCURRENCY, selected.length) },
        () => worker()
      )
    );

    const incomplete =
      logLimitReached ||
      candidateLimitReached ||
      failedCount > 0;

    return {
      status: incomplete ? "partial" : "success",
      message: incomplete
        ? "Some candidates or historical logs could not be fully verified"
        : "Approval event discovery and current allowance checks completed",
      approvals: verified,
      candidateCount: allCandidates.length,
      checkedCount,
      failedCount,
      failureStats,
      failureSamples,
      logCount: logs.length,
      logLimitReached,
      candidateLimitReached,
      incomplete,
      latestBlock
    };

  } catch (error) {
    const failureType =
      error.failureType ||
      error.status ||
      "discovery_error";

    return {
      status: "error",
      message: String(error.message || "On-chain approval discovery failed").slice(0, 300),
      approvals: [],
      candidateCount: 0,
      checkedCount: 0,
      failedCount: 0,
      failureStats: {
        [failureType]: 1
      },
      failureSamples: [{
        type: failureType,
        status: error.status || "error",
        httpStatus: error.httpStatus ?? null,
        message: String(error.message || "Unknown discovery error").slice(0, 250)
      }],
      incomplete: true
    };
  }
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

  const runGoPlus = async (key, url, onSuccess) => {
    try {
      const result = await cachedProviderGet("goplus", url, env);

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
        message: e.message || "Provider request failed",
        cache: "none"
      };

      addFinding(
        findings,
        `${key} unavailable`,
        `${providers[key].status}: ${providers[key].message}`,
        "neutral",
        0
      );
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

    for (const [endpoint, standard] of [
      ["token_approval_security", "ERC-20"],
      ["nft721_approval_security", "ERC-721"],
      ["nft1155_approval_security", "ERC-1155"]
    ]) {
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
    jobs.push(
      runGoPlus(
        "token_security",
        `${GOPLUS_API}/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
        data => summarizeTokenRisk(data, findings)
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

  if (mode === "wallet") {
    const discovery = await discoverErc20Approvals(address, chainId, env);

    providers.erc20_onchain_discovery = {
      provider: "Etherscan API V2",
      status: discovery.status,
      message: discovery.message,
      candidateCount: discovery.candidateCount,
      checkedCount: discovery.checkedCount,
      failedCount: discovery.failedCount || 0,
      // NEW: Expose failure diagnostics in the scan response.
      failureStats: discovery.failureStats || {},
      failureSamples: discovery.failureSamples || [],
      logCount: discovery.logCount ?? null,
      logLimitReached: discovery.logLimitReached ?? false,
      candidateLimitReached: discovery.candidateLimitReached ?? false,
      incomplete: discovery.incomplete
    };

    if (
      discovery.status === "success" ||
      discovery.status === "partial"
    ) {
      sources.push("Etherscan on-chain ERC-20 approval discovery");
    }

    if (discovery.approvals.length > 0) {
      for (let i = findings.length - 1; i >= 0; i--) {
        if (findings[i].title === "ERC-20 approval data") {
          findings.splice(i, 1);
        }
      }
    }

    const existing = new Set(
      approvals.map(item =>
        `${item.tokenAddress?.toLowerCase()}:${item.spender?.toLowerCase()}`
      )
    );

    for (const record of discovery.approvals) {
      const key =
        `${record.tokenAddress.toLowerCase()}:${record.spender.toLowerCase()}`;

      if (!existing.has(key)) {
        approvals.push(record);
        existing.add(key);
      }
    }

    const unlimitedCount = discovery.approvals.filter(
      item => item.unlimited === true
    ).length;

    const activeCount = discovery.approvals.length;

    if (unlimitedCount > 0) {
      addFinding(
        findings,
        "Near-unlimited ERC-20 allowance",
        `${unlimitedCount} current ERC-20 allowance(s) are at or extremely close to the uint256 maximum. Review and revoke permissions you do not need.`,
        "bad",
        25
      );
    }

    if (activeCount > unlimitedCount) {
      addFinding(
        findings,
        "Active ERC-20 allowance",
        `${activeCount - unlimitedCount} additional active ERC-20 allowance(s) were found. Review each token and spender.`,
        "warn",
        12
      );
    }

    if (discovery.incomplete) {
      addFinding(
        findings,
        "ERC-20 approval discovery incomplete",
        "Some historical logs or candidate allowances could not be fully checked. An incomplete scan must not be interpreted as absence of risk.",
        "neutral",
        0
      );
    }

    if (
      discovery.status === "success" &&
      discovery.approvals.length === 0
    ) {
      addFinding(
        findings,
        "On-chain ERC-20 approval discovery",
        "No active ERC-20 allowance was found among the discovered and successfully checked candidates. This does not cover NFT approvals or logs omitted by the provider.",
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

  const successful = providerValues.filter(
    p => p.status === "success"
  ).length;

  const hasIncompleteDiscovery =
    providers.erc20_onchain_discovery?.incomplete === true;

  const overallStatus =
    successful === providerValues.length &&
    successful > 0 &&
    !hasIncompleteDiscovery
      ? "complete"
      : successful > 0
        ? "partial"
        : "unavailable";

  return json({
    schemaVersion: 3,
    mode,
    chainId,
    chain: CHAINS[chainId].name,
    target: address,
    checkedAt: new Date().toISOString(),
    overallStatus,
    score: scoreFindings(findings),
    scoreLabel:
      scoreFindings(findings) === null
        ? "Insufficient data"
        : "Indicator score",
    findings,
    approvals,
    providers,
    sources: [...new Set(sources)],
    disclaimer:
      "Automated indicators only; not an audit or guarantee. Missing provider data, incomplete historical logs, and failed allowance calls must not be interpreted as proof of safety or absence of approvals."
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      ["/api/scan", "/api/health"].includes(url.pathname) &&
      request.method === "OPTIONS"
    ) {
      return withCors(new Response(null, { status: 204 }), request);
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
        httpStatus: 200,
        apiStatus: data.status,
        apiMessage: data.message,
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
          apiVersion: 3,
          supportedChains: Object.keys(CHAINS)
        }),
        request
      );
    }

    return withCors(json({ error: "Not found" }, 404), request);
  }
};
