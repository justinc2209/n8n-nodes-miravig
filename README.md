# n8n-nodes-miravig

> **This repository is a generated mirror, never edited directly.**
> Development of the shared detection engine (`rules.js`, the business
> glossary, national-ID checksums, etc.) happens in the
> [`miravig` monorepo](https://github.com/justinc2209/miravig), under
> `miravig-n8n/` — the same engine also powers the Miravig browser
> extension and web app. This repo exists purely so `n8n-nodes-miravig`
> has a clean, dedicated public history for npm/n8n verification purposes.
> Before every release, `miravig-n8n/`'s current tracked files are copied
> here wholesale (a fresh, single-commit snapshot — this repo's own git
> history before that point is not preserved across snapshots). See
> "Publishing" below for exactly why, and where to actually send a PR if
> you want to contribute a fix.

Community n8n node — detects sensitive data before text is sent to an LLM,
and reverses masking afterwards. Uses the same detection engine as the
Miravig browser extension and web app (`rules.js`, bundled unmodified as
`lib/rules-source.js`). The business glossary (term groups, see below)
follows the same principle: `lib/glossary-source.js` is bundled unmodified
from `extension-gardefou/glossary-groups.js`.

Prompt-quality checks (unfilled variables, unfilled placeholders,
JSON-wrapping risk, verbatim-preservation risk) are **not** part of this
node — they're a separate, standalone tool at `n8n-checker.html` (part of
the Miravig web app, not this npm package), which calls
`MiravigRules.detectVariables/detectUnfilledPlaceholders/detectJsonWrappingRisk/detectVerbatimPreservationRisk`
directly and never `detectSensitiveData`. Confirmed by reading
`n8n-checker.strings-2.js` directly, not assumed.

## Links

- [Full node documentation](https://miravig.com/mode-emploi-n8n.html) — installation, the Mask/Unmask operations, LLM node caveats, the business glossary, licensing.
- [Pricing](https://miravig.com/tarifs.html) — detection is free and unlimited; automatic masking and the business glossary require an active subscription (see "License caching" below).

## National ID coverage

`detectSensitiveData` recognizes national identification numbers for the
countries below, each behind its own `national-id-*` category. "Real
checksum" means a documented, publicly-verifiable check digit/character
algorithm is enforced — not just a plausible digit count. Detection always
fires on a checksum-valid match (never silent), but confidence is
conditioned on a nearby context keyword (the country's own term for the
number, e.g. "SVNR", "PESEL", "OIB"): `high` with context, `low` without.
Denmark and Latvia have no checksum at all (both countries dropped or never
had a reliable one on recent numbers) — for those two, the context keyword
is required just to fire at all, confidence capped at `medium`.

| Country | Number | Real checksum | Algorithm |
|---|---|---|---|
| Spain | DNI / NIE | Yes | mod 23, official check-letter table |
| Germany | Steuer-ID | Yes | ISO 7064 MOD 11,10 |
| Portugal | NIF | Yes | mod 11, weights 9→2 |
| Italy | Codice Fiscale | Yes | D.M. 12/03/1974 tables, mod 26 |
| Australia | TFN | Yes | weighted sum, multiple of 11 |
| Switzerland | AHV/AVS | Yes | EAN-13 |
| Canada | SIN | Yes | Luhn |
| Belgium | National register number | Yes | mod 97 (two eras, pre-/post-2000) |
| Austria | Sozialversicherungsnummer (SVNR) | Yes | weighted mod 11 |
| Norway | Fødselsnummer | Yes | double weighted mod 11 |
| Finland | Henkilötunnus (HETU) | Yes | mod 31, official letter table |
| Netherlands | BSN | Yes | "elfproef" (mod 11 variant, weight -1 on last digit) |
| Poland | PESEL | Yes | weighted mod 10 |
| Czechia / Slovakia | Rodné číslo | Yes | 10-digit number divisible by 11 (one shared category — the two countries never had separate numbering) |
| Croatia | OIB | Yes | ISO 7064 MOD 11,10 — the exact same function as German Steuer-ID (see collision note below) |
| Ireland | PPS Number | Yes | mod 23, weights [8,7,6,5,4,3,2], base 7-digit format only |
| Iceland | Kennitala | Yes | weighted mod 11 |
| Romania | CNP | Yes | fixed multiplier `279146358279`, mod 11 |
| Bulgaria | EGN | Yes | weighted mod 11 |
| Slovenia | EMŠO | Yes | weighted mod 11 (same family as the former Yugoslav JMBG) |
| Lithuania | Asmens kodas | Yes | primary/secondary weighted mod 11 (see collision note below) |
| Estonia | Isikukood | Yes | same algorithm as Lithuania |
| Denmark | CPR | **No** | format + context only — no reliable check digit on numbers issued since ~2007 |
| Latvia | Personal code | **No** | format + context only — random since 2017, no reliable check digit |

**Deliberately not covered**: Hungary, Cyprus, Malta, Luxembourg. No
sufficiently reliable public checksum source was found for these four at
implementation time — revisit separately if one turns up, rather than ship
something unverified.

**Known collision, handled explicitly, not a bug**: Croatia (OIB) and
Germany (Steuer-ID) run the exact same ISO 7064 MOD 11,10 function on the
same digit shape, so any checksum-valid OIB is *always* also a
checksum-valid Steuer-ID (and vice versa) — this is guaranteed, not a rare
coincidence. Same situation for Lithuania and Estonia, which share one
algorithm outright. `dedupeOverlaps()` in `rules.js` resolves this by
preferring whichever of the two has real context support (confidence) over
the fixed category-priority order, but only for `national-id-*` pairs — see
the comment on that function and the
`national-id-hr-no-context-collision-with-de` /
`national-id-ee-no-context-collision-with-lt` test cases in
`miravig-tests/cases/sensitive-data-national-id.json` for the exact
behavior when no context is present on either side (one signal still
shown, never silently dropped, attributed to whichever country is listed
first — an arbitrary but deterministic tie-break for a genuinely ambiguous
input).

## What changed in this version

A single node type (`Miravig`) with an **Operation** parameter (`Mask` /
`Unmask`) replaces the previous two separate node types
(`Miravig` + `Miravig — Démasquer`). A workflow still needs **two
instances** of this node — one in `Mask` mode before the LLM call, one in
`Unmask` mode after it — this did not change, only the packaging did.

This is a breaking change with no migration path, by design: the node has
never been published to npm and has no external users to date.

## State of this deliverable — read before considering this node "finished"

**Verified, tested, with certainty:**
- Core detection logic (`nodes/Miravig/lib/core.js`) and the business
  glossary with groups: `npm test` runs 4 suites (67 assertions total) —
  detection behaviors, masking (global/per-category, no confidence gate),
  anti-collision renumbering on re-execution, glossary group filtering,
  `caseSensitive`, the desync-checksum guard (including a regression test
  that reproduces the exact "reordered glossary" trap it exists to catch),
  and the ECDSA license-signature verification (with a locally generated
  test keypair — never the real production key, which never leaves the
  Worker).
- TypeScript compilation (`npm run build`): zero errors, `dist/` generated
  correctly.
- `rules.js` ported without logic changes (only a CommonJS export added at
  the end of the file).

**Verified against a real, running n8n instance (12/08/2026 test session)**
— n8n 2.34.5, package loaded via `N8N_CUSTOM_EXTENSIONS`, workflows built as
JSON fixtures and run through `n8n import:workflow` + `n8n execute --id=...`
(`--file` is listed by `n8n execute --help` but is non-functional in this
version — use `--id`), `/license/validate` replaced by a local mock signed
with a real (test-only) ECDSA keypair so the node's actual signature
verification code ran, not a stub:
- Detection without a license: full annotation, masking correctly withheld,
  explicit `gatingMessage`, zero network calls (no credential attached).
- Masking with a valid license: tokens applied, no gating warning.
- `{{ n8n }}` / `{{1.field}}`-style expressions in the analyzed text are
  never touched or flagged — only real sensitive data in the same string is
  detected/masked.
- Checksum guard, nominal case: full round-trip through a real Mask →
  Unmask two-node chain, `status: "match"`.
- Checksum guard, mismatch case: detected correctly, explicit warning —
  **but confirmed non-blocking** (`status: "success"`, not an error). This
  matches the "continue and warn" design decided above, but is an open
  question worth revisiting: is a non-blocking warning enough, or should a
  genuine glossary mismatch stop the workflow the way `On Unmask Failure`
  can? Not re-decided as part of this test session — flagged for explicit
  review.
- License cache fallback on network failure, **both directions**: a
  previously-confirmed "licensed" state stays applied through an outage
  (masking keeps working); a previously-confirmed "not licensed" state
  stays gated through an outage (no accidental free window). Verified by
  forcing a real execution against an unreachable port after backing the
  cache with a genuine signed record, not simulated.
- No cached state at all + network down on the very first execution:
  `Stop Workflow` genuinely halts the execution with a clear
  `NodeOperationError`; `Continue Anyway` proceeds with the gated
  feature(s) withheld and an explicit warning.
- The conditional `outputs` expression genuinely works: exactly one output
  connector when routing is off (the default), exactly two — with correct
  item routing — when explicitly enabled. This was the single biggest
  unknown from the design phase; confirmed structurally (not just "the
  second output was empty"), by inspecting the raw execution data.
- One license check network call per node execution regardless of batch
  size: confirmed with 50 items in a single execution against a mock that
  logs every call it receives — exactly one logged call, all 50 items
  correctly masked.
- A Worker that accepts the connection but never responds (as opposed to
  refusing it) used to hang the entire workflow execution indefinitely —
  `ctx.helpers.httpRequest` had no `timeout` set. Fixed: `timeout: 10000`
  on that call, confirmed to resolve into the *exact same* catch-path
  already covered above (cache fallback / `valid: null`), not a new
  behavior — a slow Worker now degrades the same way an unreachable one
  already did, just capped at 10s. Since the check only runs once per
  `LICENSE_CACHE_MS` window (15 minutes in production) thanks to the
  cache, an occasional 10s stall does not affect normal throughput.
- One hardcoded French label ("Terme du glossaire métier") was found
  leaking into node output for business-glossary detections — every other
  detection label is already locale-aware in the shared engine
  (`rules-source.js`'s `L(fr, en)` helper) and came back correctly in
  English. Fixed with a small French→English lookup table applied only at
  this node's output boundary (`Miravig.node.ts`, `translateDetections`),
  deliberately **not** by adding a locale parameter to
  `glossary-source.js` itself — that module is bundled unmodified from
  `extension-gardefou/glossary-groups.js` and shared, unchanged, with the
  extension and web app; translating it at the source would change
  behavior on two products this session never touched or tested.
- **A real LLM node between Mask and Unmask does drop the `miravig`
  field, confirmed against a real Google Gemini call (`Basic LLM Chain` +
  `Google Gemini Chat Model`, `@n8n/n8n-nodes-langchain`), not a
  hand-built item.** See "LLM node field survival" below for the full
  result and the required workaround.

**Still NOT verified — required before any submission:**
- Whether this node's shape (able to expose two outputs depending on
  configuration) still reads as "logic/flow control" to n8n's verification
  reviewers, even with routing off by default. The `outputs` expression
  itself now behaves correctly (see above) — what's unverified is n8n's
  own *classification* policy for a node like this, which requires
  checking n8n's node classification documentation directly, not just
  confirming the mechanism works.
- Icon (`miravig.svg`, referenced in the node description): still absent,
  to be provided before packaging.
- Menu of available fields (mentioned early on as a possible improvement):
  still not implemented — "Text to Analyze"/"Text to Unmask" remain free-text
  fields with a default expression, not a dynamic dropdown.

## Design decisions from the 12/08/2026 scoping session

**Account/quota system abandoned in favor of the license-key flow already
live in the extension/web app.** The original design assumed a Miravig
"account" (email + API key, `account.worker.js`'s `accounts` table,
`/account/create`, `/quota/check`). Verified directly in the repository:
this system has no user-facing signup surface anywhere in the product
(neither the web app nor the extension), is never called by any live
client (only by its own unit tests), and its Lemon-Squeezy-webhook linking
path is structurally orphaned (nothing ever creates the account row it
would attach a license to). Building it into a real, working feature was
estimated at 1-3 days with real risk of overrun (the webhook path has
never been exercised against real Lemon Squeezy traffic). Decision: skip
it. This node instead reuses the license-key flow already live in the
extension and web app (`license.js`, `/license/activate|validate|deactivate`)
— the credential asks directly for a Lemon Squeezy license key, the same
one from your purchase receipt.

**No free-tier quota / rate limit on detection.** Consequence of the
above: with no account system, there is no per-user counter to check
against, and reusing the extension's anonymous IP-based quota
(`/quota/anon-check`) would be a poor fit for a server-side node (an
n8n instance's outbound IP is shared across every workflow running on it,
and a single batch of items could exhaust a daily allowance meant for one
person's browser in one execution). Decision: detection stays complete and
unlimited for everyone, matching the product principle that *detection
itself is never a paid feature* — only automatic masking and the business
glossary are gated, and only by license validity, never by a request
count.

**No trial handling.** Lemon Squeezy requires a payment method up front
for this product's trial, so a "trial without friction" (the reason a
separate trial state would have been worth building) doesn't hold —
gating is a plain valid/invalid check against `/license/validate`, no
trial-specific branch.

**Business glossary detection itself is gated, not just its masking.**
Per the product's pricing model, a free user configuring a non-empty
Business Glossary gets no glossary-term detection at all (not even
annotation-only) unless licensed — unlike native categories (email, IBAN,
etc.), whose *detection* is always free; only their *masking* is gated.
If requested without a valid license, the node never passes the configured
terms to the detection engine, and reports this explicitly in the output
(`miravig.gatingMessage`) rather than silently ignoring the parameter.

**Fail-closed applies only to an explicit "invalid" answer from the
Worker, not to a network failure.** When Automatic Masking or a Business
Glossary are configured, "On License Check Failure" is a mandatory
parameter with no default value (`Stop Workflow` / `Continue Anyway`), but
it now only governs the case where the license status is genuinely
**indeterminate** — the licensing endpoint is unreachable *and* no
previously verified status is cached for this node. In that specific
case, "Continue Anyway" treats the gated feature(s) as not licensed for
this run (fail-closed, matching the browser extension's own
`license.js#validate`, `"network-error-fail-closed"`), while "Stop
Workflow" halts execution instead of guessing.

A network failure with a usable cached status (even a stale one, past its
15-minute freshness window, as long as its signature still verifies) does
**not** fall back to "not licensed" — it falls back to the **last
verified status**, valid or invalid, whichever it was. `On License Check
Failure` has nothing to decide in that case (there's no genuine
indeterminacy to stop or continue past); the output still carries an
explicit warning noting a stale cached status was used, and when.

An explicit "invalid" response from the Worker (reachable, answers
clearly) is never treated as indeterminate at all — it's a definitive
answer, handled the same way regardless of `On License Check Failure`:
gated features are not applied, with the plain "requires an active
subscription" message rather than a network-failure warning.

On the Unmask side, a license-check failure never blocks the workflow at
all (same "always continue, always warn" leniency as the checksum guard
below) — there is no equivalent mandatory parameter there, only `On
Unmask Failure`, which governs per-placeholder resolution failures, a
separate and orthogonal concern.

**"Route Flagged Items to a Second Output" replaces the old 3-way
"Behavior on Detection" dropdown's `route` option.** It is now an
independent boolean, off by default, shown only when `Behavior on
Detection = Pass Through and Annotate` (routing and stopping the workflow
are mutually exclusive by construction). This is a deliberate reduction of
the node's resemblance to an IF-style flow-control node when left at its
defaults — a single output unless explicitly opted into a second one.

## Glossary desync guard (checksum)

n8n shares no state between two separate node instances. The business
glossary is pasted manually into each instance (by design — no network
sync, no access to a user's real glossary); if the two instances ever
receive different glossaries, unmasking could previously fail *silently*
— against the product's founding principle that no correction should ever
happen invisibly.

The Mask-mode node now computes a checksum of the glossary it was given
(`core.js#glossaryChecksum` — a stable hash of the normalized term list:
id, term, sorted groups, case sensitivity; insensitive to incidental JSON
formatting differences) and attaches it to the item, at
`miravig.businessGlossary.checksum`. The Unmask-mode node recomputes its
own checksum from its own pasted glossary and compares:

| Situation | `miravig.checksum.status` | Behavior |
|---|---|---|
| Same glossary on both sides | `match` | No warning |
| Different glossary on both sides | `mismatch` | **Continues**, explicit warning in output |
| Upstream used a glossary, none configured here | `missing-local-glossary` | **Continues**, explicit warning |
| Text has `[TERM_G{N}]` placeholders but no checksum arrived (e.g. dropped by an LLM node in between) | `missing-upstream-checksum` | **Continues**, explicit warning |
| Nothing to compare (no placeholders, no configured glossary) | `not-applicable` | No warning |

Unlike `On Unmask Failure` (which can be configured to stop the workflow
on a genuine per-placeholder resolution failure), the checksum guard
**never blocks execution** — it is a lower-severity, always-visible signal
layered on top, not a second stop/continue choice to configure. This
mirrors the product's existing asymmetry: a failed Mask is a data-leak
risk (grave), a failed Unmask is, at worst, a visible `[TERM_G3]`
placeholder left in an otherwise-normal output (inconvenient, not a leak).

## LLM node field survival — confirmed against a real Gemini call

The checksum guard above only works if the `miravig` field (which carries
`businessGlossary.checksum`) actually survives the LLM/AI node sitting
between the Mask and Unmask instances. Tested against a real workflow —
`Miravig (Mask)` → `Basic LLM Chain` (fed by a `Google Gemini Chat Model`
sub-node, `@n8n/n8n-nodes-langchain`, real Gemini API call, real API key —
not mocked) → `Miravig (Unmask)` — with a prompt explicitly instructing
the model to preserve `[TERM_G{N}]`-style placeholders verbatim.

**Result: the field does not survive.** `Basic LLM Chain`'s output item is
`{ "text": "<the model's answer>" }` and nothing else — confirmed both by
reading its source (`ChainLlm.node.js` pushes
`{ json: formatResponse(response, ...) }`, built fresh from the model's
response, never spread from the incoming item) and by observing the
actual execution: the Mask node's output carried
`miravig.businessGlossary.checksum: "3aec460a8ace64d0"`, the Chain
node's output right after it contained only a `text` key, nothing else.

This is not specific to Gemini — `formatResponse()` is shared by every
model `Basic LLM Chain` can drive, and reconstructing the output object
from the model's response (rather than forwarding the input item's other
fields) is how the node is written. Any n8n AI/LLM node built on the same
pattern will drop `miravig` the same way.

**The Unmask node handled this exactly as designed, not silently:**
`miravig.checksum.status` came back `missing-upstream-checksum`, with the
explicit warning text ("...the LLM node between Mask and Unmask may not
have carried the 'miravig' field forward..."), execution continued, and —
because placeholder resolution reads the *pasted* Business Glossary
parameter, not the checksum field, which is a desync signal only, never
the resolution mechanism — `[TERM_G1]` still resolved correctly to
`ProjetPhenix2026`. The gap is real (no way to detect an *actual*
glossary mismatch when the checksum never arrives at all — only a
generic "could not verify" warning), but it degrades to a warning, never
a silent wrong answer or a crash.

**Workaround, also verified against the same real Gemini workflow**: add
an `Edit Fields` (Set) node right after the LLM node, before Unmask, that
copies the `miravig` field back in from the Mask node by name —
**`Include Other Fields` must be enabled**, or the Edit Fields node
itself drops the LLM's `text` output the same way the LLM node dropped
`miravig` (this tripped up the first attempt at writing this workaround —
worth calling out explicitly since it's an easy way to "fix" the checksum
warning while silently breaking the text the Unmask node needs to read).

| Field | Value |
|---|---|
| Name | `miravig` |
| Type | Object |
| Value | `={{ $('Miravig (Mask)').item.json.miravig }}` |
| Include Other Fields | **On** |

With this node in place, the same workflow's checksum came back
`match`, no warning, and `[TERM_G1]` still resolved correctly — confirming
the workaround, not just theorizing it. Replace `Miravig (Mask)` with
whatever you actually named your Mask-mode node instance.

## Business Glossary (JSON)

One shared parameter, used by both Mask and Unmask instances of the node
— same format either way, no reconciliation needed:

```json
[
  { "term": "ProjectPhoenix2026", "id": 12, "groups": ["General", "Project Alpha"] },
  { "term": "LegacyClient" }
]
```

- `id` — optional, but recommended whenever available (e.g. a CSV export
  from the web app/extension glossary already has a stable number column).
  Falls back to array position (1-based) when absent, which only works if
  both node instances receive the exact same JSON in the exact same order
  — the checksum guard above exists specifically to catch it when they
  don't.
- `groups` — optional, **Mask-mode only**. A term without `groups` is
  always active regardless of "Active Glossary Groups" (backward-compatible
  with flat, ungrouped glossaries). Unmask mode ignores groups entirely —
  placeholder resolution always considers the full glossary, since a
  placeholder already encodes which term it refers to by number.
- `caseSensitive` — optional, defaults to `false`.

**Requires an active Miravig subscription in both modes** — see
"Design decisions" above. A free user with a non-empty glossary gets an
explicit `gatingMessage` in the output instead of silent detection.

## Example 2-instance workflow

```
[Upstream node] → [Miravig (Operation: Mask)] → [... LLM node ...] → [Miravig (Operation: Unmask)]
```

- Mask instance: `Text to Analyze` = `={{ $json.text }}`, `Automatic
  Masking` on, `Categories to Mask` includes `business-term` if using the
  glossary, `On License Check Failure` set explicitly.
- Unmask instance: `Text to Unmask` = `={{ $json.miravigOutputText }}`
  (default), same `Business Glossary (JSON)` pasted as the Mask instance,
  `On Unmask Failure` set explicitly (`Stop Workflow` recommended, to
  surface exactly the kind of desync the checksum guard flags).

## License caching

When Automatic Masking or the Business Glossary are configured with a
license key present, the node checks `/license/validate` at most once
every 15 minutes per node instance (cached in n8n's `workflowStaticData`,
keyed per node — not shared across different Miravig nodes in the same
workflow). This is intentionally shorter than the 72h cache used by the
browser extension/web app: an n8n workflow can run unattended for days
without a human reopening any panel, so a cancelled subscription needs to
propagate faster than in an interactive surface. The cached record is
signed by the Worker (ECDSA P-256) and re-verified locally before being
trusted — a value simply read back from `workflowStaticData` is never
trusted on its own, since that data is stored with the workflow (visible
in its JSON export), unlike an encrypted credential.

## Development

```bash
npm install
npm run build
npm test
```

## Publishing — this repo is recreated fresh from the monorepo, never patched in place

This is the second half of the incident that started on 2026-08-24 in the
`miravig` monorepo (see that repo's `SESSION_LOG.md`, entries of
2026-08-24 and 2026-08-25 for the full account): `0.1.0` was published
with a stale `dist/`, silently shipping a pre-fix, less-secure
license-verification path. The fix landed in the monorepo, but it revealed
a structural risk that outlives that one incident: `nodes/Miravig/lib/*.js`
in the monorepo's `miravig-n8n/` is a **copy** of the real source of truth
(`extension-gardefou/rules.js` and friends, synced by
`miravig-tests/build.js`) — a copy that can silently drift out of date if
anyone forgets to resync it before a release.

That resync script (`miravig-tests/build.js`) reaches outside
`miravig-n8n/` into sibling directories of the monorepo (`extension-gardefou/`,
`Miravig V3/`) that **do not exist in this standalone repository** — it
cannot run here, by construction, not by oversight. Running `npm run build`
alone in this repo is therefore safe here in a way it wasn't safe in the
monorepo: there is nothing left to silently drift out of sync, because
this repo's `nodes/Miravig/lib/*.js` is never edited directly — it's
freshly copied from the monorepo (where the resync already happened)
immediately before every release, and never touched in between.

**The actual release procedure**, done from the monorepo:
1. In `miravig/miravig-n8n/`: bump the version, run
   `node miravig-tests/build.js` then `node miravig-tests/build.js --check`
   (from the monorepo root) to guarantee the copy is current with the
   shared engine.
2. Copy the monorepo's tracked `miravig-n8n/` files into this repo,
   wholesale, replacing everything except this repo's own
   `package.json` `repository`/`homepage` fields and this
   `.github/workflows/npm-publish.yml` (both intentionally differ from the
   monorepo's copies — no `directory` field, no `miravig-tests/build.js`
   step, since neither applies to a standalone repo).
3. Commit here as a single snapshot, push.
4. Publish from **this** repo's release (`release: published` triggers
   `.github/workflows/npm-publish.yml`, OIDC trusted publishing,
   `npm publish --provenance`).

The monorepo's own `.github/workflows/npm-publish.yml` has been removed —
this repo is now the only place a real `npm publish` can be triggered from,
so there is exactly one release pipeline for this package, not two that
could race or diverge.
