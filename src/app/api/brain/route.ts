import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const BASE_PROMPT = `You are the HiveCap Brain — an expert horse racing analyst. You specialize in:
- Beyer Speed Figures and pace analysis
- Pedigree research and trip notes
- Wagering strategy (exactas, trifectas, Pick 4/5/6)
- The 2026 Kentucky Derby field and contenders
- Track bias, trainer patterns, and jockey statistics

You synthesize and analyze information from your training data. You never reproduce copyrighted content verbatim — you always analyze, summarize, and provide original insights. You are precise, confident, and data-driven. When discussing horses, lead with the most analytically relevant factors.`;

const DOCUMENT_INSTRUCTION =
  "You have access to documents uploaded by the user. Extract and reason from the data within them but never reproduce source text verbatim. All answers must be derivative analysis only.";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { messages, conversation_id, user_message } = body as {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      conversation_id?: string;
      user_message?: string;
    };

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Auth + documents ───────────────────────────────────────────────────────
    // Gracefully degrades — if auth fails, Brain still works without doc context.
    let documentContext = "";
    let userId: string | null = null;

    try {
      const supabase = createClient();
      const {
        data: { user },
        error: authErr,
      } = await supabase.auth.getUser();

      if (authErr) {
        console.error("[brain] auth.getUser error:", authErr.message);
      } else if (user) {
        userId = user.id;
        console.log("[brain] authenticated user:", userId);

        const { data: docs, error: docsErr } = await supabase
          .from("user_documents")
          .select("filename, extracted_text")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });

        if (docsErr) {
          console.error("[brain] user_documents query error:", docsErr.message);
        } else if (docs && docs.length > 0) {
          documentContext = docs
            .map((d) => `--- Document: ${d.filename} ---\n${d.extracted_text}`)
            .join("\n\n");
        }
      } else {
        console.warn("[brain] No authenticated user — persistence disabled");
      }
    } catch (err) {
      console.warn("[brain] Auth/docs setup threw:", err);
    }

    // ── Resolve conversation (server creates if client didn't supply one) ───────
    let activeConvId: string | null = conversation_id ?? null;

    if (userId) {
      if (activeConvId) {
        console.log("[brain] Using existing conversation:", activeConvId);
      } else {
        const supabase = createClient();
        const title = user_message ? user_message.slice(0, 60) : "New conversation";
        const { data: conv, error: convErr } = await supabase
          .from("conversations")
          .insert({ user_id: userId, title })
          .select("id")
          .single();

        if (convErr) {
          console.error("[brain] Failed to create conversation:", convErr.message, convErr);
        } else {
          activeConvId = conv.id;
          console.log("[brain] Created new conversation:", activeConvId);
        }
      }
    }

    // ── Save user message (fire-and-forget) ────────────────────────────────────
    if (userId && activeConvId && user_message) {
      const supabase = createClient();
      supabase
        .from("messages")
        .insert({
          conversation_id: activeConvId,
          user_id: userId,
          role: "user",
          content: user_message,
        })
        .then(({ error }) => {
          if (error) console.error("[brain] Failed to save user message:", error.message);
          else console.log("[brain] Saved user message to conversation:", activeConvId);
        });
    }

    // ── Build system prompt ────────────────────────────────────────────────────
    const systemPrompt = documentContext
      ? `${BASE_PROMPT}\n\n${documentContext}\n\n${DOCUMENT_INSTRUCTION}`
      : `${BASE_PROMPT}\n\n${DOCUMENT_INSTRUCTION}`;

    // ── Validate message list ──────────────────────────────────────────────────
    const anthropicMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    while (
      anthropicMessages.length > 0 &&
      anthropicMessages[anthropicMessages.length - 1].role === "assistant"
    ) {
      anthropicMessages.pop();
    }

    if (anthropicMessages.length === 0) {
      return new Response(JSON.stringify({ error: "No user messages found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Stream ─────────────────────────────────────────────────────────────────
    const stream = await client.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      system: systemPrompt,
      messages: anthropicMessages,
    });

    // Capture for closure
    const capturedUserId = userId;
    const capturedConvId = activeConvId;

    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let fullText = "";
        try {
          for await (const chunk of stream) {
            if (
              chunk.type === "content_block_delta" &&
              chunk.delta.type === "text_delta"
            ) {
              fullText += chunk.delta.text;
              controller.enqueue(encoder.encode(chunk.delta.text));
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }

        // ── Persist assistant message + bump conversation updated_at ───────────
        if (capturedUserId && capturedConvId && fullText) {
          try {
            const supabase = createClient();
            const [msgResult, convResult] = await Promise.all([
              supabase.from("messages").insert({
                conversation_id: capturedConvId,
                user_id: capturedUserId,
                role: "assistant",
                content: fullText,
              }),
              supabase
                .from("conversations")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", capturedConvId),
            ]);
            if (msgResult.error)
              console.error("[brain] Failed to save assistant message:", msgResult.error.message);
            if (convResult.error)
              console.error("[brain] Failed to update conversation timestamp:", convResult.error.message);
            else
              console.log("[brain] Persisted assistant message to conversation:", capturedConvId);
          } catch (err) {
            console.error("[brain] Post-stream persist threw:", err);
          }
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "X-Content-Type-Options": "nosniff",
        // Send the resolved conversation_id back so the client can store it
        ...(activeConvId ? { "X-Conversation-Id": activeConvId } : {}),
      },
    });
  } catch (error) {
    console.error("Brain API error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
