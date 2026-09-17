# TrUAPI migration — decision log

Every ruling made while executing `plans/2026-09-17-truapi-migration.md`, kept
because several of them override the plan or the spec and a later reader will
otherwise re-derive them from scratch. Preserved verbatim from the execution
ledger; the `Ruling:` lines are the load-bearing part.

Spec: docs/superpowers/specs/2026-09-17-truapi-migration-design.md (read — binding authority)
Branch: truapi-migration (in place, user chose option 2 over a worktree)
Baseline: build green, `pnpm test` 22/22 at 42fe1a2
Workspace: .superpowers/sdd/2026-09-17-truapi-migration/ (gitignored at 4cad27c)

## Global Constraints (verbatim from plan)

- Exact versions: `@parity/truapi@0.17.0`, `@parity/truapi-host@0.17.0`, `@parity/truapi-provider@0.2.0`, `polkadot-api@3.1.0`.
- No external signer/CLI/bot/host-papp/custom WASM. Nothing leaves the page or needs network at test time.
- All `@novasamatech/*` dependencies removed by the end.
- `//Alice` = `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`, `//Bob` = `5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty`.
- `RemoteMessage` variant order is wire protocol; indices 14–23 pinned.
- People genesis = 32 bytes of `0x01`.
- Final task updates package.json + CHANGELOG.md + forum-post.md + README.md together.

## Pre-flight conflict scan

### Cross-task pairs (shared file or interface)

| Tasks | Produced → consumed | Finding |
| --- | --- | --- |
| 1 → 10,11,12 | `PEOPLE_GENESIS_HASH`, `ZERO_HASH` | clean |
| 2 → 5,8,9,12 | `deriveDev`, `deriveFromUri`, `DevKeypair` | clean |
| 3 → 12 | `encodeExternalPairedSession(ExternalSessionOptions)` | T12 passes a session carrying extra `peerEncSecret`; it is a variable, not a fresh literal, so TS excess-property checking does not apply — clean |
| 4 → 9 | `sessionAeadKey`, `seal`, `open` | clean |
| 5 → 7,9 | `encodeStatement`, `decodeStatement`, `signStatement`, `matchesTopics`, `TopicFilterKind` | clean |
| 6 → 9 | `StatementData`, `VersionedRemoteMessage`, `REMOTE_MESSAGE_VARIANTS` | clean |
| 7 → 9,10,11,12 | `LoopbackStore` (`connect`/`publish`/`onSubmit`) | clean |
| 8 → 9 | `buildSignedV4Extrinsic`, `signRawBytes` | clean |
| 9 → 12,14 | `createSsoResponder` → `getSigningLog`/`clearSigningLog`/`dispose` | clean |
| 10 → 11 | `callbacks/index.ts` imports `./chain.js` | **CONFLICT A** — `chain.ts` is not created until Task 11 |
| 10 → 12,14 | `createHostState`, `HostState` | clean |
| 11 → 10 | `createChainCallbacks({store,networks})` → `{ chain: { connect } }` | composition body underspecified in T10; resolved by Ruling A |
| 12 → 14 | `buildControlApi({state,responder,runtime,iframeHost})` | **CONFLICT B** — referenced in T12, only specified in T14; T12 step 4 typechecks |
| 12 → 13 | `dist/host/host-runtime.js` served at `/host-runtime.js` | clean |
| 13 → 14 | `pnpm build && pnpm test` | clean |
| 14 → 15 | `window.__TEST_HOST__.getSigningLog()` | clean |

### Per-task internal consistency

| Task | Finding |
| --- | --- |
| 1 | Removes `@novasamatech/*` while `src/types.ts` still imports them → **CONFLICT D** (typecheck red until T12) |
| 2 | clean |
| 3 | clean |
| 4 | clean |
| 5 | clean (field indices now concrete) |
| 6 | variant list concrete; payload codecs delegated to `@parity/truapi` generated types — acceptable |
| 7 | clean |
| 8 | test does `import { sr25519 }` from `@scure/sr25519` → **CONFLICT C**; package exports `verify` directly (verified: `HDKD, __tests, fromKeypair, getPublicKey, getSharedSecret, secretFromSeed, sign, verify, vrf`) |
| 9 | clean after the import fix already applied to the plan |
| 10 | see Conflict A |
| 11 | clean |
| 12 | see Conflict B |
| 13 | clean |
| 14 | clean |
| 15 | clean |
| 16 | clean |

### Rulings

Ruling A: Task 10 creates `src/browser/callbacks/chain.ts` itself as a minimal router — loopback for `PEOPLE_GENESIS_HASH`, throw otherwise — and Task 11 replaces its body with the WS route plus its own tests. Reason: T10's own test dispatches through `createHostCallbacks`, so the module must exist at T10. Cost if wrong: Task 11 rewrites a file instead of creating it — trivial rework.

Ruling B: Task 12 implements `buildControlApi` in full, per the member list written in Task 14 Step 1; Task 14 is reduced to the Playwright fixture, `src/index.ts` exports, and the export smoke tests. Reason: the forward reference makes Task 12's typecheck gate unsatisfiable, and the control API belongs beside the runtime state it closes over. Cost if wrong: Task 12 is larger than planned and Task 14 smaller; no functional difference.

Ruling C: Task 8's test uses `import { verify } from '@scure/sr25519'` and calls `verify(message, signature, publicKey)`. Reason: verified against the installed package — there is no `sr25519` namespace export. Cost if wrong: the test fails immediately and visibly.

Ruling D: The intermediate typecheck/build breakage between Task 1 and Task 12 is accepted. No task between them runs `pnpm typecheck` or `pnpm build`; Task 12 Step 4 is the first green gate. Reason: the dependency swap must precede the rewrite that removes the old imports. Cost if wrong: an implementer runs a build early, sees unrelated red, and wastes time — mitigated by stating it in every dispatch from Task 1 to Task 11.

## Progress

Note: user went AFK mid-run and instructed continuous execution to completion
(implement -> review -> fix -> review until clean), no check-ins. Rulings are
mine to make; all are recorded here.

Rulings A, B and C were folded into the plan text itself (commit below) so the
extracted task briefs are self-consistent. Ruling D stays dispatch-carried.

Task 1: implemented (commit 1ee2462). Review base 6c1b9df (my own docs commit
6c1b9df sits between the recorded BASE 4cad27c and the implementer's work, so
the review was scoped to exclude it).
Task 1: review — spec ❌, 1 Critical: pnpm-lock.yaml specifiers still carry `^`
for 8 deps while package.json pins exact; `pnpm install --frozen-lockfile`
fails with ERR_PNPM_OUTDATED_LOCKFILE, which is what all three CI workflows run.
Task 1: ⚠️ resolved by controller — reviewer flagged that the CLAUDE.md release
checklist (version/CHANGELOG/forum-post/README) is untouched. Task 16 owns it;
not a gap in this task.
Task 1: minor (approved, not deferred): vitest.config.ts `passWithNoTests: true`
is a justified addition — vitest 5 exits 1 with no spec files, and the brief's
gate requires exit 0. Keep it.
Task 1: fix round 1/5 dispatched to the original implementer.
Task 1: fix round 1/5 (1 addressed, 0 open; commits 1ee2462..1a349ab)
Task 1: complete (commits 6c1b9df..1a349ab, review clean)
Task 2: BASE 1a349ab
Task 2: implemented (commit dfe1153). Review: spec OK, quality Approved, no
Critical/Important.
Task 2: minor (deferred): dev-accounts.ts:91 `DEV_MINI_SECRET as unknown as
string` is an unnecessary double cast (the export is already a string literal
type).
Task 2: minor (deferred): dev-accounts.ts:89-97 `toBytes` has an unused
Uint8Array branch.
Task 2: minor (deferred): no tests cover the two throw paths (over-long
junction, unsupported soft URI). Plan-mandated omission.
Task 2: Ruling: deriveFromUri keeps hard-junction-only semantics, so
`//Alice//myapp.dot/0` parses as hard(Alice) + hard("myapp.dot/0"). The
pre-migration @polkadot/keyring path parsed the same string as hard(Alice) +
hard(myapp.dot) + soft(0), so PRODUCT-account addresses change even though
//Alice and //Bob (the binding constraint) do not. Accepted because the new
convention is internally consistent with Task 12's resolveProductAccount, which
builds exactly these URIs, and because full Substrate URI parsing would add soft
derivation the plan never specified. Cost if wrong: any consumer holding funded
product accounts at the old derived addresses (host-playground in particular)
must refund or re-derive them. CARRY INTO TASK 16: the CHANGELOG and forum post
must state that product-account addresses change in 0.13.0.
Task 2: complete (commits 1a349ab..dfe1153, review clean)
Task 3: BASE dfe1153
Task 3: implemented (commit ac6de72). Review: spec OK, quality Approved, no
Critical/Important. Reviewer independently verified field order and widths
against the upstream Rust SessionInfo/SsoSessionInfo and against scale-ts's
runtime encoding semantics.
Task 3: Ruling: promoting all three Minors into one fix round instead of
deferring them. Normally minors are deferred, but spec Risk 1 names
"private SCALE layouts" as the migration's biggest risk and states the
mitigation as the version tag plus a test that detects drift. A pinned
byte-length assertion is exactly that mitigation and costs ~3 lines; the
silent-truncation gap in scale-ts Bytes(n) is the same silent-corruption class
the module's own header claims to guard against. Arithmetic cross-check: SSO
block = 64 + 9*32 = 352, matching the Rust's own SSO_ENCODED_LEN pin, and the
full external-paired blob = 456 bytes, matching what the pre-plan spike observed
the core accept. Cost if wrong: three lines of test and a length guard that
later prove unnecessary.
Task 3: fix round 1/5 dispatched to the original implementer.
Task 3: fix round 1/5 (3 addressed, 0 open; commits ac6de72..20ef244)
Task 3: complete (commits dfe1153..20ef244, review clean). Layout now pinned at
SSO 352 / blob 456 bytes, so upstream drift fails loudly.
Task 4: BASE 20ef244
Task 4: implemented (commit 1099188). Review: spec OK, quality Approved, no
Critical/Important. Reviewer verified the KDF against the upstream Rust AND the
installed @noble internals: zero-salt default, empty info, raw 32-byte X25519
IKM, 12-byte nonce, matching error wording.
Task 4: minor (deferred): crypto.ts:29-31 all-zero check is unreachable with
@noble/curves 2.4.0 (the library throws first); it reads as the primary guard
but is defense-in-depth. Worth a code comment or deletion.
Task 4: minor (deferred): crypto.ts:24-28 catch-all relabels any
getSharedSecret failure as "invalid X25519 public key", including a malformed
caller-side encSecret. Could cost debugging time in Task 9/12 wiring.
Task 4: minor (deferred): implementer report line citations are off by ~2-3.
Task 4: Ruling: deferring all three minors rather than opening a fix round.
Unlike Task 3's, these do not serve a named spec risk — the scheme was verified
correct against the authority, so the residue is cosmetic/defensive.
Cost if wrong: a future @noble/curves change could make the dead branch
load-bearing without anyone noticing it was never exercised; the final
whole-branch review gets these for triage.
Task 4: complete (commits 20ef244..1099188, review clean)
Task 5: BASE 1099188
Task 5: implemented (commit d1c3978), reported DONE_WITH_CONCERNS.
Task 5: Ruling: the implementer found a real defect IN THE PLAN TEXT —
stripCompactPrefix's big-integer branch read `1 + (encoded[0] >> 2)` where SCALE
requires `5 + (encoded[0] >> 2)` (big-integer mode stores byteCount-4 in the
upper six bits, so the prefix is the mode byte + 4 + remainder). I verified the
arithmetic independently and the implementer is right. It is currently
unreachable (the stripped prefix is the Vec<Field> element count, always <= 9,
so always single-byte mode), but the function decides WHAT GETS SIGNED, so a
latent wrong-bytes signature is not acceptable to leave in. Fixing rather than
deferring, and the plan text is corrected so it cannot propagate. The
implementer behaved correctly: implemented verbatim and reported instead of
silently diverging. Cost if wrong: none material — the branch is dead today, so
the change is provably safe and only matters if the encoding ever grows.
Task 5: addressing the correctness concern before review, per the
DONE_WITH_CONCERNS route.
Task 5: fix applied pre-review (commit f61385b), then reviewed: spec OK,
quality Approved, no Critical/Important. Reviewer independently confirmed the
corrected formula against scale-ts's own compactEnc (`result[0] =
(result.length - 5) << 2 | 3`) and confirmed the new test fails against the old
arithmetic. Field indices also cross-checked against the reference codec.
Task 5: ⚠️ resolved by controller — release checklist deferred to Task 16, same
as Task 1's identical flag.
Task 5: minor (deferred): decodeStatement does not reject out-of-order or
non-contiguous topic tags the way the reference codec does; only matters for
untrusted statement bytes.
Task 5: minor (deferred): `as never` / `as unknown as` casts at statement.ts
enc/dec boundaries disable compile-time checking of tag strings.
Task 5: minor (deferred): stripCompactPrefix is now exported, widening the
module surface past the seven pinned names — a deliberate call I directed so the
otherwise-unreachable branch is testable.
Task 5: minor (deferred): round-trip tests never exercise `channel` or
`decryptionKey`.
Task 5: complete (commits 1099188..f61385b, review clean)
Task 6: BASE f61385b
Task 6: implemented (commit 152c623). Review: spec OK, quality Approved, but 1
Important. Reviewer walked all 24 variants against v1.rs (exact 1:1), confirmed
pinned indices 14-23, verified every hand-built shape against messages.rs using
the Rust's own byte-fixture tests, and independently confirmed the
HostAccountGetAliasResponse -> ContextualAlias substitution through the Rust
type-alias chain. No placeholder codecs were needed.
Task 6: Important: index parity between REMOTE_MESSAGE_VARIANTS (the string
array) and the RemoteMessage Enum object literal is enforced only by eye.
Indices 3-13 and 17-22 are covered by no test, so a future edit desyncing the
two literals would pass CI. No live defect today.
Task 6: minor (deferred): SignRequest's rawWithLegacyAccountUnwatermarked
variant inlines a shape identical to SignRawWithLegacyAccountRequest, forced by
declaration order.
Task 6: fix round 1/5 dispatched to the original implementer.
Task 6: fix round 1/5 (1 addressed, 0 open; commits 152c623..b970570)
Task 6: complete (commits f61385b..b970570, review clean). RemoteMessage order
is now derived from REMOTE_MESSAGE_VARIANTS by construction, and a
non-circular 24-variant test asserts real encoded index bytes.
Task 7: BASE b970570
Task 7: implemented (commit 501940e). Review: spec partially OK but quality
Needs fixes — 4 Important findings, all inherited from the plan's reference code
(which the implementer copied verbatim, as instructed):
  1. parseFilter throws on a non-object filter, uncaught inside send() -> hang
  2. publish() has no per-subscriber error isolation; one throwing subscriber
     starves every later one
  3. statement_submit can throw in decode before replying, breaking the
     "always answers" invariant
  4. close() and cross-connection isolation are entirely untested
Task 7: Ruling: fixing all four rather than deferring, even though the plan text
mandated the unguarded code. The spec's whole point for this module is that a
real WASM core drives it in Task 12, where an uncaught synchronous throw in
send() manifests as a request that never gets answered — indistinguishable from
a hang and very expensive to debug through a worker boundary. The plan's snippet
was illustrative, not a contract. Cost if wrong: a little defensive code and
three extra tests in a module that is already small.
Task 7: ⚠️ resolved by controller — CLAUDE.md release checklist deferred to
Task 16, as with Tasks 1 and 5.
Task 7: minor (deferred): unsubscribe replies true even for an unknown id.
Task 7: minor (deferred): fromHex silently truncates odd-length hex.
Task 7: minor (deferred): bare-array and MatchAny filter forms are untested.
Task 7: fix round 1/5 dispatched to the original implementer.
Task 7: fix round 1/5 (4 addressed, 1 new Important opened by the fix itself:
statement_submit can now send a duplicate error reply for an id it already
answered "new", if an onSubmit listener throws inside the new try scope;
commits 501940e..984a0e6)
Task 7: fix round 2/5 dispatched — isolate the onSubmit listener loop from the
success-reply try scope. This is load-bearing rather than theoretical: Task 9's
responder registers through onSubmit and does real signing work there, so a
throwing listener is a realistic path, and a double answer for one request id
would confuse the core across the worker boundary.
Task 7: fix round 2/5 (1 addressed, 0 open; commits 984a0e6..86c7ee8)
Task 7: controller verified the round-2 test directly, because the re-review
report was too terse to evidence the two checks I asked for: confirmed
listener1 (the FIRST) is the throwing one, and the test asserts onResponse was
called exactly once with result 'new'. Full suite 43/43 across 6 files.
Task 7: complete (commits b970570..86c7ee8, review clean)
Task 8: BASE 86c7ee8
Task 8: implemented (commit 039a07e). Review: spec OK, quality Approved, no
Critical/Important.
Task 8: Ruling: the implementer corrected the brief's test expectations rather
than the code, and that was right. The brief asserted single-byte compact
offsets, but the fixture's inner length is 103 bytes (1+1+32+1+64+1+3), and
103 >= 64 forces two-byte compact mode, shifting every offset by one. I derived
the ground truth independently (prefix [0x9D,0x01], 0x84 at index 2, pubkey at
4..35, 0x01 at 36, total 105) and handed it to the reviewer, which recomputed
and confirmed the committed test matches it and was not weakened. Plan text
corrected so it cannot mislead later. Cost if wrong: none — the layout was also
verified byte-for-byte against the pre-migration original, including the > 256
(not >=) blake2 threshold.
Task 8: minor (deferred): the 4-byte compact mode (>= 2^14) is implemented but
untested.
Task 8: minor (deferred): the report calls sr25519 signing "deterministic",
which is imprecise.
Task 8: complete (commits 86c7ee8..039a07e, review clean)
Task 9: BASE 511ed8d
Task 9: implemented (commit 70ced86), reported DONE_WITH_CONCERNS with THREE
contract-level discoveries that contradict the plan. All three are claims about
the real wire protocol, checked by the implementer against the 0.17.0 Rust:
  1. Replies must be signed by the key behind identityAccountId, NOT ssSecret —
     the core treats an ssSecret-signed statement as its own echo and reads only
     the ack from it. ResponderSession therefore gained `identitySecret`.
     => TASK 12 MUST PASS `identitySecret: signer.secretKey`.
  2. Batch entries are RemoteMessage { message_id, data } envelopes, and
     reply_matcher drops replies whose respondingTo does not echo the id. The
     implementer added RemoteMessageEnvelope to messages.ts — a Task 6 gap — so
     this commit touches a file Task 6 owned.
  3. Replies are StatementData.request frames; `response` is only the transport
     ack, and the core withholds its reply until it sees that ack. The responder
     publishes the ack first, then the reply batch.
Task 9: Ruling: sending all three to review for verification against the Rust
rather than accepting them on the implementer's word. If claim 1 or 3 is wrong,
nothing fails until Task 12 wires the real core, where the symptom would be a
silent hang across a worker boundary — the most expensive place in this plan to
discover a protocol error. Cost if wrong: one review pass at the top model.
Task 9: also noted — @polkadot/types is retained for the ExtrinsicPayload
signer-payload path (Task 8 explicitly deferred that call here). This is allowed:
the binding constraint is removal of @novasamatech/*, not @polkadot/*.
Task 9: responder is ~260 lines against a ~200 guideline, and
resolveAccount(id, undefined) is overloaded for product subtrees vs legacy
accounts — both flagged for the reviewer's judgement.
Task 9: review — all THREE protocol claims CONFIRMED against ../host-rust-core
with file:line evidence (messages.rs:363-395 for the identity-signing rule,
messages.rs:78-101 + sso_remote.rs:251-263 for the envelope, messages.rs:384-408
+ sso_remote.rs:399-420 + sso_responder.rs:476-506 for ack-before-reply). The
implementation independently reproduces the reference responder's control flow.
Task 6's variant pinning verified intact; no index moved.
Task 9: 3 Important findings ->
  1. Legacy-account paths can silently sign with, and attribute an extrinsic to,
     the WRONG key — nothing checks the resolved keypair matches the requested
     AccountId. The reference errors on that mismatch (signing_host.rs:791-801).
  2. The <Bytes> watermark distinction is decoded then discarded; the core
     distinguishes watermarked vs unwatermarked raw signing
     (sso_service.rs:84-92, :427-432). Not a regression (the old container never
     watermarked either) but a divergence from the contract this file now claims.
  3. Half the request surface is untested — exactly the half where finding 1
     bites and where a wrong pairing would surface only as a Task 12 hang.
Task 9: CARRY INTO TASK 12 — the reviewer flags that Rust treats
identity_account_id as the PEER's statement-store account id
(pairing.rs:295-299), so Task 12 must supply an identitySecret whose public key
really is that account id. The responder guards this at construction, so a
mismatch is loud rather than silent.
Task 9: CARRY FORWARD — tsconfig.json excludes src/browser/**, so pnpm typecheck
covers none of this migration's new code, and the responder's three
`as RemoteMessageValue` casts sit outside any CI gate. Ruling: Task 12 or 13
must bring src/browser into typecheck. Cost if wrong: the casts stay unchecked
and a type error ships silently.
Task 9: fix round 1/5 dispatched to the original implementer.
Task 9: fix round 1/5 (3 addressed, 0 open; commits 70ced86..1a91964).
Re-reviewer verified the watermark mapping variant-by-variant against
sso_service.rs:84-90 and :427-432, confirmed the legacy refusal reaches the
product as a proper Result::Err rather than a hang, and confirmed the two type
fixes were shape corrections rather than suppressions.
Task 9: Ruling: accepting the reviewer's judgement that `signRawBytes`'
`watermarked = false` default is fine as shipped — every real call site passes
it explicitly, and false is the conservative direction (pre-migration
behaviour) rather than fabricating a watermark. Not worth another round.
Cost if wrong: a future caller forgets the flag and signs unwatermarked.
Task 9: complete (commits 511ed8d..1a91964, review clean). Unit suite 84/84.
Task 10: BASE 1a91964
Task 10: first dispatch FAILED — agent stalled (watchdog, 600s no progress)
while exploring truapi-host types. Working tree clean, HEAD unchanged at
1a91964, no partial work. Re-dispatched with the group signatures supplied
inline to remove that exploration.
Task 10: Ruling: the plan's `chain` callback shape is WRONG and I corrected it
before re-dispatching. I read the generated contract directly:
  ChainProvider.connect(genesisHash: Uint8Array): Promise<JsonRpcConnection>
  JsonRpcConnection { send(request: string): void;
                      responses(): AsyncIterable<string>;
                      close(): void }
The plan (Tasks 10, 11 and 12) assumed a push-callback
`connect(genesisHash, onResponse)` returning `{ send, close }`. The real core
PULLS responses from an AsyncIterable. Task 7's LoopbackStore keeps its
push-based `connect(onResponse)` — that is fine and stays — but an adapter is
needed to present it as a JsonRpcConnection. Conveniently this is the same
push-to-async-iterator bridge Task 10 already needs for theme/locale/preimage.
CARRY INTO TASKS 11 AND 12: same correction applies to the WS route and to the
runtime wiring. Cost if wrong: the core would silently never receive chain
responses, surfacing as a hang at Task 12 — which is exactly why I checked
rather than letting an implementer guess.
Task 11 prep (read-only, done while blocked on a classifier timeout): the
plan's Task 11 import path `polkadot-api/ws-provider/web` is WRONG. polkadot-api
3.1.0 exposes the ws entry at `polkadot-api/ws`, exporting `getWsProvider` and
`getWsRawProvider`. Both return a push-style provider, so the WS route needs the
SAME push-to-async-iterator adapter as the loopback route in order to satisfy
JsonRpcConnection.responses(). Correct the plan and regenerate task-11-brief.md
before dispatching Task 11.
Task 10: implemented on retry (commit 649a6a1), reported DONE_WITH_CONCERNS with
three items. Unit suite 89/89 across 9 files; export smoke 22/22.
Task 10: Ruling on concern 1 (chat not implemented): ADD IT. My dispatch said
"chat is in scope per the brief" but the brief never mentions it — that was my
error, not the implementer's, and it was right to stop rather than invent scope.
Chat is nonetheless required: the design spec's Control API table keeps
getChatRooms / getChatBots / getChatMessageLog / clearChatState /
injectChatAction, and those read the optional `chat` group's state. The spec is
the binding authority. Cost if wrong: an optional group we could have omitted.
Task 10: Ruling on concern 2 (RemotePermissionRequest shape): conform to the
real generated type `{ permission: RemotePermission }` and fix the TEST, rather
than making the implementation accept both shapes. The brief's test passed a
bare shape through `as never` — the `as never` was the defect, and accepting
either shape would bake my plan's error into the product code.
Task 10: Ruling on concern 3 (supportedChains placeholders): STOP GUESSING.
ChainIdentifier is a fixed enum (Relay | AssetHub | People | Bulletin), and
deriving it from a substring of a human-readable network name is exactly the
kind of silent misroute this migration cannot afford. Carry an explicit optional
`chain?: ChainIdentifier` on ChainRuntimeConfig; report People for the loopback;
omit a network from the set rather than inventing a role for it. CARRY INTO
TASK 12: thread that field through the host page config and set it on the three
shipped networks (Paseo Asset Hub = AssetHub, Previewnet = Relay, Previewnet
Asset Hub = AssetHub). Cost if wrong: under-reporting a chain makes it
unroutable, which fails loudly, where a wrong guess would fail silently.
Task 10: fix round 1/5 dispatched to the original implementer.

Task 10 fix round 1: DONE at a6d2aea (chat group added, strict RemotePermissionRequest shape, explicit `chain?: ChainIdentifier`). 95 unit tests, 22 export smoke tests. Scoped re-review dispatched over 649a6a1..a6d2aea.
Ruling: `injectChatAction` has no HostCallbacks equivalent — the runtime publishes chat actions directly, so Task 14 wires that control to `runtime.publishChatAction`, not to the chat callback group. Cost if wrong: Task 14 re-does one control binding.
Ruling: threading `chain?: ChainIdentifier` into host page config + src/types.ts is Task 12's work, not Task 10's — Task 10 only needed the field to exist on ChainRuntimeConfig. Cost if wrong: supportedChains() under-reports until Task 12 lands.
Task 10 re-review: all three findings ADDRESSED. One new defect (two `as never` casts in chat.spec.ts) fixed in-place at d30c8ea — single-file, two-line, type-checked and re-tested rather than spending a dispatch round.
Ruling: the third private `toHex` helper (features.ts, duplicating passive.ts and loopback-chain.ts) is parked, not fixed — it matches the codebase's existing style and consolidating it now would touch three files outside Task 10's scope. Cost if wrong: one small refactor later. Revisit at the final whole-branch review.
Task 10: complete (d30c8ea, 95 unit tests + 22 export smoke tests).

Task 11 dispatched. BASE=d30c8ea.
Task 11: implemented at 01aafdf (98 unit tests, 22 export smoke). Review dispatched over d30c8ea..01aafdf.
Ruling: the plan's Task 11 "verified fact" that `getWsRawProvider` exchanges JSON-RPC STRINGS is WRONG and is hereby corrected — polkadot-api@3.1.0 -> @polkadot-api/ws-provider@0.9.1 -> @polkadot-api/json-rpc-provider@0.2.0 exchanges PARSED objects (`send(JsonRpcRequest)`, `onMessage(JsonRpcMessage)`), and ws-provider's with-socket.js does JSON.parse/stringify at the socket. I confirmed this independently; a stale @polkadot-api/json-rpc-provider@0.0.1 copy in the pnpm store carries the old string-based types and is what misled the plan. The implementer's JSON.stringify/JSON.parse bridge in chain.ts is correct and required. Cost if wrong: the WS route would silently send `[object Object]` over the wire.
Task 11 review: SPEC ✅ MET, QUALITY APPROVED. Two non-blocking findings, both fixed in-place (single file, no dispatch round): WS `send()` now answers a malformed request with a JSON-RPC -32700 instead of throwing synchronously (parity with the loopback route), and `getWsRawProvider` gets an `onStatusChanged` that warns on ERROR/CLOSE so an unreachable rpcUrl is diagnosable rather than a silently pending `responses()`.
Ruling: the deeper finding — `@polkadot-api/json-rpc-provider-proxy`'s `getSyncProvider` retries an unreachable socket forever and never surfaces a halt, so a bad `rpcUrl` pends instead of failing — is NOT fixed here. It is upstream behaviour, it is untestable without a fake socket (the task forbids real sockets in unit tests), and the brief's "never hang" constraint was scoped to genesis routing, which is met. Cost if wrong: a test against a misconfigured network hangs to the Playwright timeout instead of failing fast; the console warning now names the network when that happens. Revisit at the final whole-branch review if Task 15 shows it biting.
Task 11: complete (139ebf8, 98 unit tests + 22 export smoke tests).

Task 12 dispatched. BASE=139ebf8.
Task 13 note (observed during Task 12): `pnpm build` currently succeeds but warns `"import.meta" is not available with the "iife" output format` at src/browser/host-worker.ts. That is the seam Task 13 owns — the host page must become an ES module so `new URL('@parity/truapi-host/worker-runtime', import.meta.url)` resolves, and the two .wasm files must be served beside it. A silently empty import.meta.url would make the worker URL resolve against the wrong base at runtime, so Task 13 must treat this warning as a hard failure, not a nit.
Task 12: implemented at 9c82c7e, DONE_WITH_CONCERNS. typecheck CLEAN (the two long-standing src/types.ts errors are gone), 98 unit + 22 export tests green, build exits 0 with the import.meta/iife warning. Review dispatched over 139ebf8..9c82c7e.
Ruling: Task 12 taking Task 14's Step 3 and half of its Step 2 is ACCEPTED, not scope creep — the dispatch required a clean typecheck and tsconfig includes src/index.ts, src/playwright/index.ts and src/playwright/fixture.ts, all of which referenced the deleted types. Task 14 is reduced to the fixture's waits and the export smoke tests. Cost if wrong: Task 14 finds less to do than its brief says.
Ruling: `selectorOf` and `resolveProductAccount` MUST get unit tests. They are pure, and they are the two functions that decide which key signs a product's transaction — exactly the kind of logic that must not first be exercised by an E2E test. Folded into Task 12's review as a required check rather than deferred. Cost if wrong: one small spec file written earlier than strictly needed.
Ruling: the 25 pre-existing src/browser type errors (Uint8Array variance in dev-accounts.ts, Codec variance in messages.ts) and the decision whether to bring src/browser into `pnpm typecheck` are carried to Task 13, which owns tsconfig and packaging. Cost if wrong: they stay invisible to CI one task longer.
Task 12 review: SPEC ✅ MET (all seven corrections confirmed), QUALITY CHANGES_REQUESTED, eight findings. Fix round 1 dispatched to the original implementer.
Ruling (F2): the account-switch frame loss is a real bug, fixed inside the no-reload design with a queueing subscriber on portProvider across the provider swap — NOT by rebuilding the IframeHost. Rebuilding stays the escape hatch if Task 15 proves a product cannot survive a core swap. Cost if wrong: Task 15 forces the iframe rebuild anyway and this queue becomes redundant.
Ruling (F3+F4): `getConnectionStatus()` is restored to its PRE-MIGRATION meaning — the product connection, flipped on the first inbound frame over the bridge — because `fixture.waitForConnection()` polls it and had silently become a no-op that would surface as flake, not failure. `getChainStatus()` takes the session-activation meaning, assigned after the re-bridge, with a failed switch leaving 'disconnected'. This supersedes the plan's "both report the same value". Cost if wrong: one control's semantics differ from the plan text; the plan is the weaker authority here because the spec's goal is a control API tests can assert against.
Ruling (F5): `injectChatAction`'s public type is narrowed to the real payload union and now returns its promise, rather than keeping a `payload: unknown` signature that only type-checks through method-parameter bivariance. The migration is already breaking; an honest signature beats a compatible lie that resolves successfully while delivering nothing. Cost if wrong: one more breaking change to document in Task 16.
Ruling (F6): `withIframePermissionsPolicy` is KEPT but its comment corrected — a Permissions Policy allow attribute only applies at navigation, and nothing re-navigates the iframe any more. The pre-migration comment said so explicitly; the new one overstated it. Cost if wrong: dead-ish code retained, which is cheap and becomes live again if an iframe rebuild lands.
Ruling: the `hostConfig.assetHub.genesisHash = ZERO_HASH` vs `supportedChains()` advertising an AssetHub inconsistency is PARKED for the final whole-branch review. The brief specified the zero hash, and reconciling it is a design question about what a host with no Asset Hub should report to the core — not a mid-round fix. Cost if wrong: the core gets an inconsistent chain story until the final review picks it up.
Task 12 fix round 1: DONE_WITH_CONCERNS at 1ec74b8. All eight findings addressed; 111 unit tests (98 + 13 new product-accounts.spec.ts), typecheck clean, 22 export tests. Scoped re-review dispatched over 9c82c7e..1ec74b8.
Ruling: `@parity/truapi` MUST move from devDependencies to dependencies, and this is TASK 13's work, not Task 16's. Verified: package.json today has NO `dependencies` block at all (everything is a devDependency, which worked only because the browser code is inlined into dist/host-bundle.js), and `dist/types.d.ts` now emits `import type { ChatActionPayload, HostChatActionSubscribeItem } from '@parity/truapi'` — an unresolved import for every consumer. That is a build/packaging defect, which Task 13 owns; Task 16's release checklist is version + CHANGELOG + forum-post + README. The lockfile must be regenerated with it, because all three CI workflows run --frozen-lockfile. Cost if wrong: shipping a package whose published types do not resolve.

Ruling (NEW TASK 13b, inserted): the chain route must move from `polkadot-api/ws` to `@parity/truapi-provider`. Reasons, in order of authority: (1) the design spec's own component table says chain access is `@parity/truapi-provider` (smoldot / addRpcChain) — Task 11's plan text contradicted the spec, and the spec is the binding authority; (2) the user named `@parity/truapi-provider@0.2.0` as one of four target libraries, and it is currently installed and imported by NOTHING, so the migration would not actually deliver it; (3) Task 13's own Step 2 copies `truapi_provider_bg.wasm`, which is only meaningful if something uses it; (4) its `Connection` is already a raw string pipe (`send(request: string)`, `nextResponse(): Promise<string | undefined>`, `close()`) that maps onto `JsonRpcConnection` directly — adopting it DELETES the JSON.parse/stringify bridge and the push channel from the WS route rather than adding complexity. Sequenced after Task 13 because it needs the wasm served first. Cost if wrong: one file (chain.ts, 3 tests) is rewritten twice.
Open question for the user at the end of the run, NOT a blocker: `polkadot-api` v3 was one of the four stated migration targets, but after 13b its only import site (chain.ts) is gone, leaving it an unused dependency. `@polkadot/types` and `@polkadot/util` are still used (extrinsic.ts, responder.ts, types.ts). Report this and let the user decide keep-vs-drop; do not silently remove a library they asked for.
Task 12 re-review: all eight findings ADDRESSED. Two new defects in the fix diff, both fixed in-place at 7f74a67: `stopParking()` now runs in a `finally` (a failed `createProvider` previously left the parking subscriber attached forever, growing `parked` unboundedly and reporting the product as talking while no frame reached any core — the same lying-status class F3/F4 removed); and a false caveat in fixture.ts claiming `page.evaluate` structured-clones and so cannot carry a `bigint` (Playwright's own serializer encodes bigint and typed arrays and round-trips them, so the comment steered test authors away from `ChatFile.sizeBytes`, which works).
Task 12: complete (7f74a67, 111 unit tests + 22 export smoke tests, typecheck clean).
Carry to Task 13: a rejection from `createWebWorkerPairingHostRuntime` still leaks the Worker created by `createHostWorker()`, because the boot try starts after that await. Task 13 is what makes that worker URL resolve, so it fixes the leak with it.

Task 13 dispatched. BASE=7f74a67. Carried into the dispatch: the unemitted worker (esbuild passes `new Worker(new URL(...))` through verbatim, so the worker needs its own entry point and host-worker.ts must point at the emitted file), where the wasm glue chunk actually lands, the @parity/truapi devDep->dep move plus lockfile regen, the stale `@novasamatech/host-api` external in build.mjs's CJS config, the src/browser tsconfig decision and its 25 hidden errors, and the worker leak on a failed runtime boot. Also required: prove the page actually boots in a real browser, because a green `pnpm build` is exactly the failure mode Task 12 left behind.
Task 13: implemented at d04ec0a, DONE_WITH_CONCERNS. The page BOOTS FOR REAL for the first time — worker loads, wasm instantiates, __TEST_HOST__ publishes 28 members, verified in a browser both standalone and through `pnpm exec playwright test`. Build exits 0 with no warnings; 111 unit + 22 export tests; `pnpm install --frozen-lockfile` succeeds after the lockfile regen; `pnpm pack` ships dist/host/ with both wasm (8.3 MB). Review dispatched over 7f74a67..d04ec0a.
Ruling: Task 13 rewriting the `test-exports-{esm,cjs}` assertions is ACCEPTED. They asserted the browser bundle was inlined into the HTML, which Step 4 deliberately removes, so leaving them for Task 14 would have meant knowingly committing a red test suite. They now assert the new contract (module script tag, asset status/MIME, 404, 403). Cost if wrong: Task 14 finds this part already done.
Ruling: bringing `src/browser` into a typecheck gate via a separate noEmit `tsconfig.browser.json`, rather than into the emitting `tsconfig.json`, is the right call and is ACCEPTED — including it in the emitting project would publish a second unbundled copy of the browser code into dist/, with imports that are not in `dependencies`. The 25 previously-hidden errors were fixed rather than suppressed, with no `as any`/`as never`. Cost if wrong: two tsconfigs to keep in step.
Carry to Task 15: `test/test-product.ts` still imports the removed @novasamatech/* packages, `test/truapi-product.spec.ts` cannot load @polkadot/keyring (not installed), and `test/test-product-truapi.ts` is a truapi 0.4 product that throws inside its own encode. All three are Task 15's rewrite, and together they are why `pnpm test:integration` cannot run yet.
Task 13 review: SPEC ✅ MET, QUALITY APPROVED. Three actionable findings, all fixed in-place at the commit below: `build.mjs` now clears `dist/host` before building (the chunks are content-hashed and esbuild does not clean its outdir, so a rebuild after a dependency bump left stale chunks that `pnpm pack` shipped — the reviewer demonstrated it by planting two), and both export smoke tests now assert the clipboard `Permissions-Policy` header, which correction 5 named as must-keep and which nothing covered.
Ruling: THIRD_PARTY_NOTICES.md is ADDED to Task 16's scope. It still describes "the browser bundle (dist/host-bundle.js)" — a path that no longer exists — and still lists @novasamatech/host-api and @novasamatech/host-container as bundled. It is a release document, so it belongs with the CHANGELOG/forum-post/README work, but CLAUDE.md's checklist names only four files, so without this ruling it falls through the gap. README.md:378 has the same stale reference and is already inside the checklist. Cost if wrong: a fifth file to update in Task 16.
Carry to Task 13b: `build.mjs`'s glue-chunk assertion only covers `@parity/truapi-host`'s `truapi_server.js`. `truapi_provider_bg.wasm` is copied on faith today; once 13b imports the provider glue it needs the same guard, or it inherits exactly the silent-404 failure mode that assertion exists to prevent.
Task 13: complete (111 unit + 22 export tests, build clean, page boots in a real browser).

Task 13b dispatched. BASE=8685150. Brief written by hand at task-13b-brief.md (this task is not in the original plan). Carried: do NOT remove polkadot-api even though chain.ts is its only import site — that is the user's call and I am asking them at the end of the run; @parity/truapi-provider should stay a devDependency since it is bundled into dist/host/ rather than referenced from a published .d.ts, but verify by grepping the emitted .d.ts; and extend build.mjs's glue-chunk assertion to the provider glue.
Task 13b: implemented at 76e3f0e, DONE_WITH_CONCERNS. 114 unit tests (111 + 3), 22 export tests, typecheck clean on both projects, build clean with both glue assertions passing, page boots in real Chrome. Review dispatched over 8685150..76e3f0e.
Finding that vindicates the task: @parity/truapi-provider FAILS FAST on an unreachable rpcUrl — `connect()` rejects in ~9ms with a WebSocket handshake error, probed in-page against a closed local port. The polkadot-api/ws route it replaces retried forever and never told its caller, which is the whole reason commit 139ebf8 had to log socket status to the console. That console warning is correctly gone and the SDK needs no connect timeout of its own. The parked Task 11 ruling about the silently-pending rpcUrl is therefore RESOLVED, not merely carried.
Ruling: dropping the `-32700` malformed-request reply (also from 139ebf8) is ACCEPTED. The provider's Connection is a raw string pipe, so the provider owns that error path now; synthesising our own reply would mean re-introducing a JSON.parse this route no longer needs. Cost if wrong: an integration test expecting -32700 fails in Task 15, and the fix is to assert the provider's error instead.
Lazy init confirmed: a People-only page load fetches neither the provider glue chunk nor the 5.2 MB wasm.

Ruling: TASK 14 IS NOT DISPATCHED — its work was already absorbed. Verified rather than assumed: Step 1's control API surface was built in Task 12; Step 2's "remove references to deleted controls" and Step 3's export trim were done in Task 12 (grep confirms zero references to the four deleted types or the twelve deleted controls anywhere in src/ or the smoke tests); Step 4's export smoke tests were rewritten in Task 13 and pass 22/22. Step 2's fixture waits were already correct — `waitForConnection` polls `getConnectionStatus()`, which Task 12's fix round made a real product-connection gate. The ONE genuine gap was that `getChainStatus` was the only one of the 28 TestHostAPI members the fixture did not surface; I added it and `getConnectionStatus` explicitly. Cost if wrong: nothing — the verification is mechanical and reproducible by the grep above.
Task 14: complete (absorbed into Tasks 12 and 13, plus the fixture status accessors).
Task 13b review: SPEC ✅ MET, QUALITY APPROVED, zero findings. Task 13b: complete (76e3f0e, 114 unit + 22 export tests).

Task 15 dispatched. BASE=d8284f4. Scope: rewrite test/test-product.ts (703 lines, currently on @novasamatech/host-api-wrapper) against @parity/truapi/sandbox; delete test/test-product-truapi.ts and test/truapi-product.spec.ts; reduce test/build-test-product.mjs to one product; prune test/integration.spec.ts (1694 lines, 58 tests, 25 describes) of the blocks covering controls this migration removed. This is the task that proves the whole branch: `pnpm test:integration` has not run since Task 1.
Task 15: BLOCKED at caef7ec on two REAL host defects, both found by running the integration suite for the first time (47 tests: 24 passed, 23 failed). Test side is committed and complete. I verified both defects myself against ../host-rust-core at tag c4067574, the exact @parity/truapi 0.17.0 release commit.
Ruling (DEFECT 1 — FIX IT): `src/browser/loopback-chain.ts` replies to `statement_submit` with the bare string `'new'`. The core does `result.get("status").and_then(Value::as_str)` and accepts only `"new"`/`"known"` (statement_store_rpc.rs:181) — a JSON string has no `status` field, so EVERY SSO signing request dies with `statement_submit not accepted: "new"`. This is my spec's error: the design doc says "`new`/`known` means accepted", which is what the implementer faithfully built. Fix is `reply({ status: 'new' })`. Cost if wrong: none — this is verified against the release-tag source, not inferred.
Ruling (DEFECT 1b — FIX IT): the same file's `parseFilter` matches `MatchAll`/`MatchAny`, but the core emits lower-camel `json!({ "matchAll": topics })` / `json!({ "matchAny": topics })` (statement_store_rpc.rs:219-220). So a real filter parses as MatchAll with an EMPTY topic list — matching everything — and `matchAny` is silently downgraded. Latent today because only the responder publishes, on one topic, but statement-store topic filtering is simply not enforced. `loopback-chain.spec.ts` asserts the capitalised spelling, so the unit tests currently agree with the bug and must move with the fix.
Ruling (DEFECT 2 — MAKE IT CONFIGURABLE, default unchanged): chat is denied because `createProvider({ productId })` leaves `executionKind` unset, defaulting to `App`, and the core gates every Chat entry point on `Worker` (chat.rs:15). I checked the enum: `App | Widget | Worker`, and Worker is documented as "Headless executable the host runs while a modality holds a reference to it; the only kind that may serve the Chat modality" (truapi-platform/src/lib.rs:143-151). So chat really is Worker-only. I am NOT hardcoding `Worker`: an iframe-embedded product is an App, and declaring otherwise would misreport what the host is running, for every product, to unlock one modality. Nor am I deleting chat as dead code — the callback group, the five controls and their tests all work once the kind is right. Instead `executionKind` becomes a public SDK option defaulting to `'App'`, threaded to `createProvider`, and the chat tests configure `'Worker'`. Cost if wrong: one option nobody sets, versus either lying about every product's kind or deleting a working feature.
Task 15 fix wave: DONE at 4d16199. FOUR defects fixed, not two — fixing the statement_submit shape unblocked the SSO channel and exposed two more that had never been reachable: (3) `publish` sent subscription items as a bare hex statement, but the core's `parse_new_statements_result` requires the `{"event":"newStatements","data":{"statements":[...],"remaining":n}}` envelope; (4) `@scure/sr25519` emits the cofactor-multiplied 64-byte secret while schnorrkel's `SecretKey::from_bytes` accepts only the canonical one, so AutoSigning was refused as an "invalid subtree secret" — new `canonicalSecretKey()` converts at the two handover points, same scalar, no address or signature moved. Integration: 43 passed, 4 skipped, 0 failed (was 24/23). Unit: 120 (was 114), and the loopback tests were verified to FAIL against the old behaviour.
Ruling (DEFECT 5 — FIX IT, in this release): the core no longer asks the host for an indexed product account. It asks once for the hard subtree via `ProductSubtreeRequest` and then soft-derives each account itself: `derive_product_public_key(subtree_pub, index_bytes(n))` = `derived_key_simple(ChainCode(index_bytes(n)))`, with a symmetric secret-side `derive_product_keypair_from_subtree_secret`. I verified both in product_account.rs:222-249 at the release tag. This host still hard-derives `//Selected//dotnsId/index` when it SIGNS, so the address a product is told it has and the key that signs for that handle are different keys — a product's own signature does not verify against its own address. For an SDK whose entire purpose is auto-signing dev accounts for products under test, that is not a known issue, it is the product being broken. FIX: sign with the soft derivation the core uses, so address and signer agree.
Ruling on the cost: the objection was that this moves every product-account address and narrows `productAccounts` to subtree granularity. Both are FORCED BY UPSTREAM, not chosen — the core derives these addresses itself now, so no host-side choice can make `//Selected//dotnsId/index` reappear. The earlier "keep addresses byte-identical across the migration" decision was made before we knew derivation had moved into the core; it is unachievable, not traded away. And 0.13.0 is ALREADY a breaking release (twelve controls and four types removed), so folding this in beats shipping a second breaking release later. Cost if wrong: consumers pinning product-account addresses must re-read them once, in a release that already required re-reading them.
Ruling: `setEnforcePermissions` is REMOVED, not kept as a documented no-op. Nothing drives it, the host does not gate signing, and the core enforces ChainSubmit itself at transaction_broadcast. A public method that silently does nothing is worse than an absent one, and this release is already breaking. Cost if wrong: one more line in the CHANGELOG's removed list.
Task 16: DONE at eb38ab8. Defect 5 fixed with a genuine cross-implementation check — the JS soft derivation is asserted against schnorrkel's OWN pinned vectors from product_account.rs (the mobile vector `1c1ae478…5b5c` / `5ChZBnBw…8eis`, the root-keypair regression pin `0062ba…fc72`, and the iOS `index_bytes(0)` vector), so every expected byte was produced by schnorrkel, not by this repo. The regression test verifies a product's signature against the address the CORE reported, and was confirmed to fail when the derivation is reverted. `setEnforcePermissions` removed. Release checklist done across all five files. Integration 47 passed / 0 skipped / 0 failed; 129 unit; 22 export; typecheck, build clean; `grep @novasamatech` clean.
Ruling: `productAccounts` per-index keys now THROW at `createTestHostServer(...)` rather than being silently ignored. Same class of defect as the `setEnforcePermissions` no-op I just removed — a config key that does nothing is worse than one that fails loudly, and the error names the replacement. Cost if wrong: an upgrader gets an actionable error instead of a silently wrong address.
LICENCE FINDING FOR THE USER (not a code issue): THIRD_PARTY_NOTICES.md previously asserted no copyleft in the production surface. That is no longer true. `@parity/truapi-provider` ships a NOTICE stating `truapi_provider_bg.wasm` links smoldot/smoldot-light, which are GPL-3.0-or-later WITH Classpath-exception-2.0, and that wasm IS in the published tarball. The Classpath exception is what makes redistribution fine, but its conditions travel with every redistribution and this is the first release where that applies. Needs a look from whoever owns licensing.
All 16 tasks complete (+13b). Final whole-branch review dispatched over 17a28f9..eb38ab8: 37 commits, 69 files, +11389/-4663.

FINAL WHOLE-BRANCH REVIEW: CHANGES_REQUESTED. The machinery was independently re-derived against host-rust-core@c4067574 and found sound — no new defects of the class that bit four times. Everything found is at the seams. One fix wave dispatched.
Ruling (CI): adding `pnpm run test:unit` to .github/workflows/ci.yml is REQUIRED and is the single most important finding. `git diff main...HEAD -- .github/` is empty: no task owned CI, so all 12 spec files (129 tests) landed outside every gate — including the exact drift guards the spec names as its Risk-1 mitigation (the 456-byte session-blob pin, the non-circular 24-variant index test, the schnorrkel cross-implementation vector) and the loopback regressions Task 15 wrote only after they cost a full debugging wave. README:365 already tells contributors test:unit is part of the workflow, which is what made the gap invisible. Structurally the same miss as THIRD_PARTY_NOTICES: CLAUDE.md's checklist names four files, and the sixth file this change needed was never on anyone's list.
Ruling (featureSupported vs supportedChains): REAL BUG, fix + test. `featureSupported` matches only against `networks`, which never holds PEOPLE_GENESIS_HASH, while `supportedChains()` unconditionally advertises People. So a product probing the one chain this host actually serves in-page is told `false`. Both live in features.ts, so no single-file review had reason to compare them.
Ruling (multi-account): I verified this myself and it is worse than reported. `devAccount(name)` at host-runtime.ts:132 ignores the configured roster entirely and synthesises `//${Capitalized}`, so a custom `{name, uri}` account can NEVER be switched to — `switchAccount('custom')` silently derives `//Custom`. Combined with `accounts[0]` being the only identity read, the whole documented multi-account surface is a no-op. FIX rather than narrow: make the roster real — resolve names against `config.accounts` first, fall back to `//Name` for a bare dev name, keep `[0]` as the active signing identity, and document precisely that the rest are switch targets rather than co-signers. This makes the existing documentation TRUE instead of deleting a feature consumers already use. Cost if wrong: a slightly larger diff than narrowing the API would have been.

Final review fix wave: all 9 findings applied in one commit (1c14f14), base
eb38ab8. Full write-up in final-fix-report.md. Gates after: typecheck clean on
both projects, unit 137, export 22, integration 49 passed / 0 skipped / 0
failed, build clean. Version stays 0.13.0.
Final fix wave: DONE at 1c14f14. All nine findings applied. 137 unit (was 129), 22 export, 49 integration (was 47; +People featureSupported probe, +custom-URI switch regression), typecheck and build clean. Scoped re-review dispatched over eb38ab8..1c14f14.
Ruling (residual 1): `switchAccount` keeping the permissive `//Name` fallback for an unknown name is ACCEPTED. It is what lets `switchAccount('alice')` work without pre-declaring the account, which is the common case and the documented one; the fix is a strict superset of the old behaviour. A typo'd CUSTOM name resolving to a real-but-wrong dev account is the residual risk, and it is visible the moment a test asserts an address. Cost if wrong: a one-line follow-up to throw on an unknown name.
Ruling (residual 2): the responder burning one message id per failed encode attempt is ACCEPTED. Ids need uniqueness, not density; gaps are harmless. The counter simply stops being a reply count, which nothing reads it as.
Ruling (residual 3): leaving `npm-release.yml` without the unit suite is ACCEPTED. The unit suite belongs on the PR gate, which is where it now runs; adding it to the tag-triggered release job would gate a release on a suite that already passed on the commit being released. Cost if wrong: a release cut from an ungated branch could ship untested code — worth revisiting only if releases stop coming off a gated main.
