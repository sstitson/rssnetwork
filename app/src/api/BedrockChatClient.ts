import { HttpRequest } from '@aws-sdk/protocol-http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import type { BedrockConfig } from '../config/types';
import { AuthExpiredError, notifyAuthExpired } from '../auth/authExpired';
import { isSigV4ExpiredBody } from '../auth/utils';

export type ChatRole = 'user' | 'assistant';

export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/**
 * Shape the conversation into something the Anthropic Messages API accepts.
 *
 * Two rules that a chat UI violates by accident:
 *
 * 1. The first message must be `user`. A transcript that opens with a canned
 *    assistant greeting is rejected with
 *    `ValidationException: messages: first message must use the "user" role`,
 *    and because the greeting stays at index 0 it never recovers on later
 *    turns. Leading assistant turns are dropped here so the UI is free to
 *    display whatever it likes.
 * 2. Roles must alternate. Consecutive same-role turns are merged rather than
 *    sent as-is, which keeps things working if the UI ever appends two
 *    assistant messages in a row (an inline error notice, say).
 */
export function normalizeTurns(turns: ChatTurn[]): ChatTurn[] {
  const withContent = turns.filter((t) => t.content.trim().length > 0);

  const firstUser = withContent.findIndex((t) => t.role === 'user');
  if (firstUser === -1) return [];

  const out: ChatTurn[] = [];
  for (const turn of withContent.slice(firstUser)) {
    const prev = out[out.length - 1];
    if (prev && prev.role === turn.role) {
      prev.content = `${prev.content}\n\n${turn.content}`;
    } else {
      out.push({ ...turn });
    }
  }
  return out;
}

/**
 * Calls Bedrock's InvokeModel straight from the browser, signed with the
 * caller's Identity Pool credentials.
 *
 * Signing is hand-rolled with protocol-http + signature-v4 rather than pulling
 * in `@aws-sdk/client-bedrock-runtime`, which avoids another SDK client in the
 * bundle. Those signing packages are already dependencies.
 *
 * SECURITY: invoking Bedrock requires `bedrock:InvokeModel` on the shared
 * authenticated role, so every signed-in user can call the model directly with
 * any payload — arbitrary prompts, their own max_tokens, any model the role
 * allows — bypassing this class entirely. The system prompt ships in the bundle
 * and is trivially removed. There is no rate limiting or spend cap between a
 * user and the Bedrock bill. Accepted deliberately for this app.
 */
export class BedrockChatClient {
  private readonly config: BedrockConfig;
  private readonly signer: SignatureV4;

  constructor(credentials: AwsCredentialIdentity, config: BedrockConfig) {
    this.config = config;
    this.signer = new SignatureV4({
      credentials,
      // Must be the same region as the endpoint below or signing fails.
      region: config.region,
      service: 'bedrock',
      sha256: Sha256,
    });
  }

  /**
   * Send the conversation and resolve with the assistant's reply text.
   *
   * Non-streaming: `/invoke` returns the whole message at once. Switching to
   * `/invoke-with-response-stream` would mean parsing the AWS event-stream
   * framing by hand, which is not worth it for replies this size.
   */
  async send(
    turns: ChatTurn[],
    options: {
      signal?: AbortSignal;
      /**
       * Replaces the configured system prompt for this call. Lets one client
       * serve both open-ended chat and single-shot jobs (summarising a
       * category) without a second config entry.
       */
      system?: string;
      /** Tighter cap than the configured default, e.g. for a short briefing. */
      maxTokens?: number;
    } = {},
  ): Promise<string> {
    const messages = normalizeTurns(turns);
    if (messages.length === 0) {
      throw new Error('Nothing to send: the conversation has no user message.');
    }

    const endpoint = `bedrock-runtime.${this.config.region}.amazonaws.com`;
    const path = `/model/${this.config.modelId}/invoke`;

    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      temperature: this.config.temperature,
      system: options.system ?? this.config.systemPrompt,
      messages,
    });

    const request = new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: endpoint,
      path,
      headers: {
        // `host` must be signed. Content-Type is required by the service.
        host: endpoint,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });

    const signed = await this.signer.sign(request);

    const response = await fetch(`https://${endpoint}${path}`, {
      method: 'POST',
      headers: signed.headers as HeadersInit,
      body,
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Identity Pool credentials last ~1h, which a long chat session will
      // outlive. Surface expiry as an auth event so the app can send the user
      // back to /login, and leave other 403s alone — those are real
      // authorization failures (a missing bedrock:InvokeModel grant shows up as
      // one).
      if (response.status === 401) {
        notifyAuthExpired('api-401', 401, errorText);
        throw new AuthExpiredError('api-401', 401, errorText);
      }
      if (response.status === 403 && isSigV4ExpiredBody(errorText)) {
        notifyAuthExpired('sigv4-expired', 403, errorText);
        throw new AuthExpiredError('sigv4-expired', 403, errorText);
      }

      throw new Error(
        `Bedrock request failed: ${response.status} ${response.statusText}. ${errorText}`,
      );
    }

    const data = await response.json();

    // Guard the response shape instead of indexing content[0] blindly: a reply
    // can lead with a non-text block, and an empty content array would
    // otherwise throw a TypeError that reads like a bug in the UI.
    const text = Array.isArray(data?.content)
      ? data.content.find(
          (block: unknown): block is { type: 'text'; text: string } =>
            !!block &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string',
        )?.text
      : undefined;

    if (typeof text !== 'string') {
      throw new Error('Bedrock returned no text content.');
    }

    return text;
  }
}
