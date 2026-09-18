/**
 * Chat: create/resolve rooms and bots, post messages, and stream the room list.
 * Chat state is one flat namespace, so the `ProductContext` every handler takes
 * goes unused.
 *
 * The inbound direction has no place here: an action delivered *to* a product
 * travels down that product's own connection, which is why `injectChatAction`
 * lives on the control API instead.
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

/** What a room-list subscriber is told — narrower than `ChatRoom`, and the core's codec only carries these two fields. */
export function roomListSnapshot(state: HostState): Array<{ roomId: string; participatingAs: 'RoomHost' | 'Bot' }> {
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
