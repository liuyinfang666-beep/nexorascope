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
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const statusText = status => ({success:"Success",rate_limited:"Rate limited",auth_error:"Authentication error",quota_exceeded:"Quota exceeded",unavailable:"Unavailable",error:"Request error",unknown:"Unknown"}[status] || status || "Unknown");
  function renderReport(data) {
    results.classList.remove("hidden");
    document.getElementById("resultMeta").textContent = `${data.chain || chainInput.options[chainInput.selectedIndex].text} · ${data.mode} · ${data.target} · ${new Date(data.checkedAt).toLocaleString()}`;
    const badge = document.getElementById("overallBadge");
    badge.className = `status-badge ${data.overallStatus || "unavailable"}`;
    badge.textContent = data.overallStatus === "complete" ? "Provider checks completed" : data.overallStatus === "partial" ? "Partial results" : "No provider results";
    document.getElementById("scoreValue").textContent = data.score === null || data.score === undefined ? "—" : `${data.score}/100`;
    document.getElementById("scoreDescription").textContent = data.score === null || data.score === undefined ? "Insufficient data — no indicator score can be calculated." : "Indicator score based on positive findings returned by the configured checks; not a safety probability.";
    const providerGrid = document.getElementById("providerGrid");
    providerGrid.innerHTML = Object.entries(data.providers || {}).map(([key, p]) => `<div class="provider-card"><strong>${escapeHtml(key.replaceAll("_"," "))}</strong><span class="provider-state ${escapeHtml(p.status)}">${escapeHtml(statusText(p.status))}</span><p>${escapeHtml(p.message || "")}${p.httpStatus ? ` · HTTP ${escapeHtml(p.httpStatus)}` : ""}${p.cache ? ` · cache: ${escapeHtml(p.cache)}` : ""}</p></div>`).join("") || `<div class="provider-card">Provider status was not supplied.</div>`;
    const findings = Array.isArray(data.findings) ? data.findings : [];
    document.getElementById("findingsList").innerHTML = findings.map(f => `<article class="finding ${escapeHtml(f.level || "neutral")}"><h4>${escapeHtml(f.title)}</h4><p>${escapeHtml(f.detail)}</p></article>`).join("") || `<article class="finding neutral"><p>No findings were returned. This is not evidence of safety.</p></article>`;
    const approvals = Array.isArray(data.approvals) ? data.approvals : [];
    const block = document.getElementById("approvalsBlock");
    block.classList.toggle("hidden", data.mode !== "wallet");
    document.getElementById("approvalsBody").innerHTML = approvals.length ? approvals.map(a => `<tr><td>${escapeHtml(a.standard)}</td><td>${escapeHtml(a.token || a.symbol || "—")}</td><td>${escapeHtml(a.tokenAddress || "—")}</td><td>${escapeHtml(a.spender || "—")}</td><td>${escapeHtml(a.allowance || "—")}</td><td>${escapeHtml(a.tokenId || "—")}</td><td>${a.risky ? "Provider flagged" : (a.rawRisk ? escapeHtml(a.rawRisk) : "Not reported")}</td></tr>`).join("") : `<tr><td colspan="7">No parseable approval detail was returned. This does not prove that no approvals exist.</td></tr>`;
    document.getElementById("disclaimer").textContent = data.disclaimer || "Automated indicators only; not an audit or guarantee.";
    results.scrollIntoView({behavior:"smooth",block:"start"});
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
    scanButton.textContent = "Scanning…";
    try {
      const response = await fetch(API_URL, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({mode,chainId:chainInput.value,address}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Scan request failed (HTTP ${response.status})`);
      renderReport(data);
    } catch (error) {
      errorBox.textContent = `${error.message || "Unable to reach the scan service."} Check that the Worker is deployed and its route is active, then try again.`;
      errorBox.classList.remove("hidden");
    } finally {
      scanButton.disabled = false;
      scanButton.textContent = mode === "wallet" ? "Run wallet scan" : "Run contract scan";
    }
  });
})();
