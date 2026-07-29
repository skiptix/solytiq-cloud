import { describe, expect, it } from 'vitest';
import { MCP_PROMPTS, buildPromptMessages } from '../mcpPrompts';

describe('MCP_PROMPTS', () => {
  it('every prompt has a unique name', () => {
    const names = MCP_PROMPTS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every required argument is flagged required: true', () => {
    expect(MCP_PROMPTS.find((p) => p.name === 'plan_from_goal')?.arguments?.find((a) => a.name === 'goal')?.required).toBe(true);
    expect(MCP_PROMPTS.find((p) => p.name === 'search_and_summarize')?.arguments?.find((a) => a.name === 'query')?.required).toBe(true);
  });
});

describe('buildPromptMessages', () => {
  it('returns null for an unknown prompt name', () => {
    expect(buildPromptMessages('not_a_real_prompt', {})).toBeNull();
  });

  it('plan_from_goal requires a goal argument', () => {
    expect(buildPromptMessages('plan_from_goal', {})).toBeNull();
    const messages = buildPromptMessages('plan_from_goal', { goal: 'Launch the v2 release' });
    expect(messages).not.toBeNull();
    expect(messages![0].role).toBe('user');
    expect(messages![0].content.text).toContain('Launch the v2 release');
  });

  it('plan_from_goal mentions the target workspace when supplied, and omits it otherwise', () => {
    const withWs = buildPromptMessages('plan_from_goal', { goal: 'x', workspace_id: 'ws_1' })![0].content.text;
    expect(withWs).toContain('ws_1');
    const withoutWs = buildPromptMessages('plan_from_goal', { goal: 'x' })![0].content.text;
    expect(withoutWs).not.toContain('ws_1');
  });

  it('weekly_review and daily_standup need no arguments', () => {
    expect(buildPromptMessages('weekly_review', {})).not.toBeNull();
    expect(buildPromptMessages('daily_standup', {})).not.toBeNull();
  });

  it('search_and_summarize requires a query argument', () => {
    expect(buildPromptMessages('search_and_summarize', {})).toBeNull();
    const messages = buildPromptMessages('search_and_summarize', { query: 'q3 roadmap' });
    expect(messages![0].content.text).toContain('q3 roadmap');
  });

  it('every built message is well-formed (single user text turn)', () => {
    for (const p of MCP_PROMPTS) {
      const args: Record<string, string> = {};
      for (const a of p.arguments ?? []) if (a.required) args[a.name] = 'test-value';
      const messages = buildPromptMessages(p.name, args);
      expect(messages).toHaveLength(1);
      expect(messages![0]).toEqual({ role: 'user', content: { type: 'text', text: expect.any(String) } });
    }
  });
});
