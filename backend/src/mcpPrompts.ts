// ---------------------------------------------------------------------------
// MCP prompts — small, reusable prompt templates an MCP client can surface as
// slash-command-style shortcuts. Each just returns a `messages` array (a
// templated user turn instructing the model which tools to reach for) — the
// actual work happens when the CLIENT sends those messages back through its
// own chat loop and calls our tools, same as any hand-typed prompt would.
// No server-side execution happens here.
// ---------------------------------------------------------------------------

export interface McpPromptArgDef {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPromptDef {
  name: string;
  description: string;
  arguments?: McpPromptArgDef[];
}

export const MCP_PROMPTS: McpPromptDef[] = [
  {
    name: 'plan_from_goal',
    description: 'Break a goal down into a board (list) of tasks in Solytiq Cloud.',
    arguments: [
      { name: 'goal', description: 'What you want to accomplish', required: true },
      { name: 'workspace_id', description: 'Target workspace (omit to use the current/personal one)' },
    ],
  },
  {
    name: 'weekly_review',
    description: 'Summarize the past week and suggest priorities for the week ahead.',
    arguments: [
      { name: 'workspace_id', description: 'Limit the review to one workspace (omit for everything you can see)' },
    ],
  },
  {
    name: 'daily_standup',
    description: "Summarize what's due today and overdue across your workspaces.",
  },
  {
    name: 'search_and_summarize',
    description: 'Search your notes/pages/milestones/meetings by meaning and summarize what you find.',
    arguments: [
      { name: 'query', description: 'What to search for', required: true },
    ],
  },
];

export type McpPromptMessage = { role: 'user'; content: { type: 'text'; text: string } };

/** Build a prompt's message list from its arguments. Returns null for an unknown prompt name. */
export function buildPromptMessages(name: string, args: Record<string, string>): McpPromptMessage[] | null {
  const text = (() => {
    switch (name) {
      case 'plan_from_goal': {
        const goal = args.goal?.trim();
        if (!goal) return null;
        const ws = args.workspace_id?.trim();
        return [
          `Break this goal down into a concrete, actionable plan: "${goal}"`,
          ws ? `Create it in workspace ${ws}.` : 'Create it in my current workspace (list_workspaces first if you need to check which one).',
          'Create a new board (create_list) named after the goal, then add each step as a task in it (create_task_in_list-equivalent — use create_task with the new list_id). Keep steps small enough to each be a single sitting of work. Reply with a short summary of the plan you created and its list_id.',
        ].join('\n\n');
      }
      case 'weekly_review': {
        const ws = args.workspace_id?.trim();
        return [
          `Give me a weekly review${ws ? ` for workspace ${ws}` : ' across everything I have access to'}.`,
          'Use list_tasks (and list_workspaces/list_lists if scoping is needed) to find what got completed this week and what\'s still open, especially anything overdue.',
          'Summarize: what got done, what\'s overdue, and 3-5 concrete priorities for next week. Be concise.',
        ].join('\n\n');
      }
      case 'daily_standup':
        return [
          'Give me a daily standup summary: what\'s due today, and anything overdue, across all workspaces I have access to.',
          'Use list_workspaces then list_tasks per workspace (or list_tasks\' own filters if it supports a date range) to gather this. Group by workspace. Keep it short and scannable.',
        ].join('\n\n');
      case 'search_and_summarize': {
        const query = args.query?.trim();
        if (!query) return null;
        return [
          `Search for "${query}" using knowledge_search, then summarize what you find in a few sentences, citing which item(s) (by title) each point comes from.`,
          'If knowledge_search returns nothing useful, fall back to search_graph on the same query and say so.',
        ].join('\n\n');
      }
      default:
        return undefined;
    }
  })();

  if (text === undefined) return null; // unknown prompt name
  if (text === null) return null; // known prompt, but a required argument was missing
  return [{ role: 'user', content: { type: 'text', text } }];
}
