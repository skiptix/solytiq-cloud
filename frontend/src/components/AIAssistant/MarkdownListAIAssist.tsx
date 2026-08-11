import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import useAIStore from '../../store/useAIStore';
import useMarkdownListsStore from '../../store/useMarkdownListsStore';
import { apiGetAISettings, apiAIChat, apiGetAiToolDefs, apiExecuteAiTool } from '../../api/client';
import type { MarkdownList } from '../../types';
import Spinner from '@/components/animate-ui/Spinner';

// ── Scoped "full access" AI editor for a single Markdown page ──────────────
// Unlike the global Sol assistant (which can touch every list/task/timeline
// the user owns), this panel is deliberately narrowed to ONE document: the
// model only ever sees this page's markdown tools from the shared registry
// (aiTools.ts), and every tool call's markdown_list_id is force-overwritten
// to the currently open page before execution — so even a hallucinated or
// malicious id can never touch a different document. It has FULL control over
// this page: read it, edit/add/remove/move/reorder any block, wholesale
// restructure it, and change the page's own settings (name/emoji/etc.).

const MARKDOWN_TOOL_NAMES = new Set([
  'get_markdown_list',
  'update_markdown_list',
  'add_markdown_block',
  'add_markdown_blocks',
  'update_markdown_block',
  'remove_markdown_block',
  'move_markdown_block',
  'reorder_markdown_blocks',
  'set_markdown_content',
]);

const MAX_ROUNDS = 15;

// Tools that never change the document (pure reads) — used to decide whether a
// round mutated anything worth re-fetching / logging.
const MARKDOWN_READ_ONLY_TOOLS = new Set(['get_markdown_list']);

const SUGGESTIONS = [
  'Add a to-do section for grocery shopping',
  'Turn the bullet points into a numbered list',
  'Restructure this page with clear headings and sections',
];

interface LogEntry {
  id: string;
  role: 'user' | 'assistant' | 'action' | 'error';
  text: string;
}

function buildSystemPrompt(markdownListId: string, name: string): string {
  return [
    `You are an editing assistant embedded in a Markdown page called "${name}" (markdown_list_id: ${markdownListId}) inside Solytiq Cloud, a task/project management app. You have FULL control over this one page.`,
    `You may ONLY read and edit THIS one page — always pass markdown_list_id "${markdownListId}" to every tool call (it is enforced server-side regardless of what you pass, so never reference any other page's id).`,
    `Call get_markdown_list first to see the current blocks and their ids. Block types match the page's own '/' slash commands: heading (level 1-3), paragraph, bulleted-list-item, numbered-list-item, todo, quote, divider (layout 'columns' makes the sections on either side sit side-by-side), and link. Image blocks cannot be created by AI (they require a real file upload from the UI) but you may still remove, move, re-caption, or keep an existing one.`,
    `Choose the right tool: add_markdown_block / add_markdown_blocks to insert; update_markdown_block to edit one block; remove_markdown_block to delete; move_markdown_block or reorder_markdown_blocks to reorder; set_markdown_content to wholesale restructure the whole page at once (include EVERY block you want to keep — for images pass their image_id, for todos pass their existing id to keep the checkbox link). Use update_markdown_list to change the page's own settings (name, emoji, color, subtitle, visibility, full-width, folder).`,
    `Make as many tool calls as needed to fully satisfy the request. When you're done, reply with a brief, plain-language confirmation of what you changed — no need to repeat the whole document back.`,
  ].join('\n\n');
}

interface MarkdownListAIAssistProps {
  markdownListId: string;
  markdownListName: string;
  /** Called after any mutation with the freshly re-fetched page, so both its
   *  content (blocks/todo mirror) and its settings (name/emoji/…) stay live. */
  onUpdated: (md: MarkdownList) => void;
}

export default function MarkdownListAIAssist({ markdownListId, markdownListName, onUpdated }: MarkdownListAIAssistProps) {
  const { settings, settingsLoaded, setSettings, setSettingsLoaded } = useAIStore();
  const { getDetail } = useMarkdownListsStore();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (settingsLoaded) return;
    apiGetAISettings().then((d) => { setSettings(d); setSettingsLoaded(true); }).catch(() => setSettingsLoaded(true));
  }, [settingsLoaded, setSettings, setSettingsLoaded]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log, busy]);

  const refreshDoc = useCallback(async () => {
    try {
      const md = await getDetail(markdownListId);
      onUpdated(md);
    } catch {
      // best-effort — the next manual reload will still pick up the change
    }
  }, [getDetail, markdownListId, onUpdated]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || busy) return;
    setPrompt('');
    setBusy(true);
    setLog((l) => [...l, { id: crypto.randomUUID(), role: 'user', text }]);
    try {
      const { tools: allDefs } = await apiGetAiToolDefs();
      const tools = allDefs.filter((t) => MARKDOWN_TOOL_NAMES.has(t.function.name));
      const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: buildSystemPrompt(markdownListId, markdownListName) },
        { role: 'user', content: text },
      ];
      let finalText = '';
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await apiAIChat(messages, tools);
        const msg = res.choices[0].message;
        if (!msg.tool_calls?.length) { finalText = msg.content ?? ''; break; }

        messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
        let mutated = false;
        for (const call of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments); } catch { /* malformed args — let the tool reject them */ }
          // Force-scope every call to the open document, regardless of what the model passed.
          args.markdown_list_id = markdownListId;

          let result: { ok: boolean; result: string; summary?: string };
          try { result = await apiExecuteAiTool(call.function.name, args); }
          catch (e) { result = { ok: false, result: `Error: ${e instanceof Error ? e.message : 'request failed'}` }; }

          if (!MARKDOWN_READ_ONLY_TOOLS.has(call.function.name)) {
            if (result.ok) { mutated = true; setLog((l) => [...l, { id: crypto.randomUUID(), role: 'action', text: result.summary ?? result.result }]); }
            else setLog((l) => [...l, { id: crypto.randomUUID(), role: 'error', text: result.result }]);
          }
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result.result });
        }
        if (mutated) await refreshDoc();
      }
      if (finalText) setLog((l) => [...l, { id: crypto.randomUUID(), role: 'assistant', text: finalText }]);
    } catch {
      setLog((l) => [...l, { id: crypto.randomUUID(), role: 'error', text: 'Something went wrong — please try again.' }]);
    } finally {
      setBusy(false);
    }
  }, [busy, markdownListId, markdownListName, refreshDoc]);

  if (!settings.enabled) return null;

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        title="Ask AI to edit this page"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 5, height: 32, padding: '0 11px', borderRadius: 8, border: `1px solid ${open ? 'var(--color-primary)' : 'var(--color-border)'}`, background: open ? 'var(--color-surface-tint)' : 'var(--color-white)', cursor: 'pointer', transition: 'all 120ms' }}>
        <Icon name="auto_awesome" size={15} color="var(--color-primary)" />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-primary)' }}>Ask AI</span>
      </button>

      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 250, width: Math.min(360, window.innerWidth - 32), maxHeight: 460, display: 'flex', flexDirection: 'column', background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 14, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', animation: 'menuIn 140ms ease both', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--color-purple-pale-23)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Icon name="auto_awesome" size={15} color="var(--color-primary)" />
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>Edit with AI</span>
            </div>
            <button type="button" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2 }}>
              <Icon name="close" size={15} color="var(--color-text-quaternary)" />
            </button>
          </div>

          <div style={{ flex: 1, minHeight: 80, maxHeight: 280, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {log.length === 0 && (
              <div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 10 }}>
                  Tell it what to add, remove, or reorganize on this page — it can use every '/' block type (except images).
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => void send(s)}
                      style={{ textAlign: 'left', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--color-purple-pale-23)', background: 'var(--color-purple-pale-7)', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-primary)' }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {log.map((entry) => {
              if (entry.role === 'action') {
                return (
                  <div key={entry.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                    <Icon name="check_circle" size={13} color="var(--color-success)" />
                    <span>{entry.text}</span>
                  </div>
                );
              }
              if (entry.role === 'error') {
                return (
                  <div key={entry.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>
                    <Icon name="error" size={13} color="var(--color-error)" />
                    <span>{entry.text}</span>
                  </div>
                );
              }
              const isUser = entry.role === 'user';
              return (
                <div key={entry.id} style={{ alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '88%', padding: '7px 11px', borderRadius: 10, background: isUser ? 'var(--color-primary)' : 'var(--color-surface-tint-3)', color: isUser ? 'var(--color-white)' : 'var(--color-text-primary)', fontFamily: 'var(--font-body)', fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {entry.text}
                </div>
              );
            })}
            {busy && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>
                <Spinner size={11} thickness={2} trackColor="var(--color-border-strong)" durationMs={600} />
                Working…
              </div>
            )}
            <div ref={logEndRef} />
          </div>

          <div style={{ display: 'flex', gap: 6, padding: 12, borderTop: '1px solid var(--color-purple-pale-23)', flexShrink: 0 }}>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && prompt.trim() && !busy) void send(prompt); }}
              disabled={busy}
              placeholder="What should I change?"
              style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 12.5, border: '1.5px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', outline: 'none', minWidth: 0 }}
            />
            <button type="button" disabled={busy || !prompt.trim()} onClick={() => void send(prompt)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, borderRadius: 8, border: 'none', background: busy || !prompt.trim() ? 'var(--color-border-strong)' : 'var(--color-primary)', cursor: busy || !prompt.trim() ? 'default' : 'pointer', flexShrink: 0 }}>
              <Icon name={busy ? 'progress_activity' : 'arrow_upward'} size={15} color="var(--color-white)" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
