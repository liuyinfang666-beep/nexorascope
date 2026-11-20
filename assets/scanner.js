(() => {
  const API_URL = "https://nexorascope-security-api-preview.liuyinfang666.workers.dev/api/scan";
  const form = document.getElementById("scanForm");
  const addressInput = document.getElementById("address");
  const chainInput = document.getElementById("chainId");
  const scanButton = document.getElementById("scanButton");
  const errorBox = document.getElementById("scanError");
  const results = document.getElementById("resultsSection");
  let mode = "wallet";

  document.querySelectorAll(".scan-tab").forEach(button => button.addEventListener("click", () => {
    mode = button.dataset.mode;
    document.querySelectorAll(".scan-tab").forEach(tab => {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
    scanButton.textContent = mode === "wallet" ? "Run wallet scan" : "Run contract scan";
  }));

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));

  const statusText = status => ({
    success:"Success",
    pending:"In progress",
    partial:"Partial",
    rate_limited:"Rate limited",
    auth_error:"Authentication error",
    quota_exceeded:"Quota exceeded",
    unavailable:"Unavailable",
    error:"Request error",
    unknown:"Unknown"
  }[status] || status || "Unknown");

  function renderReport(data) {
    results.classList.remove("hidden");
    document.getElementById("resultMeta").textContent =
      `${data.chain || chainInput.options[chainInput.selectedIndex].text} · ${data.mode} · ${data.target} · ${new Date(data.checkedAt).toLocaleString()}`;

    const badge = document.getElementById("overallBadge");
    badge.className = `status-badge ${data.overallStatus || "unavailable"}`;
    badge.textContent = data.overallStatus === "complete"
      ? "Provider checks completed"
      : data.overallStatus === "partial"
        ? "Partial results"
        : "No provider results";

    document.getElementById("scoreValue").textContent =
      data.score === null || data.score === undefined ? "—" : `${data.score}/100`;
    document.getElementById("scoreDescription").textContent =
      data.score === null || data.score === undefined
        ? "Insufficient data — no indicator score can be calculated."
        : "Indicator score based on positive findings returned by the configured checks; not a safety probability.";

    const providerGrid = document.getElementById("providerGrid");
    providerGrid.innerHTML = Object.entries(data.providers || {}).map(([key, p]) =>
      `<div class="provider-card"><strong>${escapeHtml(key.replaceAll("_"," "))}</strong><span class="provider-state ${escapeHtml(p.status)}">${escapeHtml(statusText(p.status))}</span><p>${escapeHtml(p.message || "")}${p.httpStatus ? ` · HTTP ${escapeHtml(p.httpStatus)}` : ""}${p.cache ? ` · cache: ${escapeHtml(p.cache)}` : ""}</p>${p.checkedCount !== undefined ? `<p>Successful checks: ${escapeHtml(p.checkedCount)} · Failed: ${escapeHtml(p.failedCount || 0)} · Candidates: ${escapeHtml(p.candidateCount || 0)}</p>` : ""}</div>`
    ).join("") || `<div class="provider-card">Provider status was not supplied.</div>`;

    const findings = Array.isArray(data.findings) ? data.findings : [];
    document.getElementById("findingsList").innerHTML = findings.map(f =>
      `<article class="finding ${escapeHtml(f.level || "neutral")}"><h4>${escapeHtml(f.title)}</h4><p>${escapeHtml(f.detail)}</p></article>`
    ).join("") || `<article class="finding neutral"><p>No findings were returned. This is not evidence of safety.</p></article>`;

    const approvals = Array.isArray(data.approvals) ? data.approvals : [];
    const block = document.getElementById("approvalsBlock");
    block.classList.toggle("hidden", data.mode !== "wallet");
    document.getElementById("approvalsBody").innerHTML = approvals.length
      ? approvals.map(a => `<tr><td>${escapeHtml(a.standard)}</td><td>${escapeHtml(a.tokenName || a.tokenSymbol || a.token || a.symbol || "Unknown token")}${a.tokenSymbol && a.tokenName ? ` (${escapeHtml(a.tokenSymbol)})` : ""}</td><td>${escapeHtml(a.tokenAddress || "—")}</td><td>${escapeHtml(a.spenderName || "Unknown spender")}<br><small>${escapeHtml(a.spender || "—")}</small></td><td>${escapeHtml(a.allowance || (a.rawCurrentAllowance ? "Raw value only (decimals unavailable)" : "—"))}</td><td>${escapeHtml(a.tokenId || "—")}</td><td>${a.risky ? "Provider flagged" : (a.rawRisk ? escapeHtml(a.rawRisk) : (a.formattingComplete === false ? "Active; amount formatting incomplete" : (a.spenderIdentity === "unknown" ? "Unknown spender; review required" : "No provider risk flag returned")))}</td></tr>`).join("")
      : `<tr><td colspan="7">No parseable approval detail was returned. This does not prove that no approvals exist.</td></tr>`;

    document.getElementById("disclaimer").textContent =
      data.disclaimer || "Automated indicators only; not an audit or guarantee.";
    results.scrollIntoView({behavior:"smooth",block:"start"});
  }

  async function postJson(payload) {
    const response = await fetch(API_URL, {
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Scan request failed (HTTP ${response.status})`);
    }
    return data;
  }

  function addDiscoveryFindings(data, stats) {
    const unlimitedCount = data.approvals.filter(a => a.unlimited === true).length;
    const activeCount = data.approvals.length;
    if (unlimitedCount > 0) {
      data.findings.push({
        title:"Near-unlimited ERC-20 allowance",
        detail:`${unlimitedCount} current ERC-20 allowance(s) are at or extremely close to the uint256 maximum. Review and revoke permissions you do not need.`,
        level:"bad",
        weight:25
      });
    }
    if (activeCount > unlimitedCount) {
      data.findings.push({
        title:"Active ERC-20 allowance",
        detail:`${activeCount - unlimitedCount} additional active ERC-20 allowance(s) were found. Review each token and spender.`,
        level:"warn",
        weight:12
      });
    }
    if (stats.failedCount > 0 || stats.formattingIncompleteCount > 0 ||
        stats.logLimitReached || stats.candidateLimitReached) {
      data.findings.push({
        title:"ERC-20 approval discovery incomplete",
        detail:`Some current allowances could not be fully checked or formatted. Successful checks: ${stats.checkedCount}; failed checks: ${stats.failedCount}; amount-formatting issues: ${stats.formattingIncompleteCount}. An incomplete scan must not be interpreted as absence of risk.`,
        level:"neutral",
        weight:0
      });
    }
    const assessed = data.findings.filter(f => Number(f.weight) > 0);
    data.score = assessed.length
      ? Math.max(0, Math.min(100, 100 - assessed.reduce((sum, f) => sum + Number(f.weight), 0)))
      : null;
    data.scoreLabel = data.score === null ? "Insufficient data" : "Indicator score";
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    errorBox.classList.add("hidden");
    const address = addressInput.value.trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      errorBox.textContent = "Enter a valid 0x address containing exactly 40 hexadecimal characters.";
      errorBox.classList.remove("hidden");
      addressInput.focus();
      return;
    }

    scanButton.disabled = true;
    scanButton.textContent = "Starting scan…";

    try {
      const data = await postJson({mode,chainId:chainInput.value,address});

      if (mode === "wallet" && data.scanSession &&
          Array.isArray(data.scanSession.candidates)) {
        const session = data.scanSession;
        const stats = {
          checkedCount:0,
          failedCount:0,
          formattingIncompleteCount:0,
          failureStats:{},
          failureSamples:[],
          logLimitReached:!!session.logLimitReached,
          candidateLimitReached:!!session.candidateLimitReached
        };
        const combined = [];
        let cursor = 0;

        if (chainInput.value === "56" && session.pageToken) {
          const unique = new Map();
          const addCandidates = rows => {
            for (const candidate of rows || []) {
              const key = `${String(candidate.tokenAddress || "").toLowerCase()}:${String(candidate.spender || "").toLowerCase()}`;
              const previous = unique.get(key);
              if (!previous || BigInt(candidate.lastSeenBlock || 0) > BigInt(previous.lastSeenBlock || 0)) unique.set(key, candidate);
            }
          };
          addCandidates(session.candidates);
          let pageToken = session.pageToken;
          let pageNumber = 1;
          while (pageToken) {
            scanButton.textContent = `Loading BNB approval logs… page ${pageNumber}`;
            const page = await postJson({
              phase:"approval_log_batch",
              chainId:chainInput.value,
              address,
              pageToken
            });
            addCandidates(page.candidates);
            pageToken = page.pageToken || null;
            pageNumber++;
            if (pageNumber > 100) {
              stats.logLimitReached = true;
              break;
            }
          }
          session.candidates = [...unique.values()]
            .sort((a,b) => BigInt(a.lastSeenBlock || 0) > BigInt(b.lastSeenBlock || 0) ? -1 : 1)
            .slice(0,150);
          stats.candidateLimitReached = unique.size > 150;
          if (pageToken) stats.logLimitReached = true;
        }

        while (cursor < session.candidates.length) {
          scanButton.textContent =
            `Checking approvals… ${Math.min(cursor + session.batchSize, session.candidates.length)}/${session.candidates.length}`;

          const batch = await postJson({
            phase:"allowance_batch",
            chainId:chainInput.value,
            address,
            candidates:session.candidates,
            cursor
          });

          combined.push(...(Array.isArray(batch.approvals) ? batch.approvals : []));
          stats.checkedCount += Number(batch.checkedCount || 0);
          stats.failedCount += Number(batch.failedCount || 0);
          stats.formattingIncompleteCount += Number(batch.formattingIncompleteCount || 0);

          for (const [key,value] of Object.entries(batch.failureStats || {})) {
            stats.failureStats[key] = (stats.failureStats[key] || 0) + Number(value || 0);
          }
          for (const sample of batch.failureSamples || []) {
            if (stats.failureSamples.length < 12) stats.failureSamples.push(sample);
          }

          if (!Number.isInteger(batch.nextCursor) || batch.nextCursor <= cursor) {
            throw new Error("Allowance batch did not advance. Please restart the scan.");
          }
          cursor = batch.nextCursor;
        }

        const mergedApprovals = Array.isArray(data.approvals) ? [...data.approvals] : [];
        const seenApprovalKeys = new Set(mergedApprovals.map(item =>
          `${String(item.tokenAddress || "").toLowerCase()}:${String(item.spender || "").toLowerCase()}`
        ));
        for (const item of combined) {
          const key = `${String(item.tokenAddress || "").toLowerCase()}:${String(item.spender || "").toLowerCase()}`;
          if (!seenApprovalKeys.has(key)) {
            mergedApprovals.push(item);
            seenApprovalKeys.add(key);
          }
        }
        data.approvals = mergedApprovals;

        if (combined.length > 0) {
          data.findings = (data.findings || []).filter(f => f.title !== "ERC-20 approval data");
        }

        const provider = data.providers.erc20_onchain_discovery;
        provider.checkedCount = stats.checkedCount;
        provider.failedCount = stats.failedCount;
        provider.formattingIncompleteCount = stats.formattingIncompleteCount;
        provider.failureStats = stats.failureStats;
        provider.failureSamples = stats.failureSamples;
        provider.status =
          stats.failedCount || stats.formattingIncompleteCount ||
          stats.logLimitReached || stats.candidateLimitReached
            ? "partial"
            : "success";
        provider.incomplete = provider.status !== "success";
        provider.message = provider.incomplete
          ? "Allowance verification finished with incomplete or failed checks."
          : "Approval event discovery and current allowance checks completed.";

        if (provider.status === "success") {
          const originalProviders = Object.values(data.providers);
          const allOk = originalProviders.every(p =>
            p === provider || p.status === "success"
          );
          data.overallStatus = allOk ? "complete" : "partial";
        } else {
          data.overallStatus = "partial";
        }

        addDiscoveryFindings(data, stats);
      }

      renderReport(data);
    } catch (error) {
      errorBox.textContent =
        `${error.message || "Unable to reach the scan service."} If a batch failed, restart the scan; do not treat partial data as a complete result.`;
      errorBox.classList.remove("hidden");
    } finally {
      scanButton.disabled = false;
      scanButton.textContent = mode === "wallet" ? "Run wallet scan" : "Run contract scan";
    }
  });
})();
