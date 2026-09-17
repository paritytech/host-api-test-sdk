/**
 * Chat: create/resolve rooms and bots, post messages, and stream the room
 * list.
 *
 * Ported from `host-runtime.ts`'s `handleChatCreateRoom`,
 * `handleChatBotRegistration`, `handleChatListSubscribe` and
 * `handleChatPostMessage` — the same New/Exists idempotence on a repeated
 * id, the same default `participatingAs: 'RoomHost'` for a room this host
 * creates, and the same `msg-<n>` message-id counter format.
 *
 * `subscribeChatRooms` takes a `product: ProductContext`, but — matching
 * pre-migration, which never partitioned chat state by product — chat rooms
 * are one flat namespace here and `product` goes unused.
 *
 * Pre-migration's `handleChatActionSubscribe` / `injectChatAction` (a peer
 * message or button press delivered *to* the product) has no equivalent on
 * `ChatPlatform`: the new architecture delivers that through the *runtime's*
 * `publishChatAction`, not through a `HostCallbacks` subscription. There is
 * nothing to implement here for it — Task 14's `injectChatAction` control
 * method calls the runtime directly once that is wired up.
 */
import { ok } from 'neverthrow';
import type {
  GenericError,
  HostChatCreateRoomRequest,
  HostChatCreateRoomResponse,
  HostChatListSubscribeItem,
  HostChatPostMessageRequest,
  HostChatPostMessageResponse,
  HostChatRegisterBotRequest,
  HostChatRegisterBotResponse,
  Result,
} from '@parity/truapi';
import type { ProductContext } from '@parity/truapi-host';
import { createPushChannel } from './passive.js';
import type { HostState } from './state.js';

function roomListSnapshot(state: HostState): Array<{ roomId: string; participatingAs: 'RoomHost' | 'Bot' }> {
  return [...state.chatRooms.values()].map((room) => ({
    roomId: room.roomId,
    participatingAs: room.participatingAs,
  }));
}

export function createChatCallbacks(state: HostState): {
  createChatRoom(product: ProductContext, request: HostChatCreateRoomRequest): Promise<HostChatCreateRoomResponse>;
  registerChatBot(product: ProductContext, request: HostChatRegisterBotRequest): Promise<HostChatRegisterBotResponse>;
  postChatMessage(product: ProductContext, request: HostChatPostMessageRequest): Promise<HostChatPostMessageResponse>;
  subscribeChatRooms(product: ProductContext): AsyncIterable<Result<HostChatListSubscribeItem, GenericError>>;
} {
  return {
    async createChatRoom(
      _product: ProductContext,
      request: HostChatCreateRoomRequest,
    ): Promise<HostChatCreateRoomResponse> {
      const exists = state.chatRooms.has(request.roomId);
      if (!exists) {
        state.chatRooms.set(request.roomId, {
          roomId: request.roomId,
          name: request.name,
          icon: request.icon,
          participatingAs: 'RoomHost',
        });
        const snapshot = roomListSnapshot(state);
        for (const notify of state.chatRoomSubscribers) notify(snapshot);
      }
      return { status: exists ? 'Exists' : 'New' };
    },

    async registerChatBot(
      _product: ProductContext,
      request: HostChatRegisterBotRequest,
    ): Promise<HostChatRegisterBotResponse> {
      const exists = state.chatBots.has(request.botId);
      if (!exists) {
        state.chatBots.set(request.botId, { botId: request.botId, name: request.name, icon: request.icon });
      }
      return { status: exists ? 'Exists' : 'New' };
    },

    async postChatMessage(
      _product: ProductContext,
      request: HostChatPostMessageRequest,
    ): Promise<HostChatPostMessageResponse> {
      if (!state.chatRooms.has(request.roomId)) {
        throw new Error(`Room does not exist: ${request.roomId}`);
      }
      const messageId = `msg-${state.nextChatMessageId++}`;
      state.chatMessageLog.push({
        roomId: request.roomId,
        messageId,
        payload: request.payload,
        timestamp: Date.now(),
      });
      return { messageId };
    },

    subscribeChatRooms(_product: ProductContext): AsyncIterable<Result<HostChatListSubscribeItem, GenericError>> {
      const notify = (rooms: ReturnType<typeof roomListSnapshot>) => channel.push(ok({ rooms }));
      const channel = createPushChannel<Result<HostChatListSubscribeItem, GenericError>>(() => {
        state.chatRoomSubscribers.delete(notify);
      });
      state.chatRoomSubscribers.add(notify);
      notify(roomListSnapshot(state));
      return channel.iterable;
    },
  };
}
