import type { Config, Context } from "@netlify/functions";
import { db } from "../../db/index.js";
import { conversations, messages } from "../../db/schema.js";
import { asc, desc, eq, sql } from "drizzle-orm";

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const idParam = context.params.id;

  // GET /api/conversations — list recent conversations
  if (!idParam && req.method === "GET") {
    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
        messageCount: sql<number>`count(${messages.id})::int`,
      })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .groupBy(conversations.id)
      .orderBy(desc(conversations.updatedAt))
      .limit(100);

    return Response.json({ conversations: rows });
  }

  // GET /api/conversations/:id — full transcript
  if (idParam && req.method === "GET") {
    const id = Number(idParam);
    if (!Number.isInteger(id)) return Response.json({ error: "Bad id" }, { status: 400 });

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));

    return Response.json({ conversation, messages: rows });
  }

  // DELETE /api/conversations/:id
  if (idParam && req.method === "DELETE") {
    const id = Number(idParam);
    if (!Number.isInteger(id)) return Response.json({ error: "Bad id" }, { status: 400 });

    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export const config: Config = {
  path: ["/api/conversations", "/api/conversations/:id"],
};