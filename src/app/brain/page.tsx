"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { HiveCapLogo } from "@/components/HiveCapLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface UserDocument {
  id: string;
  filename: string;
  created_at: string;
}

type UploadStatus = "idle" | "uploading" | "done" | "error";

const MAX_BYTES = 10 * 1024 * 1024;

const WELCOME_MESSAGE: Message = {
  role: "assistant",
  content:
    "Welcome to HiveCap Brain. I'm your expert horse racing analyst — ask me about Beyer Speed Figures, pace analysis, pedigree research, wagering strategy, or the 2026 Kentucky Derby field. What are we handicapping today?",
};

function TypingIndicator() {
  return (
    <div className="flex items-end gap-3 mb-4">
      <div className="w-8 h-8 rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center flex-shrink-0">
        <span className="text-sm">🐝</span>
      </div>
      <div className="bg-[#EDE9E1] dark:bg-[#1c1c1c] border border-gold/15 rounded-2xl rounded-bl-sm px-4 py-3">
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
      <div className="max-w-[75%] bg-[#EDE9E1] dark:bg-[#1c1c1c] border border-gold/15 rounded-2xl rounded-bl-sm px-4 py-3 shadow-md">
        <p className="text-sm leading-relaxed text-charcoal/90 dark:text-cream/90 whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    </div>
  );
}

export default function BrainPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Conversation persistence state
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);

  // Post to Feed modal state
  const [showFeedModal, setShowFeedModal] = useState(false);
  const [feedDraft, setFeedDraft] = useState("");
  const [feedPosting, setFeedPosting] = useState(false);
  const [feedPostError, setFeedPostError] = useState<string | null>(null);
  const [feedPostSuccess, setFeedPostSuccess] = useState(false);

  // Document upload state
  const [documents, setDocuments] = useState<UserDocument[]>([]);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showDocs, setShowDocs] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, scrollToBottom]);

  const fetchDocuments = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("user_documents")
      .select("id, filename, created_at")
      .order("created_at", { ascending: false });
    if (data) setDocuments(data);
  }, []);

  const fetchRecentConversation = useCallback(async () => {
    setIsLoadingConversation(true);
    try {
      const supabase = createClient();

      const { data: conv, error: convErr } = await supabase
        .from("conversations")
        .select("id")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (convErr) {
        console.error("[brain] conversations query error:", convErr.message, convErr);
        return;
      }
      console.log("[brain] fetched conversation_id:", conv?.id ?? null);

      if (!conv) return; // no prior conversations — stay on welcome message

      setConversationId(conv.id);

      const { data: msgs, error: msgsErr } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: true });

      if (msgsErr) {
        console.error("[brain] messages query error:", msgsErr.message, msgsErr);
        return;
      }
      console.log("[brain] messages returned:", msgs?.length ?? 0);

      if (msgs && msgs.length > 0) {
        setMessages(msgs as Message[]);
      }
    } catch (err) {
      console.error("[brain] fetchRecentConversation threw:", err);
    } finally {
      setIsLoadingConversation(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.push("/login");
      } else {
        setUserEmail(user.email ?? null);
        fetchDocuments();
        fetchRecentConversation();
      }
    });
  }, [router, fetchDocuments, fetchRecentConversation]);

  async function handleUpload(file: File) {
    if (file.type !== "application/pdf") {
      setUploadStatus("error");
      setUploadError("PDF files only");
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadStatus("error");
      setUploadError("File exceeds 10 MB limit");
      return;
    }

    setUploadStatus("uploading");
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setUploadStatus("done");
      await fetchDocuments();
      setShowDocs(true);
      setTimeout(() => setUploadStatus("idle"), 3000);
    } catch (err) {
      setUploadStatus("error");
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = "";
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleUpload(file);
  }

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
          // Pass existing conversation_id if we have one; server creates one if not
          conversation_id: conversationId ?? undefined,
          user_message: trimmed,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      // Server creates a conversation if none existed — store the id for subsequent messages
      const convIdFromHeader = response.headers.get("X-Conversation-Id");
      if (convIdFromHeader) {
        console.log("[brain] conversation_id from server:", convIdFromHeader);
        setConversationId(convIdFromHeader);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";

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

  function openFeedModal() {
    // Pre-fill with the last assistant response
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    setFeedDraft(lastAssistant?.content ?? "");
    setFeedPostError(null);
    setFeedPostSuccess(false);
    setShowFeedModal(true);
  }

  async function submitFeedPost() {
    if (!feedDraft.trim() || feedPosting) return;
    setFeedPosting(true);
    setFeedPostError(null);
    try {
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: feedDraft.trim(),
          brain_verified: true,
          conversation_id: conversationId ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFeedPostSuccess(true);
      setTimeout(() => setShowFeedModal(false), 1200);
    } catch (err) {
      setFeedPostError(err instanceof Error ? err.message : "Failed to post");
    } finally {
      setFeedPosting(false);
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
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
  }

  const showDocPanel = documents.length > 0 || uploadStatus === "error";

  return (
    <div
      className={`flex flex-col h-screen bg-cream dark:bg-charcoal transition-colors duration-200 ${isDragOver ? "ring-2 ring-inset ring-gold/50" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay hint */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-charcoal/40 dark:bg-black/50 pointer-events-none">
          <div className="bg-white dark:bg-[#1a1a1a] border-2 border-dashed border-gold rounded-2xl px-8 py-6 text-center">
            <p className="text-gold font-medium text-lg">Drop PDF to upload</p>
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Header */}
      <header className="flex-shrink-0 border-b border-gold/20 bg-white dark:bg-[#0a0a0a] px-4 md:px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HiveCapLogo size="sm" markOnly />
            <div>
              <h1 className="font-playfair text-lg font-bold text-charcoal dark:text-cream leading-none">
                HiveCap Brain
              </h1>
              {userEmail && (
                <p className="text-charcoal/35 dark:text-cream/35 text-xs mt-0.5 truncate max-w-[200px]">
                  {userEmail}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />

            {/* Upload button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadStatus === "uploading"}
              className="flex items-center gap-1.5 text-charcoal/60 hover:text-gold dark:text-cream/60 dark:hover:text-gold text-sm font-medium border border-charcoal/10 hover:border-gold/40 dark:border-cream/10 dark:hover:border-gold/40 rounded-lg px-3 py-2 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Upload PDF to Brain"
            >
              {uploadStatus === "uploading" ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
                  </svg>
                  Uploading…
                </>
              ) : uploadStatus === "done" ? (
                <>
                  <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Uploaded
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 0L8 8m4-4l4 4" />
                  </svg>
                  Upload PDF
                </>
              )}
            </button>

            {/* Settings link */}
            <a
              href="/settings"
              className="flex items-center gap-1.5 text-charcoal/60 hover:text-gold dark:text-cream/60 dark:hover:text-gold text-sm font-medium border border-charcoal/10 hover:border-gold/40 dark:border-cream/10 dark:hover:border-gold/40 rounded-lg px-3 py-2 transition-all duration-200"
            >
              Settings
            </a>

            {/* Community Feed link */}
            <a
              href="/feed"
              className="flex items-center gap-1.5 text-charcoal/60 hover:text-gold dark:text-cream/60 dark:hover:text-gold text-sm font-medium border border-charcoal/10 hover:border-gold/40 dark:border-cream/10 dark:hover:border-gold/40 rounded-lg px-3 py-2 transition-all duration-200"
            >
              Community Feed
            </a>

            {/* Post to Feed */}
            <button
              onClick={openFeedModal}
              disabled={messages.filter((m) => m.role === "assistant" && m.content).length <= 1}
              className="flex items-center gap-1.5 text-charcoal/60 hover:text-gold dark:text-cream/60 dark:hover:text-gold text-sm font-medium border border-charcoal/10 hover:border-gold/40 dark:border-cream/10 dark:hover:border-gold/40 rounded-lg px-3 py-2 transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Post last Brain response to the community feed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              Post to Feed
            </button>

            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 text-charcoal/50 hover:text-charcoal/80 dark:text-cream/50 dark:hover:text-cream/80 text-sm font-medium border border-charcoal/10 hover:border-charcoal/20 dark:border-cream/10 dark:hover:border-cream/20 rounded-lg px-3 py-2 transition-all duration-200"
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
        </div>
      </header>

      {/* Document panel */}
      {showDocPanel && (
        <div className="flex-shrink-0 border-b border-gold/15 bg-[#F9F7F2] dark:bg-[#0f0f0f] px-4 md:px-6 py-2">
          <div className="max-w-4xl mx-auto">
            {uploadStatus === "error" && uploadError && (
              <p className="text-red-500 text-xs mb-1">{uploadError}</p>
            )}
            {documents.length > 0 && (
              <button
                onClick={() => setShowDocs((v) => !v)}
                className="flex items-center gap-1.5 text-charcoal/50 dark:text-cream/50 hover:text-gold dark:hover:text-gold text-xs font-medium transition-colors duration-150"
              >
                <svg className="w-3.5 h-3.5 text-gold/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                {documents.length} doc{documents.length !== 1 ? "s" : ""} in Brain
                <svg
                  className={`w-3 h-3 transition-transform duration-200 ${showDocs ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {showDocs && documents.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {documents.map((doc) => (
                  <span
                    key={doc.id}
                    className="inline-flex items-center gap-1 bg-gold/10 border border-gold/20 text-charcoal/70 dark:text-cream/70 rounded-full px-2.5 py-0.5 text-xs"
                  >
                    <svg className="w-3 h-3 text-gold/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                    {doc.filename}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

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
      <div className="flex-shrink-0 border-t border-gold/15 bg-[#EDE9E1] dark:bg-[#0d0d0d] px-4 md:px-6 py-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-end gap-3 bg-white dark:bg-[#1a1a1a] border border-gold/20 rounded-2xl px-4 py-3 focus-within:border-gold/50 transition-colors duration-200 shadow-lg">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask about a race, horse, or wagering strategy…"
              rows={1}
              disabled={isLoading}
              className="flex-1 bg-transparent text-charcoal dark:text-cream placeholder:text-charcoal/25 dark:placeholder:text-cream/25 text-sm resize-none leading-relaxed outline-none disabled:opacity-50 max-h-40 py-0.5"
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
          <p className="text-charcoal/20 dark:text-cream/20 text-xs text-center mt-2">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>

      {/* Post to Feed modal */}
      {showFeedModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowFeedModal(false); }}
        >
          <div className="bg-white dark:bg-[#111] border border-gold/20 rounded-2xl shadow-2xl w-full max-w-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-playfair text-base font-bold text-charcoal dark:text-cream">
                Post to Community Feed
              </h2>
              <button
                onClick={() => setShowFeedModal(false)}
                className="text-charcoal/40 hover:text-charcoal/70 dark:text-cream/40 dark:hover:text-cream/70 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <textarea
              value={feedDraft}
              onChange={(e) => setFeedDraft(e.target.value)}
              rows={6}
              maxLength={2000}
              className="w-full bg-[#F9F7F2] dark:bg-[#1a1a1a] border border-gold/15 rounded-xl px-4 py-3 text-sm text-charcoal dark:text-cream placeholder:text-charcoal/25 dark:placeholder:text-cream/25 resize-none outline-none focus:border-gold/40 transition-colors leading-relaxed"
              placeholder="Edit before posting…"
            />

            <div className="flex items-center justify-between mt-2 mb-4">
              <span className="inline-flex items-center gap-1 bg-gold/15 border border-gold/30 text-gold rounded-full px-2.5 py-0.5 text-xs font-medium">
                🐝 Brain-verified
              </span>
              <span className={`text-xs ${feedDraft.length > 1800 ? "text-red-400" : "text-charcoal/30 dark:text-cream/30"}`}>
                {feedDraft.length}/2000
              </span>
            </div>

            {feedPostError && (
              <p className="text-red-500 text-xs mb-3">{feedPostError}</p>
            )}

            {feedPostSuccess ? (
              <div className="flex items-center justify-center gap-2 py-2 text-green-500 text-sm font-medium">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Posted to feed!
              </div>
            ) : (
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => setShowFeedModal(false)}
                  className="text-sm text-charcoal/50 hover:text-charcoal/80 dark:text-cream/50 dark:hover:text-cream/80 px-4 py-2 rounded-lg border border-charcoal/10 dark:border-cream/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={submitFeedPost}
                  disabled={!feedDraft.trim() || feedPosting || feedDraft.length > 2000}
                  className="bg-gold text-charcoal text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gold/85 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 shadow-sm shadow-gold/20"
                >
                  {feedPosting ? "Posting…" : "Post"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
