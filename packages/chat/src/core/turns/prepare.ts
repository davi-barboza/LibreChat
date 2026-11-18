import { createPayload } from 'librechat-data-provider';
import type { TMessage, TSubmission } from 'librechat-data-provider';
import type { ChatPrepareRequest, ChatPreparedRequest } from '../chat';

/**
 * A turn as main chat's `ask` leaves it: the submission the turn builder made, and the rows
 * `ask` shows while the request is in flight (the turn's user message and an empty reply, or
 * the empty reply alone for a turn that reuses a saved user message).
 */
export type SubmittedTurn = {
  submission: TSubmission;
  messages: TMessage[];
};

/** How a `Chat` is asked for a turn: the trigger it runs under, with what that trigger names. */
export type SubmittedTurnRequest = Pick<ChatPrepareRequest, 'trigger' | 'input' | 'messageId'>;

/**
 * Which of a `Chat`'s three requests a built turn is. A continuation and a regeneration name
 * the reply they produce; a submitted message carries its text and the parent it answers.
 */
export function describeSubmittedTurn({ submission }: SubmittedTurn): SubmittedTurnRequest {
  const { userMessage, initialResponse } = submission;
  if (submission.isContinued === true) {
    return { trigger: 'continue-message', messageId: initialResponse?.messageId };
  }
  if (submission.isRegenerate === true) {
    return { trigger: 'regenerate-message', messageId: initialResponse?.messageId };
  }
  return {
    trigger: 'submit-message',
    input: {
      parts: [{ type: 'text', text: userMessage.text ?? '' }],
      metadata: { parentMessageId: userMessage.parentMessageId ?? undefined },
    },
  };
}

/**
 * What a `Chat` posts and shows for a turn `ask` built: the body main chat's own start posts
 * for that submission, so the server reads the same request whichever sent it, and the rows
 * `ask` would have written, which the `Chat` writes itself so it can take them back when the
 * server answers the start with a generation that is not this turn.
 */
export function prepareSubmittedTurn({ submission, messages }: SubmittedTurn): ChatPreparedRequest {
  return {
    payload: createPayload(submission).payload,
    messages,
    responseMessageId: submission.initialResponse?.messageId,
  };
}
