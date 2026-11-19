NEXORASCOPE V2 — REVIEW BUILD

This package preserves the supplied static content site and adds a separate public-address scanner. It does not connect wallets, request signatures, request secrets from visitors, or revoke approvals.

FILES
- Existing site pages and assets/site.css: preserved with scanner navigation links.
- scanner.html: new Wallet / Contract scanner page.
- assets/scanner.css and assets/scanner.js: responsive UI and API client.
- worker/src/index.js: Worker API v2 source.
- worker/README.md and worker/DEPLOYMENT.md: setup and validation.

IMPORTANT DEPLOYMENT SAFETY
This is a review build, not a production deployment. Do not replace the live site until you have tested it on a preview deployment and confirmed the Worker responses with live provider data. Keep the existing Cloudflare Pages production deployment unchanged during review.

The frontend currently calls the existing Worker URL configured in assets/scanner.js. The Worker CORS allowlist includes the production apex and www hostnames; add the exact Cloudflare Pages preview hostname to the allowlist before preview-browser testing. Change API_URL only if the Worker hostname changes.

Provider behavior
- Provider statuses are separated from findings. Missing data is not treated as safe or as proof that no approvals exist.
- A score is null / Insufficient data when no positive weighted finding is present.
- Successful provider responses are cached briefly (GoPlus 45 seconds; Etherscan 120 seconds), with per-isolate in-flight request coalescing and a single short retry for rate-limit / transient upstream errors. Cloudflare Cache API behavior is best-effort and is not a global distributed lock.
- Approval field extraction is best-effort and only displays fields actually returned by GoPlus. Review against real API payloads before relying on completeness.

NEXT VALIDATION REQUIRED
1. Test each supported chain against known wallet and contract addresses.
2. Compare approval records with raw GoPlus payloads for ERC-20, ERC-721 and ERC-1155.
3. Verify GoPlus authentication and quota behavior for the account plan.
4. Review privacy notice, logs, retention, and third-party data handling before public launch.
