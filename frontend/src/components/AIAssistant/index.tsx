import { useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import useAIStore, {
  buildContext,
  buildSystemPrompt,
  buildTools,
  type AIChatMessage,
} from '../../store/useAIStore';
import useAppStore, {
  apiCreateTask,
  apiUpdateTask,
  apiDeleteTask,
  apiAddListTask,
} from '../../store/useAppStore';
import useAuthStore from '../../store/useAuthStore';
import {
  apiGetAISettings,
  apiAIChat,
  apiSaveAIMessage,
  apiClearAIHistory,
  apiCreateSection,
  apiUpdateSection,
  apiDeleteSection,
  apiUpdateListTask,
  apiDeleteListTask,
  apiCreateAISession,
  apiGetAISessions,
  apiGetAISessionMessages,
  apiDeleteAISession,
} from '../../api/client';
import AIBubble from './AIBubble';
import AIChatWindow from './AIChatWindow';
import AIRecentChats from './AIRecentChats';

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export default function AIAssistant() {
  const location = useLocation();
  const {
    isOpen,
    settings,
    messages,
    isThinking,
    settingsLoaded,
    recentSessions,
    showRecentChats,
    setOpen,
    setSettings,
    setMessages,
    addMessage,
    replaceMessage,
    removeMessage,
    setThinking,
    setSettingsLoaded,
    clearHistory,
    setCurrentSessionId,
    setRecentSessions,
    setShowRecentChats,
  } = useAIStore();

  const appStore = useAppStore();
  const { username, userId } = useAuthStore();
  const thinkingIdRef = useRef<string | null>(null);

  // Load AI settings once
  useEffect(() => {
    if (settingsLoaded) return;
    apiGetAISettings()
      .then((data) => { setSettings(data); setSettingsLoaded(true); })
      .catch(() => setSettingsLoaded(true));
  }, [settingsLoaded, setSettings, setSettingsLoaded]);

  // Create a new session every time the chat opens
  const handleToggle = useCallback(async () => {
    if (isOpen) {
      setOpen(false);
      return;
    }
    // Start fresh
    clearHistory();
    setCurrentSessionId(null);
    setOpen(true);

    if (settings.enabled && userId) {
      apiCreateAISession()
        .then((data) => setCurrentSessionId(data.session.id))
        .catch(() => {});
    }
  }, [isOpen, settings.enabled, userId, setOpen, clearHistory, setCurrentSessionId]);

  // ── Tool execution ────────────────────────────────────────────
  const executeTool = useCallback(
    async (call: ToolCall, ctx: ReturnType<typeof buildContext>): Promise<{ id: string; name: string; result: string; summary?: string }> => {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        return { id: call.id, name, result: 'Error: invalid arguments' };
      }

      try {
        if (name === 'create_dashboard_task') {
          const res = await apiCreateTask({
            title: args.title as string,
            deadline: (args.deadline as string) || undefined,
            priority: args.priority as 'High' | 'Medium' | 'Low' | undefined,
            note: (args.note as string) || undefined,
          });
          appStore.setDashTasks((prev) => [...prev, { ...res.task, id: Number(res.task.id) }]);
          return { id: call.id, name, result: `Created task "${res.task.title}"`, summary: `Added "${res.task.title}"` };
        }

        if (name === 'update_dashboard_task') {
          const taskId = Number(args.task_id);
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.deadline !== undefined) updates.deadline = (args.deadline as string) || null;
          if (args.priority !== undefined) updates.priority = args.priority;
          if (args.note !== undefined) updates.note = args.note;
          if (args.checked !== undefined) updates.checked = args.checked;
          await apiUpdateTask(taskId, updates as Parameters<typeof apiUpdateTask>[1]);
          appStore.setDashTasks((prev) =>
            prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
          );
          const task = appStore.dashTasks.find((t) => t.id === taskId);
          return { id: call.id, name, result: `Updated task ${taskId}`, summary: `Updated "${task?.title ?? taskId}"` };
        }

        if (name === 'delete_dashboard_task') {
          const taskId = Number(args.task_id);
          const task = appStore.dashTasks.find((t) => t.id === taskId);
          await apiDeleteTask(taskId);
          appStore.setDashTasks((prev) => prev.filter((t) => t.id !== taskId));
          return { id: call.id, name, result: `Deleted task ${taskId}`, summary: `Deleted "${task?.title ?? taskId}"` };
        }

        if (name === 'create_list_task') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const res = await apiAddListTask(listId, sectionId, {
            title: args.title as string,
            deadline: (args.deadline as string) || undefined,
            priority: args.priority as 'High' | 'Medium' | 'Low' | undefined,
            note: (args.note as string) || undefined,
          });
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId
                ? l
                : {
                    ...l,
                    sections: l.sections.map((s) =>
                      s.id !== sectionId
                        ? s
                        : { ...s, tasks: [...s.tasks, { ...res.task, id: Number(res.task.id) }] }
                    ),
                  }
            )
          );
          return { id: call.id, name, result: `Created task "${res.task.title}"`, summary: `Added "${res.task.title}"` };
        }

        if (name === 'update_list_task') {
          const listId = ctx.listId!;
          const taskId = Number(args.task_id);
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.deadline !== undefined) updates.deadline = (args.deadline as string) || null;
          if (args.priority !== undefined) updates.priority = args.priority;
          if (args.note !== undefined) updates.note = args.note;
          if (args.checked !== undefined) updates.checked = args.checked;
          await apiUpdateListTask(listId, taskId, updates as Parameters<typeof apiUpdateListTask>[2]);
          appStore.updateListTask(listId, taskId, updates as Parameters<typeof appStore.updateListTask>[2]);
          return { id: call.id, name, result: `Updated task ${taskId}`, summary: `Updated task #${taskId}` };
        }

        if (name === 'delete_list_task') {
          const listId = ctx.listId!;
          const taskId = Number(args.task_id);
          const task = appStore.lists
            .find((l) => l.id === listId)
            ?.sections.flatMap((s) => s.tasks)
            .find((t) => t.id === taskId);
          await apiDeleteListTask(listId, taskId);
          appStore.deleteListTask(listId, taskId);
          return { id: call.id, name, result: `Deleted task ${taskId}`, summary: `Deleted "${task?.title ?? taskId}"` };
        }

        if (name === 'create_section') {
          const listId = ctx.listId!;
          const res = await apiCreateSection(listId, {
            label: args.label as string,
            emoji: (args.emoji as string) || undefined,
          });
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId ? l : { ...l, sections: [...l.sections, { ...res.section, tasks: [] }] }
            )
          );
          return { id: call.id, name, result: `Created section "${res.section.label}"`, summary: `Created section "${res.section.label}"` };
        }

        if (name === 'update_section') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const updates: { label?: string; emoji?: string } = {};
          if (args.label) updates.label = args.label as string;
          if (args.emoji) updates.emoji = args.emoji as string;
          await apiUpdateSection(sectionId, updates);
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId
                ? l
                : {
                    ...l,
                    sections: l.sections.map((s) =>
                      s.id !== sectionId ? s : { ...s, ...updates }
                    ),
                  }
            )
          );
          return { id: call.id, name, result: `Updated section`, summary: `Updated section "${updates.label ?? sectionId}"` };
        }

        if (name === 'delete_section') {
          const listId = ctx.listId!;
          const sectionId = args.section_id as string;
          const section = appStore.lists.find((l) => l.id === listId)?.sections.find((s) => s.id === sectionId);
          await apiDeleteSection(sectionId);
          appStore.setLists((prev) =>
            prev.map((l) =>
              l.id !== listId ? l : { ...l, sections: l.sections.filter((s) => s.id !== sectionId) }
            )
          );
          return { id: call.id, name, result: `Deleted section`, summary: `Deleted section "${section?.label ?? sectionId}"` };
        }

        if (name === 'schedule_task' || name === 'unschedule_task') {
          const taskId = Number(args.task_id);
          const listId = args.list_id as string | null | undefined;
          const deadline = name === 'schedule_task' ? (args.deadline as string) : undefined;
          const time = name === 'schedule_task' ? (args.time as string | undefined) : undefined;
          const updates: Record<string, unknown> = { deadline: deadline ?? null };
          if (time !== undefined) updates.time = time;

          if (!listId) {
            await apiUpdateTask(taskId, updates as Parameters<typeof apiUpdateTask>[1]);
            appStore.setDashTasks((prev) =>
              prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
            );
          } else {
            await apiUpdateListTask(listId, taskId, updates as Parameters<typeof apiUpdateListTask>[2]);
            appStore.updateListTask(listId, taskId, updates as Parameters<typeof appStore.updateListTask>[2]);
          }
          const summary = name === 'schedule_task' ? `Scheduled for ${deadline}` : 'Removed deadline';
          return { id: call.id, name, result: summary, summary };
        }

        return { id: call.id, name, result: `Unknown tool: ${name}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return { id: call.id, name, result: `Error: ${msg}` };
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appStore]
  );

  // ── Send message ─────────────────────────────────────────────
  const handleSend = useCallback(
    async (text: string) => {
      if (!settings.enabled) return;

      const sessionId = useAIStore.getState().currentSessionId;

      const userMsg: AIChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      };
      addMessage(userMsg);
      apiSaveAIMessage('user', text, sessionId).catch(() => {});

      const thinkingId = crypto.randomUUID();
      thinkingIdRef.current = thinkingId;
      addMessage({ id: thinkingId, role: 'assistant', content: '', isThinking: true, createdAt: new Date().toISOString() });
      setThinking(true);

      try {
        const ctx = buildContext(location.pathname, appStore);
        const tools = buildTools(ctx);
        const systemPrompt = buildSystemPrompt(ctx, username || 'User');

        // Build API messages from history (last 20 + current)
        const history = useAIStore
          .getState()
          .messages.filter((m) => !m.isThinking && !m.error && m.id !== thinkingId)
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }));

        const apiMessages = [{ role: 'system', content: systemPrompt }, ...history];

        const response = await apiAIChat(apiMessages, tools.length ? tools : undefined);
        const choice = response.choices[0];
        const msg = choice.message;

        if (msg.tool_calls?.length) {
          // Execute all tool calls
          const results = await Promise.all(msg.tool_calls.map((tc) => executeTool(tc, ctx)));

          // Build tool result messages for follow-up
          const toolMessages = [
            { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls },
            ...results.map((r) => ({
              role: 'tool',
              tool_call_id: r.id,
              name: r.name,
              content: r.result,
            })),
          ];

          // Update thinking indicator
          replaceMessage(thinkingId, {
            id: thinkingId,
            role: 'assistant',
            content: '',
            isThinking: true,
            createdAt: new Date().toISOString(),
          });

          const followUp = await apiAIChat([...apiMessages, ...toolMessages], []);
          const finalContent = followUp.choices[0].message.content ?? '';
          const actionSummary = results.map((r) => r.summary).filter(Boolean).join(' · ');

          const finalMsg: AIChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: finalContent,
            actionSummary: actionSummary || undefined,
            createdAt: new Date().toISOString(),
          };
          removeMessage(thinkingId);
          addMessage(finalMsg);
          apiSaveAIMessage('assistant', finalContent, sessionId, actionSummary ? { actionSummary } : undefined).catch(() => {});
        } else {
          const content = msg.content ?? '';
          const finalMsg: AIChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content,
            createdAt: new Date().toISOString(),
          };
          removeMessage(thinkingId);
          addMessage(finalMsg);
          apiSaveAIMessage('assistant', content, sessionId).catch(() => {});
        }
      } catch (err) {
        removeMessage(thinkingIdRef.current ?? thinkingId);
        const errContent = err instanceof Error && err.message.includes('disabled')
          ? 'The AI assistant has been disabled by your admin.'
          : err instanceof Error && err.message.includes('OPENROUTER')
          ? 'OpenRouter API key is not configured. Please contact your admin.'
          : 'Sorry, something went wrong. Please try again.';
        addMessage({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: errContent,
          error: true,
          createdAt: new Date().toISOString(),
        });
      } finally {
        setThinking(false);
        thinkingIdRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.enabled, location.pathname, appStore, username, executeTool]
  );

  const handleClearHistory = useCallback(async () => {
    clearHistory();
    await apiClearAIHistory().catch(() => {});
  }, [clearHistory]);

  // Load recent sessions when the panel is opened
  const handleShowRecentChats = useCallback(async () => {
    setShowRecentChats(true);
    apiGetAISessions()
      .then((data) => setRecentSessions(data.sessions))
      .catch(() => {});
  }, [setShowRecentChats, setRecentSessions]);

  // Load messages from a past session
  const handleSelectSession = useCallback(async (sessionId: string) => {
    setShowRecentChats(false);
    clearHistory();
    setCurrentSessionId(sessionId);
    apiGetAISessionMessages(sessionId)
      .then((data) => {
        const msgs: AIChatMessage[] = data.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            id: String(m.id),
            role: m.role as 'user' | 'assistant',
            content: m.content,
            createdAt: m.createdAt,
            actionSummary: (m.metadata as { actionSummary?: string } | null)?.actionSummary,
          }));
        setMessages(msgs);
      })
      .catch(() => {});
  }, [setShowRecentChats, clearHistory, setCurrentSessionId, setMessages]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    setRecentSessions(recentSessions.filter((s) => s.id !== sessionId));
    await apiDeleteAISession(sessionId).catch(() => {});
  }, [recentSessions, setRecentSessions]);

  // Don't render if AI is disabled
  if (!settings.enabled) return null;

  const ctx = buildContext(location.pathname, appStore);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
      }}
    >
      {isOpen && (
        <div style={{ position: 'relative' }}>
          <AIChatWindow
            messages={messages}
            isThinking={isThinking}
            contextView={ctx.view}
            onSend={handleSend}
            onClose={() => setOpen(false)}
            onClearHistory={handleClearHistory}
            onShowRecentChats={handleShowRecentChats}
          />
          {showRecentChats && (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                right: 0,
                width: 360,
                height: 500,
              }}
            >
              <AIRecentChats
                sessions={recentSessions}
                onSelect={handleSelectSession}
                onDelete={handleDeleteSession}
                onClose={() => setShowRecentChats(false)}
              />
            </div>
          )}
        </div>
      )}
      <AIBubble isOpen={isOpen} isThinking={isThinking} onClick={handleToggle} />
    </div>
  );
}
