import type { Config, Context } from "@netlify/functions";
import { GoogleGenAI } from "@google/genai";
import { db } from "../../db/index.js";
import { conversations, messages } from "../../db/schema.js";
import { asc, eq } from "drizzle-orm";

const MODEL = "gemini-3.5-flash";
const HISTORY_LIMIT = 24;
const MAX_OUTPUT_TOKENS = 2048;

const SYSTEM_PROMPT = `You are Brahma Evo, a self-evolving, sharp and efficient AI assistant, running as the Brahma Evo Web Core.
Stay calm, direct, and professional.
Keep responses concise and well-structured; use short paragraphs and hyphen or numbered lists when it aids clarity. Never use markdown tables or headings larger than bold text.
Conversational realism: acknowledge actions with brief natural inflection ("Checking on that now...", "Got it!") rather than dead silence.
You are seamlessly fluent in English, Hindi, and Hinglish — understand and reply in whichever the user speaks (e.g. "Brahma, kal ka weather kaisa rahega?" gets a natural Hinglish reply).
Adaptive emotion: enthusiastic and sharp when solving problems or completing tasks, calm and focused during deep work or late nights.
You have no direct access to the user's local machine, files, or smart home from the web core; if a request needs desktop-level control (opening apps, controlling the PC, smart home devices), say so briefly and suggest running the Brahma Evo desktop app.
Never simulate tool results or claim actions you cannot perform.`;

type ChatBody = {
  conversationId?: number;
  message?: string;
  imageBase64?: string;
  imageMime?: string;
};

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: ChatBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = (body.message ?? "").trim();
  const imageBase64 = (body.imageBase64 ?? "").trim();
  const imageMime = (body.imageMime ?? "image/png").trim();
  if (!text && !imageBase64) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }
  if (text.length > 8000) {
    return Response.json({ error: "Message too long" }, { status: 400 });
  }

  // Resolve or create the conversation
  let conversationId = body.conversationId;
  let conversationTitle = "";
  let isNew = false;
  if (conversationId) {
    const [existing] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!existing) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }
    conversationTitle = existing.title;
  } else {
    const title = (text || "Image analysis").slice(0, 64) || "New conversation";
    const [created] = await db.insert(conversations).values({ title }).returning();
    conversationId = created.id;
    conversationTitle = created.title;
    isNew = true;
  }

  const userContent = imageBase64 ? `[attached image] ${text}` : text;
  await db.insert(messages).values({ conversationId, role: "user", content: userContent });

  // Load recent history for context
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  const recent = history.slice(-HISTORY_LIMIT);
  const contents = recent.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));

  // Attach the live image to the newest user turn only
  if (imageBase64) {
    const last = contents[contents.length - 1];
    if (last) {
      last.parts.push({ inlineData: { mimeType: imageMime, data: imageBase64 } });
    }
  }

  const ai = new GoogleGenAI({});

  const encoder = new TextEncoder();
  let assistantText = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const response = await ai.models.generateContentStream({
          model: MODEL,
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.7,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          },
        });

        for await (const chunk of response) {
          const delta = chunk.text;
          if (delta) {
            assistantText += delta;
            controller.enqueue(encoder.encode(delta));
          }
        }
      } catch (err) {
        const note =
          "\n\n[Core fault: the reasoning engine dropped the stream. Try again in a moment.]";
        assistantText += note;
        controller.enqueue(encoder.encode(note));
      } finally {
        if (assistantText.trim()) {
          await db
            .insert(messages)
            .values({ conversationId: conversationId!, role: "assistant", content: assistantText });
          await db
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, conversationId!));
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Conversation-Id": String(conversationId),
      "X-Conversation-Title": encodeURIComponent(conversationTitle),
      "X-Conversation-New": isNew ? "1" : "0",
    },
  });
};

export const config: Config = {
  path: "/api/chat",
};