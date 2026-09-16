import { useMemo } from 'react';
import { useCustomAuth } from '../auth';
import { getConfig } from '../config/app';
import { BedrockChatClient } from '../api/BedrockChatClient';

/**
 * Provides a BedrockChatClient bound to the current user's temporary AWS
 * credentials. Returns null until credentials are available. Mirrors
 * useRssFeedClient, minus the alert wrapper: the chat page reports failures
 * inline in the transcript, where the user is already looking, rather than as
 * a toast.
 */
export function useBedrockChatClient(): BedrockChatClient | null {
  const { credentials } = useCustomAuth();

  return useMemo(() => {
    if (!credentials) return null;
    return new BedrockChatClient(credentials, getConfig().bedrock);
  }, [credentials]);
}
