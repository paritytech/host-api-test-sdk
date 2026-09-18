# Static mock-data overrides for the test host's handler surface

Status: approved in discussion, 2026-09-18

## Goal

A product author testing against this SDK can put the host into any condition
the handler surface can express — a different locale, a declined confirmation,
an unsupported feature, pre-existing product storage — without editing the SDK.

Today only three handlers can be steered (`theme`, `permissions`, `preimage`),
each with its own naming convention, and `locale` has state and subscribers but
no control at all.

## Scope

**Out of scope, by instruction:** everything in the account / signing /
statement-store path — `chain.connect` and the loopback store, the SSO
responder, `coreStorage` (core-private slots including AutoSigning keys), and
`auth.authStateChanged`, which the core reports rather than answers. The
`pocket` group stays unwired.

**In scope:** every other handler the host answers.

## Two families

Handlers divide cleanly, and each family gets one shape.

**Ambient data** — the product reads or subscribes; the test sets a value.

    get<Thing>()            read what the host will report
    set<Thing>(value)       replace it, pushing to live subscribers
    seed<Thing>(...)        add to a collection the product will read
    clear<Thing>()          reset that collection

**Decisions** — the product asks; the test sets a policy.

    set<Thing>Behavior(b)   where b is 'approve-all' | 'reject-all' | fn

`fn` receives the request and returns the answer, so a test can be selective
without the SDK inventing a matcher language. This generalises the existing
`PermissionBehavior`, which already has exactly this shape.

**Observation** keeps its existing shape: `get<Thing>Log()` / `clear<Thing>Log()`.

## Naming normalisation

0.13.0 is unreleased, so the rename is free and happens now.

| Current | New | Why |
| --- | --- | --- |
| `clearChatState()` | `clearChat()` | `State` is noise; matches `clearPreimages` |

Everything else already conforms. `grantPermission` / `revokePermission` /
`getGrantedPermissions` are kept as-is: grant/revoke is clearer domain
language than seed/clear, and unambiguous.

## Initial configuration

Every override is also settable at fixture-construction time, applied before
the product's first frame. This is not sugar: a product that reads the theme or
locale during startup exercises a different path from one mutated after boot,
and only the second is testable today.

    createTestHostFixture({
      productUrl,
      initialState: { locale: 'pt-BR', theme: 'dark' },
      behaviors: { userConfirmation: 'reject-all' },
    })

## Risks

1. **Surface growth.** ~20 new control members. Mitigated by the two families:
   a reader who learns `set…` / `set…Behavior` can predict every name.
2. **Overrides that contradict the core.** `setSupportedChains` can advertise a
   chain `chain.connect` cannot route. That is deliberate — testing a product's
   behaviour against a lying host is the point — but the default must stay
   derived from the real configuration.
3. **Subscriber pushes.** `set…` on a subscribed value must notify live
   listeners, not just change the next read. `setTheme` already does; each new
   one needs the same and its own test.
