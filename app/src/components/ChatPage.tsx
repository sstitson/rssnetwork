import { useEffect, useRef, useState } from 'react';
import { useBedrockChatClient } from '../hooks/useBedrockChatClient';
import type { ChatTurn } from '../api/BedrockChatClient';

/**
 * Chat against Claude on Bedrock, called straight from the browser with the
 * signed-in user's Identity Pool credentials (see BedrockChatClient for the
 * security trade-off that implies).
 */

interface Message extends ChatTurn {
  /**
   * An inline failure notice. Rendered like an assistant message but kept out
   * of the payload — replaying past errors as context only confuses the model.
   */
  isError?: boolean;
}

const STORAGE_KEY = 'reader.chatHistory';

/** Keeps a long-running conversation from growing without bound. */
const MAX_STORED_MESSAGES = 100;

const GREETING: Message = {
  role: 'assistant',
  content: 'How can I help you today?',
};

/**
 * History lives in localStorage, not a cookie: transcripts blow past the ~4KB
 * cookie limit within a couple of replies, and a cookie would also be attached
 * to every request to the site, putting conversation text in access logs.
 */
const loadHistory = (): Message[] | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const messages = parsed.filter(
      (m): m is Message =>
        !!m &&
        typeof m.content === 'string' &&
        (m.role === 'user' || m.role === 'assistant'),
    );
    return messages.length > 0 ? messages : null;
  } catch {
    // Corrupt or unavailable storage should not take the page down.
    return null;
  }
};

const saveHistory = (messages: Message[]): void => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)),
    );
  } catch {
    /* quota exceeded or storage disabled — history just won't persist */
  }
};

export function ChatPage() {
  const client = useBedrockChatClient();
  const [messages, setMessages] = useState<Message[]>(() => loadHistory() ?? [GREETING]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { saveHistory(messages); }, [messages]);

  // Follow the conversation as it grows, including the pending indicator.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // Drop an in-flight request if the user navigates away mid-reply.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleClear = () => {
    abortRef.current?.abort();
    setMessages([GREETING]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage disabled */
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || pending || !client) return;

    const outgoing: Message[] = [...messages, { role: 'user', content: text }];
    setMessages(outgoing);
    setInput('');
    setPending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const reply = await client.send(
        outgoing.filter((m) => !m.isError),
        { signal: controller.signal },
      );
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      if (controller.signal.aborted) return;
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        },
      ]);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(false);
  };

  const isProd = window.location.hostname === __MASTER_DNS__;
  // Fill the viewport below the nav (52px) plus the non-prod stage banner (28px)
  // so the transcript scrolls internally and the composer stays put.
  const chromeHeight = isProd ? 52 : 80;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: `calc(100dvh - ${chromeHeight}px)`,
      maxWidth: '820px',
      margin: '0 auto',
      padding: '12px',
      boxSizing: 'border-box',
      minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        paddingBottom: '10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
          <span style={{ fontSize: '18px', fontWeight: 700 }}>Chat</span>
          <span style={{ fontSize: '11px', opacity: 0.5, whiteSpace: 'nowrap' }}>
            Claude Sonnet 4.5 via Bedrock
          </span>
        </div>
        <button
          onClick={handleClear}
          title="Clear chat history"
          style={{
            flexShrink: 0,
            padding: '6px 14px',
            fontSize: '14px',
            fontWeight: 600,
            color: 'inherit',
            backgroundColor: 'transparent',
            border: '1px solid rgba(128,128,128,0.35)',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          Clear
        </button>
      </div>

      {/* Transcript */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '4px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {messages.map((message, index) => (
          <div
            key={index}
            style={{
              display: 'flex',
              justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div style={{
              maxWidth: '78%',
              padding: '10px 14px',
              borderRadius: '12px',
              fontSize: '15px',
              lineHeight: 1.5,
              // Model output is plain text, so preserve its newlines and let
              // long unbroken tokens (URLs, code) wrap instead of overflowing.
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              ...(message.role === 'user'
                ? { backgroundColor: '#3498db', color: '#fff' }
                : message.isError
                  ? {
                      backgroundColor: 'rgba(231,76,60,0.12)',
                      border: '1px solid rgba(231,76,60,0.4)',
                      color: '#e74c3c',
                    }
                  : {
                      backgroundColor: 'rgba(128,128,128,0.12)',
                      color: 'inherit',
                    }),
            }}>
              {message.content}
            </div>
          </div>
        ))}

        {pending && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              padding: '10px 14px',
              borderRadius: '12px',
              fontSize: '15px',
              backgroundColor: 'rgba(128,128,128,0.12)',
              opacity: 0.7,
            }}>
              Thinking…
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: '8px',
        paddingTop: '10px',
        borderTop: '1px solid rgba(128,128,128,0.2)',
      }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Skip while the IME is
            // mid-composition, where Enter commits the candidate instead.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={2}
          placeholder={client ? 'Type your message…' : 'Waiting for credentials…'}
          disabled={!client || pending}
          aria-label="Message"
          style={{
            flex: 1,
            resize: 'vertical',
            minHeight: '44px',
            padding: '10px 12px',
            fontSize: '15px',
            fontFamily: 'inherit',
            lineHeight: 1.4,
            color: 'inherit',
            backgroundColor: 'Canvas',
            border: '1px solid rgba(128,128,128,0.35)',
            borderRadius: '8px',
            boxSizing: 'border-box',
          }}
        />
        <button
          onClick={pending ? handleStop : handleSend}
          disabled={!client || (!pending && !input.trim())}
          style={{
            flexShrink: 0,
            minWidth: '92px',
            padding: '11px 18px',
            fontSize: '15px',
            fontWeight: 600,
            color: '#fff',
            backgroundColor: pending ? '#e74c3c' : '#3498db',
            border: 'none',
            borderRadius: '8px',
            cursor: (!client || (!pending && !input.trim())) ? 'not-allowed' : 'pointer',
            opacity: (!client || (!pending && !input.trim())) ? 0.5 : 1,
          }}
        >
          {pending ? 'Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
}
