import { Constants, ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { TurnHost, BuildTurnInput } from '../turns';
import type { ExtendedFile } from '../files';
import { buildTurn, prepareTurn, createRegenerate } from '../turns';
import { formatPastedText } from '../files';

const conversationId = 'conversation-1';

const user: TMessage = {
  messageId: 'user-1',
  parentMessageId: Constants.NO_PARENT as string,
  conversationId,
  text: 'Hello',
  sender: 'User',
  isCreatedByUser: true,
  manualSkills: ['skill-a'],
  quotes: ['quote-a'],
  files: [{ file_id: 'file-1', filepath: '/f', filename: 'f.txt', type: 'text/plain' }],
};

const response: TMessage = {
  messageId: 'response-1',
  parentMessageId: 'user-1',
  conversationId,
  text: 'Hi',
  sender: 'Assistant',
  isCreatedByUser: false,
  content: [
    { type: ContentTypes.THINK, [ContentTypes.THINK]: 'thinking', streamedIndex: 0 },
    { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'answer' },
  ],
};

const conversation = (overrides: Partial<TConversation> = {}): TConversation => ({
  conversationId,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent-1',
  title: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
  ...overrides,
});

const input = (overrides: Partial<BuildTurnInput> = {}): BuildTurnInput => ({
  text: 'Next question',
  params: { text: 'Next question' },
  options: {},
  conversationId,
  conversation: conversation(),
  latestMessage: response,
  cachedMessages: [user, response],
  canClearFiles: true,
  routeProjectId: null,
  isTemporary: false,
  ephemeralAgent: null,
  getSender: () => 'Assistant',
  userKey: undefined,
  manualSkills: [],
  quotes: [],
  reasoningOverride: undefined,
  code: {
    approvalMode: undefined,
    environmentMode: undefined,
    workspaces: undefined,
  },
  ...overrides,
});

describe('buildTurn', () => {
  it.each(['response-1', 'response-1_', 'response-1__', 'a'.repeat(256)])(
    'keeps the compaction placeholder distinct from the saved leaf %s',
    (messageId) => {
      const anchor = { ...response, messageId, createdAt: '2026-10-31T19:00:00Z' };
      const turn = buildTurn(
        input({
          text: '',
          params: { text: '', messageId, parentMessageId: messageId },
          options: { compact: true },
          latestMessage: anchor,
          cachedMessages: [user, anchor],
        }),
      );

      expect(turn.initialResponse.messageId).not.toBe(messageId);
      expect(turn.initialResponse.messageId.replace(/_+$/, '')).not.toBe(
        messageId.replace(/_+$/, ''),
      );
      expect(turn.initialResponse.messageId).toMatch(/_$/);
      expect(turn.initialResponse.messageId.length).toBeLessThanOrEqual(
        Constants.MAX_RESPONSE_MESSAGE_ID_LENGTH,
      );
      expect(turn.initialResponse.parentMessageId).toBe(messageId);
      expect(turn.submissionMessages).toEqual([user, anchor]);
      expect(turn.submission.userMessage.messageId).toBe(messageId);
    },
  );

  it('appends a user message and a response placeholder to the branch tail', () => {
    const turn = buildTurn(input());

    expect(turn.currentMsg).toMatchObject({
      text: 'Next question',
      isCreatedByUser: true,
      parentMessageId: 'response-1',
      conversationId,
    });
    expect(turn.initialResponse).toMatchObject({
      parentMessageId: turn.currentMsg.messageId,
      model: 'agent-1',
      content: [],
      isCreatedByUser: false,
    });
    expect(turn.submissionMessages).toEqual([user, response]);
    expect(turn.submission.userMessage.messageId).toBe(turn.currentMsg.messageId);
    expect(turn.submission.endpointOption.overrideUserMessageId).toBe(
      `${turn.currentMsg.messageId}${Constants.COMMON_DIVIDER}0`,
    );
    expect(turn.startsSubmitting).toBe(true);
    expect(turn.newChatPath).toBeUndefined();
  });

  it('starts a new chat at the route the project id scopes it to', () => {
    const turn = buildTurn(
      input({
        conversationId: Constants.NEW_CONVO as string,
        conversation: conversation({ conversationId: Constants.NEW_CONVO as string }),
        routeProjectId: 'a'.repeat(24),
      }),
    );

    expect(turn.conversationId).toBeNull();
    expect(turn.currentMsg.parentMessageId).toBe(Constants.NO_PARENT);
    expect(turn.submissionMessages).toEqual([]);
    expect(turn.newChatPath).toBe(`/c/new?projectId=${'a'.repeat(24)}`);
    expect(turn.submission.conversation.chatProjectId).toBe('a'.repeat(24));
  });

  it('ignores the route project id for an existing chat', () => {
    const turn = buildTurn(input({ routeProjectId: 'b'.repeat(24) }));

    expect(turn.submission.conversation.chatProjectId).toBeUndefined();
    expect(turn.newChatPath).toBeUndefined();
  });

  it('consumes the composer files of a fresh send', () => {
    const files = new Map<string, ExtendedFile>([
      [
        'temp-1',
        {
          file_id: 'file-2',
          temp_file_id: 'temp-1',
          filename: 'a.png',
          type: 'image/png',
          progress: 1,
          size: 1,
        },
      ],
    ]);
    const turn = buildTurn(input({ files }));

    expect(turn.currentMsg.files).toEqual([
      expect.objectContaining({ file_id: 'file-2', filename: 'a.png', type: 'image/png' }),
    ]);
    expect(turn.fileEffects).toEqual({
      submittedFileIds: ['temp-1', 'file-2', 'temp-1'],
      clearComposer: true,
    });
  });

  it('inlines the exact pending paste synchronously and never submits its upload identities', () => {
    const pastedText = '  exact\r\npaste with ``` and `````\n ';
    const files = new Map<string, ExtendedFile>([
      [
        'upload-key',
        { file_id: 'pending-id', temp_file_id: 'temp-id', progress: 0, size: 1, pastedText },
      ],
    ]);
    const turn = buildTurn(input({ text: '', files }));

    expect(turn.currentMsg.text).toBe(formatPastedText(pastedText));
    expect(turn.submission.userMessage.text).toBe(turn.currentMsg.text);
    expect(turn.currentMsg.files).toEqual([]);
    expect(turn.fileEffects).toEqual({
      submittedFileIds: [],
      canceledUploadIds: ['upload-key', 'pending-id', 'temp-id'],
      clearComposer: true,
    });
    expect(files.size).toBe(1);
  });

  it('keeps completed pastes and ordinary files as refs beside the pending inline paste', () => {
    const files = new Map<string, ExtendedFile>([
      ['pending', { file_id: 'pending', progress: 0.9, size: 1, pastedText: 'local' }],
      [
        'done-key',
        { file_id: 'done', temp_file_id: 'done-key', progress: 1, size: 1, pastedText: 'uploaded' },
      ],
      [
        'ordinary',
        {
          file_id: 'ordinary',
          progress: 1,
          size: 1,
          filename: 'pasted-text.txt',
          text: 'server preview',
        },
      ],
    ]);
    const turn = buildTurn(input({ files }));

    expect(turn.currentMsg.text).toBe(`Next question\n\n${formatPastedText('local')}`);
    expect(turn.currentMsg.files?.map((file) => file.file_id)).toEqual(['done', 'ordinary']);
    expect(turn.fileEffects).toEqual({
      submittedFileIds: ['done-key', 'done', 'done-key', 'ordinary', 'ordinary', undefined],
      canceledUploadIds: ['pending'],
      clearComposer: true,
    });
  });

  it.each([
    { compact: true },
    { isContinued: true },
    { isEdited: true },
    { overrideFiles: [] },
    { overrideFiles: user.files },
    { isRegenerate: true, targetResponseMessageId: response.messageId },
  ])('does not inline staged pastes when replaying or overriding files: %p', (options) => {
    const files = new Map<string, ExtendedFile>([
      ['pending', { file_id: 'pending', progress: 0, size: 1, pastedText: 'next draft only' }],
    ]);
    const turn = buildTurn(
      input({
        files,
        params: { text: user.text, messageId: user.messageId },
        options,
      }),
    );
    expect(turn.currentMsg.text).toBe('Next question');
    expect(turn.fileEffects?.canceledUploadIds).toBeUndefined();
    expect(turn.currentMsg.files?.map((file) => file.file_id) ?? []).not.toContain('pending');
    expect(files.size).toBe(1);
  });

  it('names a superseded source for discard without releasing or canceling its server file', () => {
    const files = new Map<string, ExtendedFile>([
      ['source-key', { file_id: 'source-id', temp_file_id: 'source-temp', progress: 1, size: 1 }],
      [
        'replacement',
        {
          file_id: 'replacement',
          progress: 0,
          size: 1,
          pastedText: 'corrected',
          replacesFileId: 'source-temp',
        },
      ],
    ]);
    const turn = buildTurn(input({ files }));
    expect(turn.currentMsg.text).toBe(`Next question\n\n${formatPastedText('corrected')}`);
    expect(turn.currentMsg.files).toEqual([]);
    expect(turn.fileEffects).toEqual({
      submittedFileIds: [],
      canceledUploadIds: ['replacement'],
      replacedFileIds: ['source-key', 'source-id', 'source-temp'],
      clearComposer: true,
    });
  });

  it('leaves composer files alone when the caller supplies the attachments', () => {
    const files = new Map<string, ExtendedFile>([
      ['temp-1', { file_id: 'file-2', temp_file_id: 'temp-1', progress: 1, size: 1 }],
    ]);
    const turn = buildTurn(input({ files, options: { overrideFiles: [] } }));

    expect(turn.currentMsg.files).toBeUndefined();
    expect(turn.fileEffects).toBeUndefined();
  });

  it('regenerates under the user message and replays its files', () => {
    const turn = buildTurn(
      input({
        text: user.text,
        params: {
          text: user.text,
          messageId: user.messageId,
          parentMessageId: Constants.NO_PARENT as string,
        },
        options: { isRegenerate: true, targetResponseMessageId: response.messageId },
      }),
    );

    expect(turn.regenerateShaped).toBe(true);
    expect(turn.initialResponse.parentMessageId).toBe('user-1');
    expect(turn.initialResponse.messageId).toBe('response-1_');
    expect(turn.submission.userMessage.overrideParentMessageId).toBe('user-1');
    expect(turn.submissionMessages.map((message) => message.messageId)).toEqual(['user-1']);
    expect(turn.currentMsg.files).toEqual(user.files);
    expect(turn.fileEffects?.clearComposer).toBe(false);
  });

  it.each([undefined, []])(
    'keeps pending drafts out of regenerations with original files %p',
    (files) => {
      const original = { ...user, files };
      const staged = new Map<string, ExtendedFile>([
        ['pending', { file_id: 'pending', progress: 0, size: 1, pastedText: 'unrelated draft' }],
      ]);
      let turn: ReturnType<typeof buildTurn> | undefined;
      const regenerate = createRegenerate(
        (params, options) => {
          turn = buildTurn(
            input({
              text: params.text,
              params,
              options: options ?? {},
              files: staged,
              cachedMessages: [original, response],
            }),
          );
        },
        () => [original, response],
      );
      regenerate(response);
      expect(turn?.currentMsg.text).toBe(original.text);
      expect(turn?.currentMsg.files ?? []).toEqual([]);
      expect(turn?.fileEffects).toBeUndefined();
      expect(staged.get('pending')?.pastedText).toBe('unrelated draft');
    },
  );

  it('edits a content part on a copy, leaving the cached response untouched', () => {
    const turn = buildTurn(
      input({
        text: user.text,
        params: { text: user.text, messageId: user.messageId, parentMessageId: user.messageId },
        options: {
          isEdited: true,
          editedMessageId: response.messageId,
          editedContent: { index: 1, type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'edited' },
        },
      }),
    );

    expect(turn.initialResponse.content).toEqual([
      { type: ContentTypes.THINK, [ContentTypes.THINK]: 'thinking' },
      { type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'edited' },
    ]);
    expect(turn.submission.editPrefixLength).toBe(2);
    expect(response.content?.[1]).toEqual({
      type: ContentTypes.TEXT,
      [ContentTypes.TEXT]: 'answer',
    });
    expect(response.content?.[0]).toHaveProperty('streamedIndex', 0);
  });

  it('seeds an Assistants response with a text part and leaves submitting to the stream', () => {
    const turn = buildTurn(
      input({
        conversation: conversation({
          endpoint: EModelEndpoint.assistants,
          assistant_id: 'asst-1',
          agent_id: undefined,
        }),
        userKey: 'never',
      }),
    );

    expect(turn.initialResponse.model).toBe('asst-1');
    expect(turn.initialResponse.content).toEqual([
      { type: ContentTypes.TEXT, [ContentTypes.TEXT]: { value: '' } },
    ]);
    expect(turn.submission.endpointOption.key).toBe('never');
    expect(turn.startsSubmitting).toBe(false);
  });
});

describe('createRegenerate', () => {
  const messages = [user, response];

  it('replays the user message a response answers, with its skills, quotes and reasoning', () => {
    const ask = jest.fn();
    createRegenerate(ask, () => messages)(response);

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'user-1', text: 'Hello' }),
      expect.objectContaining({
        isRegenerate: true,
        targetResponseMessageId: 'response-1',
        overrideManualSkills: ['skill-a'],
        overrideQuotes: ['quote-a'],
        overrideReasoning: null,
      }),
    );
  });

  it('targets no response when regenerating from the user message itself', () => {
    const ask = jest.fn();
    createRegenerate(ask, () => messages)(user);

    expect(ask.mock.calls[0][1]).toMatchObject({ targetResponseMessageId: undefined });
  });

  it('asks nothing when the parent is not a user message', () => {
    const ask = jest.fn();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    createRegenerate(ask, () => [response])(response);

    expect(ask).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});

describe('prepareTurn', () => {
  const host = (): TurnHost => {
    const {
      text: _text,
      params: _params,
      options: _options,
      latestMessage: _latest,
      cachedMessages: _cached,
      ...rest
    } = input();
    return rest;
  };
  const messages = [user, response];

  it('prepares a submitted message as a new turn after the tail, as ask builds it', () => {
    const prepared = prepareTurn(
      {
        trigger: 'submit-message',
        chatId: conversationId,
        messages,
        input: { parts: [{ type: 'text', text: 'Next question' }] },
      },
      host(),
    );

    expect(prepared.payload).toMatchObject({
      endpoint: EModelEndpoint.agents,
      conversationId,
      text: 'Next question',
      parentMessageId: 'response-1',
      isContinued: false,
    });
    expect(prepared.payload.isRegenerate).toBeFalsy();
    /** What is shown meanwhile: the history, the new user message, then its empty reply. */
    const shown = prepared.messages as TMessage[];
    expect(shown.slice(0, 2)).toEqual(messages);
    expect(shown[2]).toMatchObject({ isCreatedByUser: true, text: 'Next question' });
    expect(shown[3]).toMatchObject({ isCreatedByUser: false, parentMessageId: shown[2].messageId });
    expect(prepared.responseMessageId).toBe(shown[3].messageId);
    /** The same turn the builder gives ask for the same input. */
    const asked = buildTurn(input());
    expect(prepared.turn.submission.userMessage.parentMessageId).toBe(
      asked.submission.userMessage.parentMessageId,
    );
  });

  it('answers the parent a submitted message names, else the tail of the branch on screen', () => {
    const later: TMessage = { ...response, messageId: 'response-2', text: 'Another branch' };
    const submit = (
      metadata: { parentMessageId?: string } | undefined,
      latestMessage?: TurnHost['latestMessage'],
    ) =>
      prepareTurn(
        {
          trigger: 'submit-message',
          chatId: conversationId,
          messages: [user, response, later],
          input: { parts: [{ type: 'text', text: 'Next question' }], metadata },
        },
        { ...host(), latestMessage },
      ).payload.parentMessageId;

    /** With one branch, the last message of the list is its tail. */
    expect(submit(undefined)).toBe('response-2');
    expect(submit(undefined, () => response)).toBe('response-1');
    expect(submit({ parentMessageId: 'response-1' })).toBe('response-1');
  });

  it('prepares a regeneration that replays the user message the reply answers, with what it was sent with', () => {
    const prepared = prepareTurn(
      { trigger: 'regenerate-message', chatId: conversationId, messages, messageId: 'response-1' },
      host(),
    );

    expect(prepared.payload).toMatchObject({
      isRegenerate: true,
      text: 'Hello',
      manualSkills: ['skill-a'],
      quotes: ['quote-a'],
    });
    /** No second user message: the empty reply is drawn under the one replayed. */
    const shown = prepared.messages as TMessage[];
    expect(shown.filter((message) => message.isCreatedByUser)).toEqual([user]);
    expect(shown[shown.length - 1]).toMatchObject({
      isCreatedByUser: false,
      parentMessageId: 'user-1',
      messageId: prepared.responseMessageId,
    });
    expect(prepared.turn.regenerateShaped).toBe(true);
  });

  it('prepares a continuation of the reply it names', () => {
    const later: TMessage = { ...response, messageId: 'response-2', text: 'Another branch' };
    const prepared = prepareTurn(
      {
        trigger: 'continue-message',
        chatId: conversationId,
        messages: [user, response, later],
        messageId: 'response-1',
      },
      host(),
    );

    /** What main chat's continue builds when that reply is the one on screen. */
    const asked = buildTurn(
      input({
        params: { ...user },
        options: { isContinued: true, isRegenerate: true, isEdited: true },
        latestMessage: response,
        cachedMessages: [user, response, later],
      }),
    );
    expect(prepared.payload).toMatchObject({
      isContinued: true,
      text: 'Hello',
      responseMessageId: asked.submission.userMessage.responseMessageId,
      overrideParentMessageId: 'user-1',
    });
    expect(asked.submission.userMessage.responseMessageId).toContain('response-1');
    expect(prepared.responseMessageId).toBe(asked.initialResponse.messageId);
  });

  it('refuses to replay a message the list does not hold, or one that answers no user message', () => {
    const orphan: TMessage = { ...response, messageId: 'orphan', parentMessageId: 'gone' };
    expect(() =>
      prepareTurn(
        { trigger: 'regenerate-message', chatId: conversationId, messages, messageId: 'missing' },
        host(),
      ),
    ).toThrow('was not found');
    expect(() =>
      prepareTurn(
        {
          trigger: 'regenerate-message',
          chatId: conversationId,
          messages: [user, orphan],
          messageId: 'orphan',
        },
        host(),
      ),
    ).toThrow('was not found');
  });
});
