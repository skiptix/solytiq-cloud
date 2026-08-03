// ---------------------------------------------------------------------------
// AI Skills tools (aiTools.ts) — tool-surface visibility and, most
// importantly, admin-gating on every mutation. A tool handler only ever
// receives a userId (see AiTool's type comment), so create/update/delete/
// set_skill_file/remove_skill_file must each re-derive admin status via
// isUserAdmin() rather than trusting anything the model claims — this is the
// one thing every one of these tests actually pins.
//
// Mirrors the vi.mock convention established by knowledgeBaseAiTools.test.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn(async () => ({ rows: [], rowCount: 0 })));
vi.mock('../db', () => ({ query: (...args: unknown[]) => queryMock(...args), withTransaction: vi.fn() }));
vi.mock('../sse', () => ({ broadcastToUser: vi.fn() }));
vi.mock('../agent/runtime', () => ({ startAgentRun: vi.fn() }));

const isUserAdminMock = vi.hoisted(() => vi.fn());
const findSkillMock = vi.hoisted(() => vi.fn());
const listSkillsMock = vi.hoisted(() => vi.fn());
const createSkillMock = vi.hoisted(() => vi.fn());
const updateSkillMock = vi.hoisted(() => vi.fn());
const deleteSkillMock = vi.hoisted(() => vi.fn());
const listSkillFilesMock = vi.hoisted(() => vi.fn());
const getSkillFileMock = vi.hoisted(() => vi.fn());
const setSkillFileMock = vi.hoisted(() => vi.fn());
const removeSkillFileMock = vi.hoisted(() => vi.fn());

vi.mock('../aiSkills/skills', () => ({
  isUserAdmin: (...args: unknown[]) => isUserAdminMock(...args),
  findSkill: (...args: unknown[]) => findSkillMock(...args),
  listSkills: (...args: unknown[]) => listSkillsMock(...args),
  createSkill: (...args: unknown[]) => createSkillMock(...args),
  updateSkill: (...args: unknown[]) => updateSkillMock(...args),
  deleteSkill: (...args: unknown[]) => deleteSkillMock(...args),
  listSkillFiles: (...args: unknown[]) => listSkillFilesMock(...args),
  getSkillFile: (...args: unknown[]) => getSkillFileMock(...args),
  setSkillFile: (...args: unknown[]) => setSkillFileMock(...args),
  removeSkillFile: (...args: unknown[]) => removeSkillFileMock(...args),
}));

import { executeAiTool, getOpenRouterToolDefs, getMcpToolDefs } from '../aiTools';

const SKILL = { id: 'skill_1', name: 'My Skill', description: 'desc', content: 'body', enabled: true, source: 'manual', origin: 'manual', file_count: 0 };

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  isUserAdminMock.mockReset();
  findSkillMock.mockReset();
  listSkillsMock.mockReset();
  createSkillMock.mockReset();
  updateSkillMock.mockReset();
  deleteSkillMock.mockReset();
  listSkillFilesMock.mockReset().mockResolvedValue([]);
  getSkillFileMock.mockReset();
  setSkillFileMock.mockReset();
  removeSkillFileMock.mockReset();
});

describe('tool surface', () => {
  const SKILL_TOOL_NAMES = [
    'list_skills', 'read_skill', 'list_skill_files', 'read_skill_file',
    'create_skill', 'update_skill', 'delete_skill', 'set_skill_file', 'remove_skill_file',
  ];

  it('exposes every skill tool to BOTH Sol/Agent Runtime and MCP — none are mcpOnly', () => {
    const openRouterNames = getOpenRouterToolDefs().map((d) => d.function.name);
    const mcpNames = getMcpToolDefs().map((d) => d.name);
    for (const name of SKILL_TOOL_NAMES) {
      expect(openRouterNames).toContain(name);
      expect(mcpNames).toContain(name);
    }
  });
});

describe('read access — open to any signed-in user, but gated on enabled', () => {
  it('list_skills defaults to enabled-only and never checks admin', async () => {
    listSkillsMock.mockResolvedValue([SKILL]);
    const result = await executeAiTool('user-1', 'list_skills', {});
    expect(result.ok).toBe(true);
    expect(listSkillsMock).toHaveBeenCalledWith({ enabledOnly: true });
    expect(isUserAdminMock).not.toHaveBeenCalled();
  });

  it('list_skills with include_disabled requires admin', async () => {
    isUserAdminMock.mockResolvedValue(false);
    const result = await executeAiTool('user-1', 'list_skills', { include_disabled: true });
    expect(result.ok).toBe(false);
    expect(listSkillsMock).not.toHaveBeenCalled();
  });

  it('list_skills with include_disabled succeeds for an admin', async () => {
    isUserAdminMock.mockResolvedValue(true);
    listSkillsMock.mockResolvedValue([{ ...SKILL, enabled: false }]);
    const result = await executeAiTool('admin-1', 'list_skills', { include_disabled: true });
    expect(result.ok).toBe(true);
    expect(listSkillsMock).toHaveBeenCalledWith({ enabledOnly: false });
  });

  it('read_skill refuses a disabled skill for a non-admin', async () => {
    findSkillMock.mockResolvedValue({ ...SKILL, enabled: false });
    isUserAdminMock.mockResolvedValue(false);
    const result = await executeAiTool('user-1', 'read_skill', { skill_id: 'skill_1' });
    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/disabled/i);
  });

  it('read_skill returns a disabled skill\'s content to an admin', async () => {
    findSkillMock.mockResolvedValue({ ...SKILL, enabled: false });
    isUserAdminMock.mockResolvedValue(true);
    const result = await executeAiTool('admin-1', 'read_skill', { skill_id: 'skill_1' });
    expect(result.ok).toBe(true);
    expect(result.result).toContain('body');
  });

  it('read_skill 404s (as a plain "not found") for an unknown skill', async () => {
    findSkillMock.mockResolvedValue(null);
    const result = await executeAiTool('user-1', 'read_skill', { skill_id: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/not found/i);
  });
});

describe('write access — admin only, re-derived from userId every call', () => {
  it('create_skill fails for a non-admin and never touches the data layer', async () => {
    isUserAdminMock.mockResolvedValue(false);
    const result = await executeAiTool('user-1', 'create_skill', { name: 'New Skill', content: 'body' });
    expect(result.ok).toBe(false);
    expect(result.result).toMatch(/admin/i);
    expect(createSkillMock).not.toHaveBeenCalled();
  });

  it('create_skill succeeds for an admin and tags the skill origin as ai', async () => {
    isUserAdminMock.mockResolvedValue(true);
    createSkillMock.mockResolvedValue({ ok: true, skill: SKILL });
    const result = await executeAiTool('admin-1', 'create_skill', { name: 'My Skill', content: 'body' });
    expect(result.ok).toBe(true);
    expect(createSkillMock).toHaveBeenCalledWith(expect.objectContaining({ origin: 'ai', createdBy: 'admin-1' }));
  });

  it('update_skill fails for a non-admin', async () => {
    isUserAdminMock.mockResolvedValue(false);
    const result = await executeAiTool('user-1', 'update_skill', { skill_id: 'skill_1', enabled: false });
    expect(result.ok).toBe(false);
    expect(findSkillMock).not.toHaveBeenCalled();
    expect(updateSkillMock).not.toHaveBeenCalled();
  });

  it('delete_skill fails for a non-admin', async () => {
    isUserAdminMock.mockResolvedValue(false);
    const result = await executeAiTool('user-1', 'delete_skill', { skill_id: 'skill_1' });
    expect(result.ok).toBe(false);
    expect(deleteSkillMock).not.toHaveBeenCalled();
  });

  it('delete_skill succeeds for an admin', async () => {
    isUserAdminMock.mockResolvedValue(true);
    findSkillMock.mockResolvedValue(SKILL);
    deleteSkillMock.mockResolvedValue(true);
    const result = await executeAiTool('admin-1', 'delete_skill', { skill_id: 'skill_1' });
    expect(result.ok).toBe(true);
    expect(deleteSkillMock).toHaveBeenCalledWith('skill_1');
  });

  it('set_skill_file fails for a non-admin', async () => {
    isUserAdminMock.mockResolvedValue(false);
    const result = await executeAiTool('user-1', 'set_skill_file', { skill_id: 'skill_1', file_path: 'a.md', content: 'x' });
    expect(result.ok).toBe(false);
    expect(setSkillFileMock).not.toHaveBeenCalled();
  });

  it('remove_skill_file fails for a non-admin', async () => {
    isUserAdminMock.mockResolvedValue(false);
    const result = await executeAiTool('user-1', 'remove_skill_file', { skill_id: 'skill_1', file_path: 'a.md' });
    expect(result.ok).toBe(false);
    expect(removeSkillFileMock).not.toHaveBeenCalled();
  });
});
