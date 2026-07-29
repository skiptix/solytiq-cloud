import { describe, it, expect } from 'vitest';
import { detectLinkTrigger, applyLinkToken } from '../linkTrigger';
import type { EntityIndexEntry } from '../../types';

const ENTITY = (over: Partial<EntityIndexEntry> = {}): EntityIndexEntry => ({
  srn: 'srn:list:list_1', entityType: 'list', entityId: 'list_1', workspaceId: 'ws_1',
  ownerId: 'user-1', title: 'Groceries', emoji: null, color: null, subtitle: null,
  status: null, isArchived: false, isTrashed: false, deepLink: '/list/list_1',
  createdAt: null, updatedAt: null, ...over,
});

describe('detectLinkTrigger', () => {
  it('detects an in-progress [[query at the caret', () => {
    const text = 'see [[gro';
    expect(detectLinkTrigger(text, text.length)).toEqual({ at: 4, query: 'gro' });
  });

  it('detects a bare [[ (empty query) to open the picker immediately', () => {
    const text = 'link [[';
    expect(detectLinkTrigger(text, text.length)).toEqual({ at: 5, query: '' });
  });

  it('does not detect once the token is already closed', () => {
    const text = '[[list:list_1|Groceries]] ';
    expect(detectLinkTrigger(text, text.length)).toBeNull();
  });

  it('does not detect across a newline', () => {
    const text = '[[foo\nbar';
    expect(detectLinkTrigger(text, text.length)).toBeNull();
  });

  it('only considers the trigger immediately before the caret', () => {
    const text = '[[a]] and [[b';
    expect(detectLinkTrigger(text, text.length)).toEqual({ at: 10, query: 'b' });
  });

  it('returns null when the caret is not inside a trigger', () => {
    expect(detectLinkTrigger('nothing here', 5)).toBeNull();
  });

  it('gives up past a reasonable query length (not a real search anymore)', () => {
    const text = '[[' + 'x'.repeat(61);
    expect(detectLinkTrigger(text, text.length)).toBeNull();
  });
});

describe('applyLinkToken', () => {
  it('replaces the [[query token with a full ID-anchored [[type:id|Label]] token', () => {
    const text = 'see [[gro done';
    const { value, caret } = applyLinkToken(text, 4, 9, ENTITY());
    expect(value).toBe('see [[list:list_1|Groceries]] done');
    expect(caret).toBe('see [[list:list_1|Groceries]]'.length);
  });

  it('falls back to "Untitled" when the entity has no title', () => {
    const { value } = applyLinkToken('[[q', 0, 3, ENTITY({ title: '' }));
    expect(value).toBe('[[list:list_1|Untitled]]');
  });

  it('strips bracket/pipe characters out of the label so the token stays parseable', () => {
    const { value } = applyLinkToken('[[q', 0, 3, ENTITY({ title: 'Weird | [Title]' }));
    expect(value).toBe('[[list:list_1|Weird    Title]]');
  });

  it('includes the blockId anchor in the SRN when present', () => {
    const { value } = applyLinkToken('[[q', 0, 3, ENTITY({ entityType: 'markdownList', entityId: 'md_1', srn: 'srn:markdownList:md_1' }));
    expect(value).toBe('[[markdownList:md_1|Groceries]]');
  });
});
