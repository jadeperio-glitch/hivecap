"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface Message {
  role: "user" | "assistant";
  content: string;
}

function TypingIndicator() {
  return (
    <div className="flex items-end gap-3 mb-4">
      <div className="w-8 h-8 rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center flex-shrink-0">
        <span className="text-sm">🐝</span>
      </div>
      <div className="bg-[#1c1c1c] border border-gold/15 rounded-2xl rounded-bl-sm px-4 py-3">
        <div className="flex gap-1.5 items-center h-5">
          <span className="w-2 h-2 bg-gold/60 rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-2 h-2 bg-gold/60 rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-2 h-2 bg-gold/60 rounded-full animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[75%] bg-gold text-charcoal rounded-2xl rounded-br-sm px-4 py-3 shadow-md shadow-gold/10">
          <p className="text-sm leading-relaxed whitespace-pre-wrap font-medium">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-end gap-3 mb-4">
      <div className="w-8 h-8 rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center flex-shrink-0">
        <span className="text-sm">🐝</span>
      </div>
      <div className="max-w-[75%] bg-[#1c1c1c] border border-gold/15 rounded-2xl rounded-bl-sm px-4 py-3 shadow-md">
        <p className="text-sm leading-relaxed text-cream/90 whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    </div>
  );
}

export default function BrainPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Welcome to HiveCap Brain. I'm your expert horse racing analyst — ask me about Beyer Speed Figures, pace analysis, pedigree research, wagering strategy, or the 2026 Kentucky Derby field. What are we handicapping today?",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, scrollToBottom]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.push("/login");
      } else {
        setUserEmail(user.email ?? null);
      }
    });
  }, [router]);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const newUserMessage: Message = { role: "user", content: trimmed };
    const updatedMessages = [...messages, newUserMessage];

    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);
    setError(null);

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    try {
      const response = await fetch("/api/brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      // Stream the response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";

      // Add placeholder assistant message
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "" },
      ]);
      setIsLoading(false);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        assistantContent += chunk;

        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: assistantContent,
          };
          return updated;
        });
      }
    } catch (err) {
      setIsLoading(false);
      const errMsg =
        err instanceof Error ? err.message : "An unexpected error occurred";
      setError(errMsg);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Sorry, I encountered an error: ${errMsg}. Please try again.`,
        },
      ]);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    // Auto-resize textarea
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
  }

  return (
    <div className="flex flex-col h-screen bg-charcoal">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-gold/20 bg-[#0a0a0a] px-4 md:px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gold/15 border border-gold/40 flex items-center justify-center">
              <span className="text-lg">🐝</span>
            </div>
            <div>
              <h1 className="font-playfair text-lg font-bold text-cream leading-none">
                HiveCap Brain
              </h1>
              {userEmail && (
                <p className="text-cream/35 text-xs mt-0.5 truncate max-w-[200px]">
                  {userEmail}
                </p>
              )}
            </div>
          </div>

          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 text-cream/50 hover:text-cream/80 text-sm font-medium border border-cream/10 hover:border-cream/20 rounded-lg px-3 py-2 transition-all duration-200"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
            Sign out
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
        <div className="max-w-4xl mx-auto">
          {messages.map((message, i) => (
            <MessageBubble key={i} message={message} />
          ))}
          {isLoading && <TypingIndicator />}
          {error && (
            <div className="flex justify-center mb-4">
              <div className="bg-red-900/20 border border-red-500/30 rounded-lg px-4 py-2">
                <p className="text-red-400 text-xs">{error}</p>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="flex-shrink-0 border-t border-gold/15 bg-[#0d0d0d] px-4 md:px-6 py-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-end gap-3 bg-[#1a1a1a] border border-gold/20 rounded-2xl px-4 py-3 focus-within:border-gold/50 transition-colors duration-200 shadow-lg">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask about a race, horse, or wagering strategy…"
              rows={1}
              disabled={isLoading}
              className="flex-1 bg-transparent text-cream placeholder:text-cream/25 text-sm resize-none leading-relaxed outline-none disabled:opacity-50 max-h-40 py-0.5"
            />
            <button
              onClick={sendMessage}
              disabled={isLoading || !input.trim()}
              className="flex-shrink-0 w-9 h-9 bg-gold rounded-xl flex items-center justify-center hover:bg-gold/85 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 shadow-md shadow-gold/20"
            >
              <svg
                className="w-4 h-4 text-charcoal"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.5}
                  d="M5 12h14M12 5l7 7-7 7"
                />
              </svg>
            </button>
          </div>
          <p className="text-cream/20 text-xs text-center mt-2">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  );
}
