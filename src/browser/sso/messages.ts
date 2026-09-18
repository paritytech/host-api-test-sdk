/**
 * SSO statement payload and remote-message codecs, mirroring
 * `host_logic/sso/messages/v1.rs`.
 *
 * Codecs come from `@parity/truapi` where a matching shape exists; the wrappers
 * and host-local shapes it does not cover are hand-reproduced from
 * `host_logic/sso/messages.rs`, field order verified against that source.
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

/**
 * Declaration order IS the wire protocol — scale-ts indexes by position, and
 * upstream pins indices 14+ with `#[codec(index = N)]`. Append only.
 */
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

/** `ProductRequest<P> { calling_product_id: String, payload: P }`. */
const ProductRequest = <T>(payload: Codec<T>) => Struct({ callingProductId: str, payload });

/** `Response<P> { responding_to: String, payload: P }`. */
const Response = <T>(payload: Codec<T>) => Struct({ respondingTo: str, payload });

/** Variant order pinned by `late_remote_message_variants_match_host_papp_order` (indices 0-6). */
const RingVrfError = Enum({
  ringNotFound: _void,
  notMember: _void,
  keyNotRegistered: _void,
  keyNotInRing: _void,
  notAllowlisted: _void,
  rejected: _void,
  unknown: Struct({ reason: str }),
});

const SignRequest = Enum({
  payload: HostSignPayloadRequest,
  raw: HostSignRawRequest,
  rawUnwatermarkedDeprecated: HostSignRawRequest,
  rawWithLegacyAccountUnwatermarkedDeprecated: Struct({
    account: AccountId,
    data: RawPayload,
  }),
});

const SignResponse = Result(HostSignPayloadResponse, str);

/**
 * The Ok side is `HostAccountGetAliasResponse`, which truapi's codegen exports
 * as plain `ContextualAlias` — it carries no extra version tag on the wire.
 */
const GetAccountAliasResponse = Result(ContextualAlias, RingVrfError);

const OnExistingAllowancePolicy = Enum({
  ignore: _void,
  increase: _void,
});

const ResourceAllocationRequest = Struct({
  callingProductId: str,
  resources: Vector(AllocatableResource),
  onExisting: OnExistingAllowancePolicy,
});

/** Field widths are fixed on the mobile wire — see `auto_signing_secret_is_fixed_width_on_the_mobile_wire`. */
const SsoAllocatedResource = Enum({
  statementStoreAllowance: Struct({ slotAccountKey: Bytes() }),
  bulletinAllowance: Struct({ slotAccountKey: Bytes() }),
  smartContractAllowance: _void,
  autoSigning: Struct({
    productRootPrivateKey: Bytes(64),
    ringVrfDomainEntropy: Bytes(32),
  }),
});

const SsoAllocationOutcome = Enum({
  allocated: SsoAllocatedResource,
  rejected: _void,
  notAvailable: _void,
});

const ResourceAllocationResponse = Result(Vector(SsoAllocationOutcome), str);

const CreateTransactionResponse = Result(Bytes(), str);

const CreateTransactionPayload = Enum({ v1: ProductAccountTxPayload });

const CreateTransactionRequest = Struct({ payload: CreateTransactionPayload });

const CreateTransactionLegacyPayload = Enum({ v1: LegacyAccountTxPayload });

const CreateTransactionWithLegacyAccountRequest = Struct({
  payload: CreateTransactionLegacyPayload,
});

const SignRawWithLegacyAccountRequest = Struct({
  account: AccountId,
  data: RawPayload,
});

const SignRawWithLegacyAccountResponse = Result(Bytes(), str);

const CreateAccountProofResponse = Result(HostAccountCreateProofResponse, RingVrfError);

const SignVrfResponse = Result(VrfSignature, HostAccountSignVrfError);

const ProductSubtreeRequest = Struct({ productId: str });

const ProductSubtreeResponse = Result(Bytes32, str);

const RegisterRingVrfKeyResponse = Result(Bytes32, RingVrfError);

const ListRingVrfKeysResponse = Result(Vector(RegisteredRingVrfKey), RingVrfError);

const RingVrfSignResponse = Result(Bytes(), RingVrfError);

/**
 * "A codec, payload type irrelevant". Not `Codec<unknown>`: `Codec<T>` is
 * invariant in `T` under `strictFunctionTypes`, so no concrete codec is
 * assignable to it. Splitting encoder and decoder is the widest honest bound.
 */
type AnyCodec = [Encoder<never>, Decoder<unknown>] & {
  enc: Encoder<never>;
  dec: Decoder<unknown>;
};

/**
 * `satisfies` catches a missing or extra entry but NOT key order, so order here
 * is cosmetic — `RemoteMessage` below takes the wire order from the array.
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
 * `v1::RemoteMessage`. Key order is derived from `REMOTE_MESSAGE_VARIANTS` so
 * the two cannot silently desync; the cast only restores the per-key codec
 * types `Object.fromEntries` widens away.
 */
export const RemoteMessage = Enum(
  Object.fromEntries(
    REMOTE_MESSAGE_VARIANTS.map((variant) => [variant, REMOTE_MESSAGE_PAYLOADS[variant]] as const),
  ) as typeof REMOTE_MESSAGE_PAYLOADS,
);

export const VersionedRemoteMessage = Enum({ V1: RemoteMessage });

/**
 * What each entry of `StatementData.request.data` actually carries — not
 * `VersionedRemoteMessage` alone. `reply_matcher` (`runtime/sso_remote.rs`)
 * silently drops any reply whose `respondingTo` does not echo this `messageId`.
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
