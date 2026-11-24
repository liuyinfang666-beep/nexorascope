# Worker v2 deployment checklist (Cloudflare Dashboard)

1. Open Cloudflare Dashboard → Workers & Pages → `nexorascope-security-api`.
2. Keep the existing production version available for rollback. Create a new deployment/version from `worker/src/index.js` using the Dashboard editor or upload workflow supported by your account. Do not change the production route until preview tests pass.
3. Confirm the existing secrets remain configured: `ETHERSCAN_API_KEY`; optionally `GOPLUS_TOKEN` if supplied by GoPlus. Do not paste secret values into chat, source files, or GitHub.
4. Confirm CORS allows the exact Pages preview origin if testing from a preview hostname; production apex and `www` origins are allowed by default.
5. Test `GET /api/health`; expected JSON includes `status: ok` and `apiVersion: 2`.
6. Test `POST /api/scan` with a known public address and each chain. Confirm `providers` contains separate entries and `score` can be `null`.
7. Compare approval records with the raw GoPlus payload. Confirm ERC-20, ERC-721 and ERC-1155 independently; a missing record is not proof that no approvals exist.
8. Only after all tests pass, promote the Worker version while retaining the existing route `nexorascope.xyz/api/*`.

## Pages preview
1. Upload the package to a separate Git branch or Cloudflare Pages preview branch; do not overwrite the production branch yet.
2. Ensure the project root contains `index.html`, `scanner.html`, and `assets/`.
3. Open the preview `/scanner.html`; test wallet and contract modes on all three networks.
4. Verify mobile layout, keyboard access, error states, and that the educational checkup still works.
5. Check that the homepage and article links navigate correctly.

## GoPlus rate-limit troubleshooting
- Check the Provider status panel: `rate_limited` indicates HTTP 429 or a provider rate-limit message; `auth_error` indicates authentication/permission problems; `quota_exceeded` indicates a quota/plan limit message.
- Keep scan requests low during validation. The Worker applies short successful-response caching, in-isolate request coalescing, and one bounded retry; these measures reduce duplicate traffic but cannot raise the upstream account quota.
- If 429 responses persist at low traffic, review the GoPlus account/API plan and contact GoPlus support to confirm endpoint limits, supported chains, authentication requirements and whether a higher quota is available. Do not assume an API key/token alone raises the quota.
- Do not convert rate-limited or unavailable responses into a clean/low-risk result.
