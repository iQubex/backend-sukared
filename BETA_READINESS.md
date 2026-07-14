# SukaRed 1.0 Controlled Public Beta Readiness

Date: 2026-07-15

## Decision

The compatibility gate for a controlled beta has passed for Light, Light+, and Good. Pro remains experimental. Hell, Blatant, and Fatality remain unavailable.

Good is the recommended default because it applies selective VM protection while retaining safe non-VM fallback. No profile claims universal Lua/Luau compatibility.

## Public Profile Contracts

| Profile | Status | VM policy | Intended use |
| --- | --- | --- | --- |
| Light | Available | Off | Fastest, smallest, broad compatibility |
| Light+ | Available | Off | Stronger safe AST/string transforms |
| Good | Available / Recommended | Selective, budgeted | Balanced protection and compatibility |
| Pro | Experimental | Aggressive, budgeted | Maximum eligible coverage with safe fallback |
| Hell | Unavailable | Disabled | Not part of the public beta |
| Blatant | Unavailable | Disabled | Not part of the public beta |
| Fatality | Unavailable | Disabled | Not part of the public beta |

Light and Light+ are intentionally non-VM profiles. Good and Pro keep unsupported, sensitive, or over-budget functions as valid transformed Luau instead of rejecting the entire build.

## Acceptance Matrix

The permanent matrix executes original and generated code with native Luau and compares exact observable output. It covers arithmetic, closures/upvalues, callback/event behavior, coroutine/metatable/vararg behavior, member and method calls, typed Luau preprocessing, a controlled MentalityUI-style fixture, the Infinite Yield-style mega fixture, and 100/250/500/1000-function corpora.

- Builds passed: 48 / 48
- Runtime executions passed: 48 / 48
- Semantic mismatches: 0
- Runtime backend: native Luau CLI

| Profile | Fixtures | VM functions | Fallback functions | Max build | Max output | Max slowdown | Peak runtime memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Light | 12 / 12 | 0 | 3,881 | 5,721.83 ms | 606,174 bytes | 1.32x | 23,580,672 bytes |
| Light+ | 12 / 12 | 0 | 3,881 | 11,564.03 ms | 1,469,883 bytes | 2.16x | 62,365,696 bytes |
| Good | 12 / 12 | 113 | 3,768 | 1,447.35 ms | 164,824 bytes | 1.06x | 11,157,504 bytes |
| Pro | 12 / 12 | 370 | 3,511 | 3,451.36 ms | 352,542 bytes | 1.18x | 15,966,208 bytes |

All 1000-function builds completed inside the public 30-second build, 8 MiB output, and 512 MiB worker-heap budgets. The totals above include every fixture and therefore should not be interpreted as a single-script coverage percentage.

## Infinite Yield-Style Fixture

Every public profile reached all 9 controlled runtime checkpoints with zero semantic mismatches.

| Profile | Discovered | Eligible | Virtualized | Fallback | Budget limited | Build | Output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Light | 37 | 0 | 0 | 37 | 0 | 44.17 ms | 35,825 bytes |
| Light+ | 37 | 0 | 0 | 37 | 0 | 73.27 ms | 98,226 bytes |
| Good | 37 | 37 | 12 | 25 | 18 | 74.94 ms | 52,297 bytes |
| Pro | 37 | 37 | 37 | 0 | 0 | 149.07 ms | 140,412 bytes |

The checkpoints cover startup order, command registration, aliases/plugins, callback mutation, event connections, environment access, and mocked executor/API fallback behavior.

## Selection And Fallback

Good no longer uses first-N selection. It scores candidates using callback relevance, branches and loops, meaningful constants, reference count, estimated VM cost, hot-loop sensitivity, environment sensitivity, and coroutine/yield sensitivity. Metadata reports `protectionValueScore`, `estimatedVmCost`, and `selectionReason` for diagnostics.

Every candidate is classified as one of:

- VM eligible
- non-VM compatible
- dedicated interpreter required
- coroutine/yield sensitive
- environment sensitive
- unsupported syntax
- over profile budget

Unknown executor APIs remain ordinary globals. They are not implemented or emulated by SukaRed. Receiver evaluation, callback identity, argument order, multiple returns, nil fallback chains, and externally visible environment behavior are preserved by the tested transformations.

## Stability Changes

- Fixed colon-call rewriting so the receiver is evaluated once and still becomes `self`.
- Added scope/value-aware VM selection and explicit fallback metadata.
- Added callback, event, environment, typed Luau, method, and large-script regressions.
- Restricted public profiles to conservative decoder families; experimental decoder families remain Pro-only.
- Fixed generic Luau type-alias preprocessing and duplicate-semicolon generation.
- Added anonymous bounded telemetry without source, output, decoded strings, or source fragments.
- Public timeout/output errors recommend a lighter profile and do not return partial output.
- Failed builds do not commit credits under the tested transaction provider.

## Public Limits

- Request body: 2 MiB
- Source: 1 MiB
- Generated output: 8 MiB
- Build timeout: 30 seconds
- Worker heap: 512 MiB
- Build concurrency: 2
- Queue depth: 8

## Remaining Limitations

1. Unsupported or VM-unsafe AST forms remain transformed Luau through safe fallback. The exact node and reason are returned in technical metadata; they are not advertised as VM-protected.
2. Environment-sensitive and coroutine/yield-sensitive functions may require non-VM or dedicated-interpreter handling depending on profile budgets.
3. Executor APIs are passed through and require the target runtime to provide them.
4. Typed Luau support is limited to the preprocessor/parser forms covered by regression tests; this is not complete language-server-level Luau type support.
5. Roblox engine behavior is represented by controlled mocks in CI. The service does not execute arbitrary customer scripts inside a live Roblox environment.

## Exact Beta Blockers

The code and compatibility gates are ready for a controlled, non-credit test cohort. A credit-backed public launch is still blocked by the production account/credit provider: the current transaction tests use an in-memory provider and prove idempotency/rollback behavior, not a production ledger integration.

Arbitrary submitted Roblox code is not runtime-executed before charging because no side-effect-safe Roblox sandbox is configured. Parse, generated-output validation, and controlled fixture differential tests remain active.

## Operational Recommendation

Use Good as the default. Offer Light for maximum compatibility/speed, Light+ for stronger non-VM protection, and Pro only with the exact warning: `Experimental profile. Test generated output before release.` Keep Hell, Blatant, and Fatality disabled.

Run the release gate with:

```powershell
npm run test:regressions
npm run test:service
npm run test:semantic
npm run test:public-beta
```
