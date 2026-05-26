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

interface ChatRow {
  id: number;
  role: string;
  content: string;
  tool_calls: unknown | null;
  metadata: unknown | null;
  created_at: string;
}

// GET /api/ai/history
router.get('/history', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await query<ChatRow>(
      `SELECT id, role, content, tool_calls, metadata, created_at
       FROM ai_chats WHERE user_id = $1 ORDER BY created_at ASC LIMIT 100`,
      [req.userId]
    );
    res.json({
      messages: result.rows.map(r => ({
        id: r.id,
        role: r.role,
        content: r.content,
        toolCalls: r.tool_calls,
        metadata: r.metadata,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('ai/history GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/ai/history — save a single message
router.post('/history', authenticate, async (req: Request, res: Response) => {
  try {
    const { role, content, toolCalls, metadata } = req.body as {
      role: string;
      content: string;
      toolCalls?: unknown;
      metadata?: unknown;
    };
    if (!role || content == null) {
      res.status(400).json({ error: 'role and content are required' });
      return;
    }
    const result = await query<{ id: number; created_at: string }>(
      `INSERT INTO ai_chats (user_id, role, content, tool_calls, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [
        req.userId,
        role,
        content,
        toolCalls != null ? JSON.stringify(toolCalls) : null,
        metadata != null ? JSON.stringify(metadata) : null,
      ]
    );
    res.json({ id: result.rows[0].id, createdAt: result.rows[0].created_at });
  } catch (err) {
    console.error('ai/history POST error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/ai/history — clear all messages for current user
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
