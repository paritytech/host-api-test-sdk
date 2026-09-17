import { describe, expect, it } from 'vitest';
import { createChatCallbacks } from './chat.js';
import { createHostState } from './state.js';

const product = { productId: 'test.dot', executionKind: 'App' } as const;

describe('chat callbacks', () => {
  it('creates a room as New once and Exists on a repeat id', async () => {
    const state = createHostState();
    const { createChatRoom } = createChatCallbacks(state);

    const first = await createChatRoom(product, { roomId: 'room-1', name: 'Room', icon: 'icon.png' });
    const second = await createChatRoom(product, { roomId: 'room-1', name: 'Room', icon: 'icon.png' });

    expect(first.status).toBe('New');
    expect(second.status).toBe('Exists');
    expect(state.chatRooms.get('room-1')).toMatchObject({
      roomId: 'room-1',
      name: 'Room',
      icon: 'icon.png',
      participatingAs: 'RoomHost',
    });
  });

  it('registers a bot as New once and Exists on a repeat id', async () => {
    const state = createHostState();
    const { registerChatBot } = createChatCallbacks(state);

    const first = await registerChatBot(product, { botId: 'bot-1', name: 'Bot', icon: 'icon.png' });
    const second = await registerChatBot(product, { botId: 'bot-1', name: 'Bot', icon: 'icon.png' });

    expect(first.status).toBe('New');
    expect(second.status).toBe('Exists');
    expect(state.chatBots.get('bot-1')).toEqual({ botId: 'bot-1', name: 'Bot', icon: 'icon.png' });
  });

  it('posts a message to an existing room and logs it', async () => {
    const state = createHostState();
    const { createChatRoom, postChatMessage } = createChatCallbacks(state);
    await createChatRoom(product, { roomId: 'room-1', name: 'Room', icon: 'icon.png' });

    const payload = { tag: 'Text', value: { text: 'hi' } } as never;
    const response = await postChatMessage(product, { roomId: 'room-1', payload });

    expect(response.messageId).toBe('msg-1');
    expect(state.chatMessageLog).toEqual([
      { roomId: 'room-1', messageId: 'msg-1', payload, timestamp: expect.any(Number) },
    ]);
  });

  it('refuses to post to a room that does not exist', async () => {
    const state = createHostState();
    const { postChatMessage } = createChatCallbacks(state);
    const payload = { tag: 'Text', value: { text: 'hi' } } as never;

    await expect(postChatMessage(product, { roomId: 'missing', payload })).rejects.toThrow();
  });

  it('subscribeChatRooms emits the current room list immediately, then replacements', async () => {
    const state = createHostState();
    const { createChatRoom, subscribeChatRooms } = createChatCallbacks(state);
    await createChatRoom(product, { roomId: 'room-1', name: 'Room', icon: 'icon.png' });

    const iterator = subscribeChatRooms(product)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.isOk() ? first.value.value.rooms : null).toEqual([
      { roomId: 'room-1', participatingAs: 'RoomHost' },
    ]);

    const pendingSecond = iterator.next();
    await createChatRoom(product, { roomId: 'room-2', name: 'Room 2', icon: 'icon.png' });
    const second = await pendingSecond;
    expect(second.value.isOk() ? second.value.value.rooms : null).toEqual([
      { roomId: 'room-1', participatingAs: 'RoomHost' },
      { roomId: 'room-2', participatingAs: 'RoomHost' },
    ]);
  });

  it('stops delivering room-list updates once the subscription ends', async () => {
    const state = createHostState();
    const { createChatRoom, subscribeChatRooms } = createChatCallbacks(state);

    const iterator = subscribeChatRooms(product)[Symbol.asyncIterator]();
    await iterator.next();
    expect(state.chatRoomSubscribers.size).toBe(1);

    await iterator.return?.();
    expect(state.chatRoomSubscribers.size).toBe(0);

    // A room created after unsubscribing must not resurrect the listener.
    await createChatRoom(product, { roomId: 'room-1', name: 'Room', icon: 'icon.png' });
    expect(state.chatRoomSubscribers.size).toBe(0);
  });
});
