# NexoraScope Security Worker

## Routes
- `POST /api/scan` — wallet or contract scan.
- `GET /api/health` — basic service health/version.

## Request
```json
{ "mode": "contract", "chainId": "1", "address": "0x..." }
```
`mode` is `wallet` or `contract`; supported chain IDs are `1` (Ethereum), `56` (BNB Chain), and `8453` (Base).

## Response
- `schemaVersion: 3`, `overallStatus`, `providers`, `findings`, and `approvals`.
- Provider states distinguish success, partial or unavailable upstream results, rate limits, authentication errors, and quota errors.
- Contract scans validate that GoPlus returned a successful response and a record for the exact requested contract address.
- Contract reports track coverage across 10 core checks. Fewer than 5 returned core fields marks the scan incomplete and suppresses the numeric score.
- A missing field is unknown, not a negative risk finding. A numeric indicator score is not a probability, audit grade, or guarantee of safety.
- Explorer source verification only indicates that the explorer reports verified source metadata. It is not a security audit; proxy implementations and privileged controls still require review.
- Wallet approval discovery may be paginated or incomplete. Missing log or allowance data must not be interpreted as proof that no approvals exist.

## CORS
The Worker allows browser requests from `https://nexorascope.xyz` and `https://www.nexorascope.xyz`. Pages preview hostnames matching `*.nexorascope.pages.dev` are also allowed.

## Secrets
Set `ETHERSCAN_API_KEY` as a Worker secret. `GOPLUS_TOKEN` is optional and should only be set if your GoPlus account provides a token. Never place secrets in frontend files or commit them to GitHub.

## Caching / limits
Successful GoPlus responses are cached for 45 seconds and Etherscan source metadata for 120 seconds. Failed responses are not cached as successful data. Identical in-flight requests are coalesced within a Worker isolate. Transient upstream failures may be retried. Cache API is best-effort and does not provide a global lock across all isolates.

The GoPlus response schema can vary by endpoint and chain. Compare the report with real provider payloads on every supported chain before treating it as production-validated.
