/**
 * @jest-environment jsdom
 */
import React, { useState } from 'react';
import { createStore, Provider } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Constants,
  StepTypes,
  StepEvents,
  ContentTypes,
  EModelEndpoint,
} from 'librechat-data-provider';
import type { TMessage, ChatEvent, TConversation } from 'librechat-data-provider';
import type { ChatStream, ChatTransport, ChatSendRequest, ChatStreamStatus } from '../../../core';
import type { ChatHost, TurnServices } from '../host';
import type { ExtendedFile } from '../../../core';
import { createTurnServices } from '../__fixtures__/services';
import { showStopButtonByIndex } from '../../generation';
import { isSubmittingFamily } from '../../submission';
import { useDrivenContract } from '../driven';
import { useFollowChat } from '../../follow';
import { ChatHostProvider } from '../host';
import { filesFamily } from '../../pane';

const conversationId = 'conversation-1';
const SIDE_PANE = 7;

const user: TMessage = {
  messageId: 'user-1',
  parentMessageId: Constants.NO_PARENT as string,
  conversationId,
  text: 'Hello',
  sender: 'User',
  isCreatedByUser: true,
  manualSkills: ['skill-a'],
};

const reply = (messageId: string, text: string, parentMessageId = 'user-1'): TMessage => ({
  messageId,
  parentMessageId,
  conversationId,
  text: '',
  sender: 'Assistant',
  isCreatedByUser: false,
  content: [{ type: ContentTypes.TEXT, text }],
});

const conversation: TConversation = {
  conversationId,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
  title: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
};

type TestStream = ChatStream & { push(event: ChatEvent): void; closed: boolean };

const createStream = (): TestStream => {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  const stream: TestStream = {
    streamId: conversationId,
    generationCreatedAt: 3000,
    closed: false,
    push(event) {
      queued.push(event);
      wake?.();
    },
    close() {
      stream.closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queued.length > 0) {
          yield queued.shift() as ChatEvent;
        }
        if (stream.closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return stream;
};

/** A transport that can start a generation: every send and every attachment opens a stream. */
const createTransport = () => {
  const streams: TestStream[] = [];
  let status: ChatStreamStatus = { active: false };
  const open = (): TestStream => {
    const stream = createStream();
    streams.push(stream);
    return stream;
  };
  const sendMessages = jest.fn(
    async (_request: ChatSendRequest): ReturnType<ChatTransport['sendMessages']> => ({
      status: 'stream',
      stream: open(),
    }),
  );
  const abort = jest.fn(async () => ({ success: true }));
  const reconnectToStream = jest.fn(async () => (status.active ? open() : null));
  const transport: ChatTransport = {
    sendMessages,
    abort,
    reconnectToStream,
    getStatus: async () => status,
  };
  return {
    transport,
    streams,
    sendMessages,
    abort,
    reconnectToStream,
    setStatus: (next: ChatStreamStatus) => {
      status = next;
    },
  };
};

const runStep = (id: string, runId: string) => ({
  id,
  runId,
  index: 0,
  type: StepTypes.MESSAGE_CREATION,
  stepDetails: { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: id } },
  usage: null,
});

const created = (message: TMessage, responseMessageId: string, turn: object = {}): ChatEvent =>
  ({
    type: 'created',
    data: { created: true, message, turn: { responseMessageId, ...turn } },
  }) as ChatEvent;

const opened = (runId: string): ChatEvent =>
  ({
    type: 'step',
    data: { event: StepEvents.ON_RUN_STEP, data: runStep('s0', runId) },
  }) as ChatEvent;

const token = (text: string): ChatEvent =>
  ({
    type: 'step',
    data: {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: { id: 's0', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
    },
  }) as ChatEvent;

const final = (requestMessage: TMessage, responseMessage: TMessage): ChatEvent =>
  ({
    type: 'final',
    data: { final: true, conversation: { conversationId }, requestMessage, responseMessage },
  }) as ChatEvent;

const ids = (messages: TMessage[] | undefined) =>
  (messages ?? []).map((message) => message.messageId);
const textOf = (messages: TMessage[] | undefined, messageId: string) =>
  (messages?.find((message) => message.messageId === messageId)?.content ?? []).map(
    (part) => (part as { text?: string } | undefined)?.text,
  );

/** Lets promises settle and the frame that writes streamed tokens run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

function setup({
  stored = [user, reply('response-1', 'Hi')],
  services = createTurnServices(),
  canSend,
}: { stored?: TMessage[]; services?: TurnServices; canSend?: () => boolean } = {}) {
  const queryClient = new QueryClient();
  const store = createStore();
  const harness = createTransport();
  const loadMessages = jest.fn(async () => stored);
  const host: ChatHost = {
    usePaneConversation: () => {
      const [held, setConversation] = useState<TConversation | null>(conversation);
      return { conversation: held, setConversation };
    },
    useNewConversation: () => () => undefined,
    useTurnServices: () => services,
    useAbortStream: () => () => Promise.reject(new Error('unused')),
    useMessageCache: () => {
      throw new Error('A driven chat reads its own messages');
    },
    useFeedbackEnabled: () => false,
    useMessages: () => ({ messages: null, isLoading: false, isFetching: false }),
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <ChatHostProvider host={host}>{children}</ChatHostProvider>
      </Provider>
    </QueryClientProvider>
  );
  const view = renderHook(
    ({ live }: { live: boolean }) => {
      const followed = useFollowChat({
        id: conversationId,
        transport: harness.transport,
        loadMessages,
        live,
      });
      const contract = useDrivenContract({
        id: conversationId,
        followed: canSend == null ? followed : { ...followed, canSend },
        index: SIDE_PANE,
      });
      return { followed, contract };
    },
    { wrapper, initialProps: { live: false } },
  );
  const ready = () => waitFor(() => expect(view.result.current.followed.isLoading).toBe(false));
  return { ...view, ...harness, store, services, loadMessages, ready };
}

describe('useDrivenContract', () => {
  it('sends the turn ask builds through the chat, and shows the generation it starts', async () => {
    const { result, sendMessages, streams, store, loadMessages, ready } = setup();
    await ready();

    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));

    /** The body main chat posts for this turn: a new message under the tail of the branch. */
    const { trigger, payload } = sendMessages.mock.calls[0][0];
    expect(trigger).toBe('submit-message');
    expect(payload).toMatchObject({
      endpoint: EModelEndpoint.agents,
      conversationId,
      text: 'Next question',
      parentMessageId: 'response-1',
    });
    /** The rows ask shows meanwhile, written by the chat: the message and its empty reply. */
    const shown = result.current.contract.getMessages() ?? [];
    expect(ids(shown).slice(0, 2)).toEqual(['user-1', 'response-1']);
    expect(shown[2]).toMatchObject({ isCreatedByUser: true, text: 'Next question' });
    expect(shown[3]).toMatchObject({ isCreatedByUser: false, parentMessageId: shown[2].messageId });
    expect(result.current.contract.isSubmitting).toBe(true);
    expect(store.get(isSubmittingFamily(SIDE_PANE))).toBe(true);

    const sent = shown[2];
    act(() => {
      streams[0].push(created(sent, 'response-2'));
      streams[0].push(opened('response-2'));
      streams[0].push(token('Answer'));
    });
    await settle();
    expect(ids(result.current.contract.getMessages())).toEqual([
      'user-1',
      'response-1',
      sent.messageId,
      'response-2',
    ]);
    expect(textOf(result.current.contract.getMessages(), 'response-2')).toEqual(['Answer']);

    act(() => streams[0].push(final(sent, reply('response-2', 'Answer', sent.messageId))));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));

    /** The turn's own final frame is its result: nothing is read back over it. */
    expect(loadMessages).toHaveBeenCalledTimes(1);
    expect(store.get(isSubmittingFamily(SIDE_PANE))).toBe(false);
    expect(store.get(showStopButtonByIndex(SIDE_PANE))).toBe(false);
    expect(result.current.contract.readOnly).toBeUndefined();
  });

  it('regenerates and continues a reply as main chat does', async () => {
    const { result, sendMessages, streams, ready } = setup();
    await ready();

    act(() => {
      result.current.contract.regenerate({ parentMessageId: 'user-1' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(sendMessages.mock.calls[0][0]).toMatchObject({
      trigger: 'regenerate-message',
      payload: { isRegenerate: true, text: 'Hello', manualSkills: ['skill-a'] },
    });
    /** No second user message: the empty reply is drawn under the one replayed. */
    const rerun = result.current.contract.getMessages() ?? [];
    expect(rerun.filter((message) => message.isCreatedByUser)).toHaveLength(1);
    expect(rerun[rerun.length - 1]).toMatchObject({ parentMessageId: 'user-1', content: [] });

    act(() => streams[0].push(final(user, reply('response-1b', 'Again'))));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));

    act(() => {
      result.current.contract.handleContinue({
        preventDefault: () => undefined,
      } as React.MouseEvent<HTMLButtonElement>);
    });
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(sendMessages.mock.calls[1][0]).toMatchObject({
      trigger: 'continue-message',
      payload: { isContinued: true, text: 'Hello' },
    });
  });

  it('stops the generation the chat is running', async () => {
    const { result, abort, streams, ready } = setup();
    await ready();
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));

    await act(async () => {
      void result.current.contract.stopGenerating();
      await Promise.resolve();
    });

    await waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(abort.mock.calls[0]).toMatchObject([
      { endpoint: EModelEndpoint.agents, streamId: conversationId, generationCreatedAt: 3000 },
    ]);
  });

  it('attaches again to a turn whose stream dropped, then takes the stored result', async () => {
    const { result, streams, reconnectToStream, setStatus, loadMessages, ready } = setup();
    await ready();
    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });
    await waitFor(() => expect(streams).toHaveLength(1));
    const sent = (result.current.contract.getMessages() ?? [])[2];
    act(() => {
      streams[0].push(created(sent, 'response-2'));
      streams[0].push(opened('response-2'));
      streams[0].push(token('Half'));
    });
    await settle();

    /** The stream ends with no final frame while the generation runs on. */
    setStatus({ active: true, streamId: conversationId, createdAt: 3000 });
    const { chat, canSend } = result.current.followed;
    const free: boolean[] = [];
    const unsubscribe = chat?.subscribe(() => free.push(canSend()));
    act(() => streams[0].close());
    await waitFor(() => expect(reconnectToStream).toHaveBeenCalledTimes(1), { timeout: 4000 });
    /**
     * Still the reader's turn in flight, so nothing else may be sent over it: not once the page
     * shows it attached again, and not in the moments between, when the chat reads as stopped.
     */
    unsubscribe?.();
    expect(free.length).toBeGreaterThan(0);
    expect(free).not.toContain(true);
    expect(result.current.contract.isSubmitting).toBe(true);
    expect(textOf(result.current.contract.getMessages(), 'response-2')).toEqual(['Half']);

    const stored = [
      user,
      reply('response-1', 'Hi'),
      sent,
      reply('response-2', 'Whole', sent.messageId),
    ];
    loadMessages.mockResolvedValue(stored);
    setStatus({ active: false });
    act(() => streams[1].push(final(sent, reply('response-2', 'Whole', sent.messageId))));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.contract.isSubmitting).toBe(false));
    expect(textOf(result.current.contract.getMessages(), 'response-2')).toEqual(['Whole']);
  });

  it('reads the stored messages when the server had already run the turn', async () => {
    const { result, sendMessages, loadMessages, ready } = setup();
    await ready();
    const stored = [user, reply('response-1', 'Hi'), reply('response-2', 'Already answered')];
    loadMessages.mockResolvedValue(stored);
    sendMessages.mockResolvedValueOnce({
      status: 'settled',
      conversationId,
      generationProtocolVersion: 2,
    });

    act(() => {
      result.current.contract.ask({ text: 'Next question' });
    });

    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ids(result.current.contract.getMessages())).toEqual(ids(stored)));
    expect(result.current.contract.isSubmitting).toBe(false);
  });

  it('refuses a turn while a generation it did not start is running, leaving the composer as it was', async () => {
    const { result, sendMessages, streams, setStatus, store, services, rerender, ready } = setup();
    await ready();
    const staged = new Map<string, ExtendedFile>([
      ['file-1', { file_id: 'file-1', progress: 1, size: 1 }],
    ]);
    act(() => store.set(filesFamily(SIDE_PANE), staged));

    setStatus({ active: true, streamId: conversationId, createdAt: 2000 });
    rerender({ live: true });
    await waitFor(() => expect(streams).toHaveLength(1));
    expect(result.current.contract.isSubmitting).toBe(true);

    let asked: unknown;
    act(() => {
      asked = result.current.contract.ask({ text: 'Next question' });
    });

    expect(asked).toBe(false);
    expect(sendMessages).not.toHaveBeenCalled();
    expect(services.releaseFiles).not.toHaveBeenCalled();
    expect(store.get(filesFamily(SIDE_PANE))).toBe(staged);
  });

  it('asks the chat, not the last render, whether a turn can be taken', async () => {
    /** The render says the conversation is free; the chat, asked at that instant, says it is not. */
    const { result, sendMessages, store, services, ready } = setup({ canSend: () => false });
    await ready();
    const staged = new Map<string, ExtendedFile>([
      ['file-1', { file_id: 'file-1', progress: 1, size: 1 }],
    ]);
    act(() => store.set(filesFamily(SIDE_PANE), staged));
    expect(result.current.contract.isSubmitting).toBe(false);

    let asked: unknown;
    act(() => {
      asked = result.current.contract.ask({ text: 'Next question' });
    });

    expect(asked).toBe(false);
    expect(sendMessages).not.toHaveBeenCalled();
    expect(services.releaseFiles).not.toHaveBeenCalled();
    expect(store.get(filesFamily(SIDE_PANE))).toBe(staged);
    expect(store.get(isSubmittingFamily(SIDE_PANE))).toBe(false);
  });
});
