# NexoraScope Security Worker v2

## Routes
- `POST /api/scan` — wallet or contract scan.
- `GET /api/health` — basic service health/version.

## Request
```json
{ "mode": "wallet", "chainId": "1", "address": "0x..." }
```
`mode` is `wallet` or `contract`; supported chain IDs are `1`, `56`, and `8453`.

## v2 response additions
- `schemaVersion: 2`, `overallStatus`, `providers`, and `approvals`.
- Provider states: `success`, `rate_limited`, `auth_error`, `quota_exceeded`, `unavailable`, `error`, `unknown`.
- `score: null` means insufficient positive weighted evidence; it is not a zero-risk score.
- Approval records expose best-effort `standard`, `token`, `tokenAddress`, `spender`, `allowance`, `tokenId`, `risky`, and `rawRisk`. Missing fields remain blank.

The Worker allows browser requests from `https://nexorascope.xyz` and `https://www.nexorascope.xyz` via CORS. If your Pages preview uses another hostname, add that exact origin to the allowlist before testing the preview.

## Secrets
Set `ETHERSCAN_API_KEY` as a Worker secret. `GOPLUS_TOKEN` is optional and should only be set if your GoPlus account provides a token. Never place secrets in frontend files or commit them to GitHub.

## Caching / limits
Successful GoPlus responses are cached for 45 seconds and Etherscan source metadata for 120 seconds. Failed responses are not cached as successful data. Identical in-flight requests are coalesced within a Worker isolate. One bounded retry is attempted for rate-limited/transient upstream failures. Cache API is best-effort and does not provide a global lock across all isolates.

The GoPlus response schema can vary by endpoint and chain. The approval normalizer is intentionally conservative; compare it with real provider payloads before treating the table as exhaustive.
