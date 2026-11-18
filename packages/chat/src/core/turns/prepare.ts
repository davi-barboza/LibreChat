import { createPayload } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ChatPrepareRequest, ChatPreparedRequest } from '../chat';
import type { BuiltTurn, BuildTurnInput } from './build';
import type { TAskProps, TOptions } from './types';
import { buildTurn } from './build';

/**
 * What a host supplies for every turn of a conversation: everything the turn builder reads
 * that is not the turn itself. The turn (its text, the message it replays, the branch it
 * answers) comes from the request a `Chat` prepares.
 */
export type TurnHost = Omit<
  BuildTurnInput,
  'text' | 'params' | 'options' | 'latestMessage' | 'cachedMessages'
> & {
  /**
   * The tail of the branch on screen, which a new turn answers. Without it, the last message of
   * the list, which is the tail of a conversation with one branch.
   */
  latestMessage?: (messages: TMessage[]) => TMessage | null;
};

/** A prepared request, with the turn it was built from for a host that applies its effects. */
export type PreparedTurn = ChatPreparedRequest & { turn: BuiltTurn };

type Turn = { text: string; params: TAskProps; options: TOptions; latest: TMessage | null };

/** A turn that replays a user message carries what that message was sent with. */
const replayed = (parent: TMessage, host: TurnHost): TurnHost => ({
  ...host,
  manualSkills: parent.manualSkills ?? [],
  quotes: parent.quotes ?? [],
  reasoningOverride: parent.reasoningOverride ?? undefined,
});

/**
 * Builds what a `Chat` posts for one turn, with the builder main chat's `ask` uses, so the
 * server reads the same body whichever one sent it:
 *
 * - a submitted message is a new turn after the tail of the branch (or the parent it names);
 * - a regeneration replays the user message the named reply answers, beside that reply;
 * - a continuation replays it too and carries the named reply on from where it stopped.
 *
 * The list to show while the request is in flight is the one main chat writes before its
 * stream starts: the turn's user message and an empty reply, or the empty reply alone for a
 * turn that reuses a saved user message.
 */
export function prepareTurn(request: ChatPrepareRequest, host: TurnHost): PreparedTurn {
  const { trigger, messages, input, messageId } = request;
  const tail = host.latestMessage?.(messages) ?? messages[messages.length - 1] ?? null;
  let turn: Turn;
  let inputs = host;
  if (trigger === 'submit-message') {
    const text = (input?.parts ?? []).map((part) => part.text).join('');
    turn = {
      text,
      params: { text, parentMessageId: input?.metadata?.parentMessageId ?? null },
      options: {},
      latest: tail,
    };
  } else {
    const named = messages.find((message) => message.messageId === messageId);
    const parentId = named?.isCreatedByUser === true ? named.messageId : named?.parentMessageId;
    const parent = messages.find((message) => message.messageId === parentId);
    if (named == null || parent == null || parent.isCreatedByUser !== true) {
      throw new Error('The message to replay was not found, or answers no user message');
    }
    inputs = replayed(parent, host);
    const params: TAskProps = { ...parent, text: parent.text ?? '' };
    turn =
      trigger === 'regenerate-message'
        ? {
            text: params.text,
            params,
            options: {
              isRegenerate: true,
              targetResponseMessageId: named.isCreatedByUser === true ? undefined : named.messageId,
            },
            latest: tail,
          }
        : {
            text: params.text,
            params,
            options: { isContinued: true, isRegenerate: true, isEdited: true },
            /** The reply carried on is the one named, wherever the branch on screen ends. */
            latest: named,
          };
  }
  const built = buildTurn({
    ...inputs,
    text: turn.text,
    params: turn.params,
    options: turn.options,
    latestMessage: turn.latest,
    cachedMessages: messages,
  });
  const { submission, currentMsg, initialResponse, submissionMessages } = built;
  return {
    turn: built,
    payload: createPayload(submission).payload,
    messages: built.regenerateShaped
      ? [...submissionMessages, initialResponse]
      : [...submissionMessages, currentMsg, initialResponse],
    responseMessageId: initialResponse.messageId,
  };
}
