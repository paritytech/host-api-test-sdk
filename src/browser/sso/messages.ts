/**
 * SSO statement payload and remote-message codecs.
 *
 * `REMOTE_MESSAGE_VARIANTS` is the wire protocol: scale-ts assigns enum
 * indices by declaration order, so entries may only be appended, never
 * reordered. It mirrors `v1::RemoteMessage` in
 * `../host-rust-core/rust/crates/truapi-server/src/host_logic/sso/messages/v1.rs`.
 *
 * Payload codecs are sourced from `@parity/truapi`'s generated types wherever
 * a matching request/response shape exists there. A handful of wrapper and
 * host-local shapes (`ProductRequest<T>`, `Response<T>`, `RingVrfError`, the
 * resource-allocation and transaction-payload types) are not part of the
 * truapi wire contract — they are defined in
 * `../host-rust-core/rust/crates/truapi-server/src/host_logic/sso/messages.rs`
 * — so they are reproduced here by hand, field order verified against that
 * source.
 */
import { Bytes, Enum, Result, Struct, Vector, _void, str, u8 } from 'scale-ts';
import type { Codec, Decoder, Encoder } from 'scale-ts';
import {
  AccountId,
  AllocatableResource,
  ContextualAlias,
  HostAccountCreateProofRequest,
  HostAccountCreateProofResponse,
  HostAccountGetAliasRequest,
  HostAccountListRingVrfKeysRequest,
  HostAccountRegisterRingVrfKeyRequest,
  HostAccountRingVrfSignRequest,
  HostAccountSignVrfError,
  HostAccountSignVrfRequest,
  HostSignPayloadRequest,
  HostSignPayloadResponse,
  HostSignRawRequest,
  LegacyAccountTxPayload,
  ProductAccountTxPayload,
  RawPayload,
  RegisteredRingVrfKey,
  VrfSignature,
} from '@parity/truapi';

const Bytes32 = Bytes(32);

export const StatementRequest = Struct({
  requestId: str,
  data: Vector(Bytes()),
});

export const StatementResponse = Struct({
  requestId: str,
  responseCode: u8,
});

export const StatementData = Enum({
  request: StatementRequest,
  response: StatementResponse,
});

/** Declaration order is the wire format — append only. */
export const REMOTE_MESSAGE_VARIANTS = [
  'Disconnected',
  'SignRequest',
  'SignResponse',
  'GetAccountAliasRequest',
  'GetAccountAliasResponse',
  'ResourceAllocationRequest',
  'ResourceAllocationResponse',
  'CreateTransactionRequest',
  'CreateTransactionResponse',
  'CreateTransactionWithLegacyAccountRequest',
  'SignRawWithLegacyAccountRequest',
  'SignRawWithLegacyAccountResponse',
  'CreateAccountProofRequest',
  'CreateAccountProofResponse',
  'SignVrfRequest',
  'SignVrfResponse',
  'ProductSubtreeRequest',
  'ProductSubtreeResponse',
  'RegisterRingVrfKeyRequest',
  'RegisterRingVrfKeyResponse',
  'ListRingVrfKeysRequest',
  'ListRingVrfKeysResponse',
  'RingVrfSignRequest',
  'RingVrfSignResponse',
] as const;

export type RemoteMessageVariant = (typeof REMOTE_MESSAGE_VARIANTS)[number];

/*
 * Generic wrapper shapes shared by many `v1::RemoteMessage` variants.
 * Not part of the truapi wire contract: defined locally in
 * `host_logic/sso/messages.rs` as `ProductRequest<P>` and `Response<P>`.
 * SCALE encodes each generic's fields in declaration order, so the wrapper
 * field always precedes the payload.
 */

/** Mirrors `ProductRequest<P> { calling_product_id: String, payload: P }`. */
const ProductRequest = <T>(payload: Codec<T>) => Struct({ callingProductId: str, payload });

/** Mirrors `Response<P> { responding_to: String, payload: P }`. */
const Response = <T>(payload: Codec<T>) => Struct({ respondingTo: str, payload });

/**
 * Mirrors `RingVrfError` in `messages.rs`. Variant order confirmed against
 * `RingVrfError::{RingNotFound,NotMember,KeyNotRegistered,KeyNotInRing,
 * NotAllowlisted,Rejected,Unknown}` encode-index assertions in that file's
 * `late_remote_message_variants_match_host_papp_order` test (indices 0-6).
 */
const RingVrfError = Enum({
  ringNotFound: _void,
  notMember: _void,
  keyNotRegistered: _void,
  keyNotInRing: _void,
  notAllowlisted: _void,
  rejected: _void,
  unknown: Struct({ reason: str }),
});

/** Mirrors `SignRequest` in `messages.rs` (signing-request flavor enum). */
const SignRequest = Enum({
  payload: HostSignPayloadRequest,
  raw: HostSignRawRequest,
  rawUnwatermarkedDeprecated: HostSignRawRequest,
  rawWithLegacyAccountUnwatermarkedDeprecated: Struct({
    account: AccountId,
    data: RawPayload,
  }),
});

/** `SignResponse = Result<HostSignPayloadResponse, String>` in `messages.rs`. */
const SignResponse = Result(HostSignPayloadResponse, str);

/**
 * `GetAccountAliasResponse = Result<HostAccountGetAliasResponse, RingVrfError>`.
 * `truapi::latest::HostAccountGetAliasResponse` is `LatestOf<v01::ContextualAlias>`
 * — an unversioned alias for `ContextualAlias`, which truapi's JS codegen
 * exports under its own name rather than duplicating it. Confirmed against
 * `ring_vrf_response_messages_match_host_papp_0_8_11_fixtures` in
 * `messages.rs`, whose fixture bytes decode `ContextualAlias` directly with
 * no extra version tag.
 */
const GetAccountAliasResponse = Result(ContextualAlias, RingVrfError);

/** Mirrors `OnExistingAllowancePolicy` in `messages.rs`. */
const OnExistingAllowancePolicy = Enum({
  ignore: _void,
  increase: _void,
});

/** Mirrors `ResourceAllocationRequest` in `messages.rs`. */
const ResourceAllocationRequest = Struct({
  callingProductId: str,
  resources: Vector(AllocatableResource),
  onExisting: OnExistingAllowancePolicy,
});

/**
 * Mirrors `SsoAllocatedResource` in `messages.rs`. Variant order and field
 * widths confirmed against `allocated_resource_debug_redacts_private_material...`
 * and `auto_signing_secret_is_fixed_width_on_the_mobile_wire` in that file.
 */
const SsoAllocatedResource = Enum({
  statementStoreAllowance: Struct({ slotAccountKey: Bytes() }),
  bulletinAllowance: Struct({ slotAccountKey: Bytes() }),
  smartContractAllowance: _void,
  autoSigning: Struct({
    productRootPrivateKey: Bytes(64),
    ringVrfDomainEntropy: Bytes(32),
  }),
});

/** Mirrors `SsoAllocationOutcome` in `messages.rs`. */
const SsoAllocationOutcome = Enum({
  allocated: SsoAllocatedResource,
  rejected: _void,
  notAvailable: _void,
});

/** `ResourceAllocationResponse = Result<Vec<SsoAllocationOutcome>, String>`. */
const ResourceAllocationResponse = Result(Vector(SsoAllocationOutcome), str);

/** `CreateTransactionResponse = Result<Vec<u8>, String>` in `messages.rs`. */
const CreateTransactionResponse = Result(Bytes(), str);

/** Mirrors `CreateTransactionPayload` in `messages.rs` (single `V1` variant). */
const CreateTransactionPayload = Enum({ v1: ProductAccountTxPayload });

/** Mirrors `CreateTransactionRequest` in `messages.rs`. */
const CreateTransactionRequest = Struct({ payload: CreateTransactionPayload });

/** Mirrors `CreateTransactionLegacyPayload` in `messages.rs` (single `V1` variant). */
const CreateTransactionLegacyPayload = Enum({ v1: LegacyAccountTxPayload });

/** Mirrors `CreateTransactionWithLegacyAccountRequest` in `messages.rs`. */
const CreateTransactionWithLegacyAccountRequest = Struct({
  payload: CreateTransactionLegacyPayload,
});

/** Mirrors `SignRawWithLegacyAccountRequest` in `messages.rs`. */
const SignRawWithLegacyAccountRequest = Struct({
  account: AccountId,
  data: RawPayload,
});

/** `SignRawWithLegacyAccountResponse = Result<Vec<u8>, String>` in `messages.rs`. */
const SignRawWithLegacyAccountResponse = Result(Bytes(), str);

/** `CreateAccountProofResponse = Result<HostAccountCreateProofResponse, RingVrfError>`. */
const CreateAccountProofResponse = Result(HostAccountCreateProofResponse, RingVrfError);

/** `SignVrfResponse = Result<VrfSignature, HostAccountSignVrfError>` in `messages.rs`. */
const SignVrfResponse = Result(VrfSignature, HostAccountSignVrfError);

/** Mirrors `ProductSubtreeRequest` in `messages.rs`. */
const ProductSubtreeRequest = Struct({ productId: str });

/** `ProductSubtreeResponse = Result<[u8; 32], String>` in `messages.rs`. */
const ProductSubtreeResponse = Result(Bytes32, str);

/** `RegisterRingVrfKeyResponse = Result<[u8; 32], RingVrfError>` in `messages.rs`. */
const RegisterRingVrfKeyResponse = Result(Bytes32, RingVrfError);

/** `ListRingVrfKeysResponse = Result<Vec<RegisteredRingVrfKey>, RingVrfError>`. */
const ListRingVrfKeysResponse = Result(Vector(RegisteredRingVrfKey), RingVrfError);

/** `RingVrfSignResponse = Result<Vec<u8>, RingVrfError>` in `messages.rs`. */
const RingVrfSignResponse = Result(Bytes(), RingVrfError);

/**
 * "A codec, payload type irrelevant" — the bound for a table of mixed codecs.
 *
 * It cannot be `Codec<unknown>`: `Codec<T>` carries `T` in both an argument
 * position (`Encoder<T>`) and a return position (`Decoder<T>`), so under
 * `strictFunctionTypes` it is invariant and no concrete `Codec<X>` is assignable
 * to any single instantiation of it. Splitting the two halves — accept anything
 * that encodes at least nothing and decodes at most something — is the widest
 * honest bound, and it still rejects a value that is not a codec at all.
 */
type AnyCodec = [Encoder<never>, Decoder<unknown>] & {
  enc: Encoder<never>;
  dec: Decoder<unknown>;
};

/**
 * Payload codec for every `v1::RemoteMessage` variant, keyed by name.
 *
 * `satisfies Record<RemoteMessageVariant, AnyCodec>` makes this a
 * compile error if an entry is missing, misspelled, or extra — but it does
 * NOT check key *order*, which is what `Enum` actually uses to assign wire
 * indices (via `Object.keys`). Declaration order here is therefore
 * cosmetic only; see `RemoteMessage` below for how the real wire order is
 * pinned to `REMOTE_MESSAGE_VARIANTS`.
 */
const REMOTE_MESSAGE_PAYLOADS = {
  Disconnected: _void,
  SignRequest: SignRequest,
  SignResponse: Response(SignResponse),
  GetAccountAliasRequest: ProductRequest(HostAccountGetAliasRequest),
  GetAccountAliasResponse: Response(GetAccountAliasResponse),
  ResourceAllocationRequest: ResourceAllocationRequest,
  ResourceAllocationResponse: Response(ResourceAllocationResponse),
  CreateTransactionRequest: CreateTransactionRequest,
  CreateTransactionResponse: Response(CreateTransactionResponse),
  CreateTransactionWithLegacyAccountRequest: CreateTransactionWithLegacyAccountRequest,
  SignRawWithLegacyAccountRequest: SignRawWithLegacyAccountRequest,
  SignRawWithLegacyAccountResponse: Response(SignRawWithLegacyAccountResponse),
  CreateAccountProofRequest: ProductRequest(HostAccountCreateProofRequest),
  CreateAccountProofResponse: Response(CreateAccountProofResponse),
  SignVrfRequest: ProductRequest(HostAccountSignVrfRequest),
  SignVrfResponse: Response(SignVrfResponse),
  ProductSubtreeRequest: ProductSubtreeRequest,
  ProductSubtreeResponse: Response(ProductSubtreeResponse),
  RegisterRingVrfKeyRequest: ProductRequest(HostAccountRegisterRingVrfKeyRequest),
  RegisterRingVrfKeyResponse: Response(RegisterRingVrfKeyResponse),
  ListRingVrfKeysRequest: ProductRequest(HostAccountListRingVrfKeysRequest),
  ListRingVrfKeysResponse: Response(ListRingVrfKeysResponse),
  RingVrfSignRequest: ProductRequest(HostAccountRingVrfSignRequest),
  RingVrfSignResponse: Response(RingVrfSignResponse),
} satisfies Record<RemoteMessageVariant, AnyCodec>;

/**
 * `v1::RemoteMessage`.
 *
 * scale-ts's `Enum` assigns each variant's wire index by the position of its
 * key in `Object.keys(...)` of the object passed here. Rather than relying on
 * a second hand-aligned object literal to agree with `REMOTE_MESSAGE_VARIANTS`
 * (which a future edit could silently desync in the untested middle of the
 * range), this object's key order is *derived* from `REMOTE_MESSAGE_VARIANTS`
 * by construction: walk the array, look up each name's codec in
 * `REMOTE_MESSAGE_PAYLOADS`. The two therefore cannot drift out of sync — the
 * array is the only place variant order is ever written down.
 *
 * The `as typeof REMOTE_MESSAGE_PAYLOADS` cast only restores the precise
 * per-key codec types that `Object.fromEntries` widens away; it has no
 * runtime effect and does not touch key order.
 */
export const RemoteMessage = Enum(
  Object.fromEntries(
    REMOTE_MESSAGE_VARIANTS.map((variant) => [variant, REMOTE_MESSAGE_PAYLOADS[variant]] as const),
  ) as typeof REMOTE_MESSAGE_PAYLOADS,
);

export const VersionedRemoteMessage = Enum({ V1: RemoteMessage });

/**
 * The outer `RemoteMessage { message_id: String, data: RemoteMessageData }`.
 *
 * This — not `VersionedRemoteMessage` alone — is what each entry of
 * `StatementData.request.data` actually carries. `messageId` is the
 * correlation id the core generates per request; every response variant
 * echoes it back as `respondingTo`, and `reply_matcher` in
 * `../host-rust-core/rust/crates/truapi-server/src/runtime/sso_remote.rs`
 * drops any message whose `respondingTo` does not match. Dropping the
 * envelope would therefore produce replies the core silently ignores.
 */
export const RemoteMessageEnvelope = Struct({
  messageId: str,
  data: VersionedRemoteMessage,
});

/** Decoded value of one `v1::RemoteMessage`, as a discriminated union. */
export type RemoteMessageValue = Parameters<typeof RemoteMessage.enc>[0];

/** The payload type carried by one named `v1::RemoteMessage` variant. */
export type RemoteMessagePayload<T extends RemoteMessageValue['tag']> = Extract<
  RemoteMessageValue,
  { tag: T }
>['value'];
