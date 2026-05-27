import { Router, Request, Response } from 'express';
import { query } from '../db';
import { authenticate } from '../middleware';

const router = Router();

// GET /api/ai/settings — readable by any authenticated user
router.get('/settings', authenticate, async (_req: Request, res: Response) => {
  try {
    const result = await query<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key IN ('ai_assistant_enabled', 'ai_model')"
    );
    const s: Record<string, string> = {};
    for (const row of result.rows) s[row.key] = row.value;
    res.json({
      enabled: s['ai_assistant_enabled'] !== 'false',
      model: s['ai_model'] ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
    });
  } catch (err) {
    console.error('ai/settings GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/ai/chat — proxy to OpenRouter
router.post('/chat', authenticate, async (req: Request, res: Response) => {
  try {
    const settingsResult = await query<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key IN ('ai_assistant_enabled', 'ai_model')"
    );
    const s: Record<string, string> = {};
    for (const row of settingsResult.rows) s[row.key] = row.value;

    if (s['ai_assistant_enabled'] === 'false') {
      res.status(403).json({ error: 'AI assistant is disabled' });
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: 'OPENROUTER_API_KEY is not configured' });
      return;
    }

    const model = s['ai_model'] ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';
    const { messages, tools } = req.body as {
      messages: unknown[];
      tools?: unknown[];
    };

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }

    const payload: Record<string, unknown> = { model, messages };
    if (tools?.length) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.FRONTEND_URL ?? 'http://localhost',
        'X-Title': 'Solytiq Cloud',
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => `HTTP ${upstream.status}`);
      console.error('OpenRouter error:', upstream.status, text);
      res.status(502).json({ error: 'AI service error', details: text });
      return;
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error('ai/chat POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Chat sessions ─────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  title: string | null;
  created_at: string;
}

// POST /api/ai/sessions — create a new chat session
router.post('/sessions', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<{ id: string; created_at: string; expires_at: string }>(
      `INSERT INTO ai_chat_sessions (user_id) VALUES ($1) RETURNING id, created_at, expires_at`,
      [req.userId]
    );
    res.json({ session: result.rows[0] });
  } catch (err) {
    console.error('ai/sessions POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/ai/sessions — list recent sessions (last 30 days) for user
router.get('/sessions', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<SessionRow>(
      `SELECT id, title, created_at
       FROM ai_chat_sessions
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('ai/sessions GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

interface ChatRow {
  id: number;
  role: string;
  content: string;
  tool_calls: unknown | null;
  metadata: unknown | null;
  created_at: string;
}

// GET /api/ai/sessions/:id — get messages for a specific session
router.get('/sessions/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const sess = await query<{ id: string }>(
      `SELECT id FROM ai_chat_sessions WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
      [req.params.id, req.userId]
    );
    if (!sess.rows.length) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const msgs = await query<ChatRow>(
      `SELECT id, role, content, tool_calls, metadata, created_at
       FROM ai_chats WHERE session_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({
      messages: msgs.rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        toolCalls: r.tool_calls,
        metadata: r.metadata,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('ai/sessions/:id GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/ai/sessions/:id — delete a session and its messages
router.delete('/sessions/:id', authenticate, async (req: Request, res: Response) => {
  try {
    await query(
      `DELETE FROM ai_chat_sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('ai/sessions/:id DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Per-message history ───────────────────────────────────────────────

// POST /api/ai/history — save a single message, tied to a session
router.post('/history', authenticate, async (req: Request, res: Response) => {
  try {
    const { role, content, toolCalls, metadata, sessionId } = req.body as {
      role: string;
      content: string;
      toolCalls?: unknown;
      metadata?: unknown;
      sessionId?: string;
    };
    if (!role || content == null) {
      res.status(400).json({ error: 'role and content are required' });
      return;
    }
    const result = await query<{ id: number; created_at: string }>(
      `INSERT INTO ai_chats (user_id, role, content, tool_calls, metadata, session_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [
        req.userId,
        role,
        content,
        toolCalls != null ? JSON.stringify(toolCalls) : null,
        metadata != null ? JSON.stringify(metadata) : null,
        sessionId ?? null,
      ]
    );

    // Set session title from the first user message
    if (role === 'user' && sessionId) {
      await query(
        `UPDATE ai_chat_sessions SET title = $1 WHERE id = $2 AND user_id = $3 AND title IS NULL`,
        [content.slice(0, 200), sessionId, req.userId]
      );
    }

    res.json({ id: result.rows[0].id, createdAt: result.rows[0].created_at });
  } catch (err) {
    console.error('ai/history POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/ai/history — clear all messages for current user (kept for compatibility)
router.delete('/history', authenticate, async (req: Request, res: Response) => {
  try {
    await query('DELETE FROM ai_chats WHERE user_id = $1', [req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('ai/history DELETE error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
