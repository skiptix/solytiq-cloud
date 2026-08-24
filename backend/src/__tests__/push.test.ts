import { describe, expect, it, vi } from 'vitest';
import { buildPushPayload, shouldPushNotification, DEFAULT_PUSH_PREFS } from '../push/send';
import {
  isValidEndpoint,
  upsertSubscription,
  deleteSubscriptionByEndpoint,
  deleteDeadSubscription,
  recordDeliveryFailure,
} from '../push/subscriptions';
import { buildCoalesceKey, PAGE_EDIT_COALESCE_SECONDS, MILESTONE_COALESCE_SECONDS } from '../collaborators';
import { DEFAULT_EMAIL_PREFS, type NotificationType } from '../notifications';
import type { QueryExec } from '../workspaceUtil';

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

describe('buildPushPayload', () => {
  it('reads like the in-app feed row: actor name, then the title as a predicate', () => {
    const p = buildPushPayload({
      type: 'mention',
      title: 'mentioned you in "Roadmap"',
      body: 'Can you take a look at this?',
      actorName: 'Niels',
      entityType: 'list',
      entityId: 'list_1',
      notificationId: 'notif_1',
    });
    expect(p.title).toBe('Niels mentioned you in "Roadmap"');
    expect(p.body).toBe('Can you take a look at this?');
  });

  it('omits the actor prefix for a system notification that has no actor', () => {
    const p = buildPushPayload({ type: 'deadline_overdue', title: 'Task overdue', body: '"Ship it" was due 2026-01-01' });
    expect(p.title).toBe('Task overdue');
  });

  it('falls back to the title for the body — an empty second line reads as a broken notification', () => {
    const p = buildPushPayload({ type: 'workspace_added', title: 'added you to Acme', body: '   ' });
    expect(p.body).toBe('added you to Acme');
  });

  it('truncates a long headline on a word boundary rather than mid-word', () => {
    const title = 'edited '.repeat(40).trim();
    const p = buildPushPayload({ type: 'page_edited', title });
    expect(p.title.length).toBeLessThanOrEqual(120);
    expect(p.title.endsWith('…')).toBe(true);
    expect(p.title).not.toMatch(/edite…$/);
  });

  it('still truncates when a single token is longer than the limit (no word boundary to find)', () => {
    const p = buildPushPayload({ type: 'page_edited', title: 'x'.repeat(300) });
    expect(p.title.length).toBeLessThanOrEqual(120);
    expect(p.title.endsWith('…')).toBe(true);
  });

  it('collapses high-volume activity types by entity so a burst replaces itself on the lock screen', () => {
    const first = buildPushPayload({ type: 'item_added', title: 'added an item', entityType: 'list', entityId: 'list_1', notificationId: 'notif_1' });
    const second = buildPushPayload({ type: 'item_added', title: 'added an item', entityType: 'list', entityId: 'list_1', notificationId: 'notif_2' });
    expect(first.tag).toBe(second.tag);
    // renotify keeps the replacement audible instead of silently swapping text.
    expect(first.renotify).toBe(true);
  });

  it('gives every targeted notification a unique tag so none is ever swallowed', () => {
    const first = buildPushPayload({ type: 'mention', title: 'mentioned you', entityType: 'list', entityId: 'list_1', notificationId: 'notif_1' });
    const second = buildPushPayload({ type: 'mention', title: 'mentioned you', entityType: 'list', entityId: 'list_1', notificationId: 'notif_2' });
    expect(first.tag).not.toBe(second.tag);
    expect(first.renotify).toBe(false);
  });

  it('routes each entity type to its own in-app path', () => {
    expect(buildPushPayload({ type: 'item_added', title: 't', entityType: 'list', entityId: 'l1' }).url).toBe('/list/l1');
    expect(buildPushPayload({ type: 'milestone_changed', title: 't', entityType: 'timeline', entityId: 't1' }).url).toBe('/timeline/t1');
    expect(buildPushPayload({ type: 'page_edited', title: 't', entityType: 'markdownList', entityId: 'm1' }).url).toBe('/markdown-list/m1');
    expect(buildPushPayload({ type: 'meeting_invite', title: 't', entityType: 'meeting', entityId: 'x' }).url).toBe('/calendar?show=meetings');
    // A task/milestone deep-links through its parent, carried in `data`.
    expect(buildPushPayload({ type: 'deadline_overdue', title: 't', entityType: 'task', entityId: '5', data: { listId: 'l9' } }).url).toBe('/list/l9');
    expect(buildPushPayload({ type: 'mention', title: 't', entityType: 'milestone', entityId: 'm', data: { timelineId: 't9' } }).url).toBe('/timeline/t9');
  });

  it('falls back to the dashboard for an unknown or absent entity type', () => {
    expect(buildPushPayload({ type: 'workspace_added', title: 't' }).url).toBe('/dashboard');
    expect(buildPushPayload({ type: 'item_added', title: 't', entityType: 'list', entityId: null }).url).toBe('/dashboard');
  });
});

describe('shouldPushNotification', () => {
  it('pushes a FAILED automation run but leaves a successful one in-app only', () => {
    expect(shouldPushNotification('automation_run', { status: 'failed' })).toBe(true);
    expect(shouldPushNotification('automation_run', { status: 'success' })).toBe(false);
  });

  it('lets every other type through', () => {
    expect(shouldPushNotification('mention', undefined)).toBe(true);
    expect(shouldPushNotification('item_added', {})).toBe(true);
  });
});

describe('notification-type coverage', () => {
  // The whole "all notifications reach the phone" contract rests on every
  // NotificationType having a push default. A new type added to the union
  // without one would silently fall through to the `?? true` guard rather than
  // being a deliberate choice — this is what makes that choice mandatory.
  it('declares a push default for exactly the same types email does', () => {
    expect(Object.keys(DEFAULT_PUSH_PREFS).sort()).toEqual(Object.keys(DEFAULT_EMAIL_PREFS).sort());
  });

  it('defaults push ON for the collaboration types (permission is the opt-in)', () => {
    const activity: NotificationType[] = ['item_added', 'page_edited', 'milestone_changed', 'mention'];
    for (const t of activity) expect(DEFAULT_PUSH_PREFS[t]).toBe(true);
  });
});

describe('isValidEndpoint', () => {
  it('accepts an https push endpoint', () => {
    expect(isValidEndpoint('https://web.push.apple.com/abc123')).toBe(true);
  });

  it('rejects non-https, non-URL, empty and over-long values', () => {
    expect(isValidEndpoint('http://web.push.apple.com/abc')).toBe(false);
    expect(isValidEndpoint('file:///etc/passwd')).toBe(false);
    expect(isValidEndpoint('not a url')).toBe(false);
    expect(isValidEndpoint('')).toBe(false);
    expect(isValidEndpoint(123)).toBe(false);
    expect(isValidEndpoint(`https://x.example/${'a'.repeat(2100)}`)).toBe(false);
  });
});

describe('push subscription storage', () => {
  it('upserts on the ENDPOINT alone, so a second user on one device takes the row over', async () => {
    const { exec, calls } = makeExec([[{ id: 's1', user_id: 'u1', endpoint: 'https://p/1', p256dh: 'k', auth: 'a', device_name: 'iPhone', os_version: 'iOS 17.4', install_id: 'hs_1', created_at: 'now', last_used_at: null }]]);
    await upsertSubscription('u1', { endpoint: 'https://p/1', keys: { p256dh: 'k', auth: 'a' } }, { deviceName: 'iPhone', osVersion: 'iOS 17.4', installId: 'hs_1' }, exec);
    expect(calls[0].text).toContain('ON CONFLICT (endpoint) DO UPDATE');
    expect(calls[0].text).toContain('user_id       = EXCLUDED.user_id');
    // A re-subscribe clears any stale failure state from a previous device life.
    expect(calls[0].text).toContain('failure_count = 0');
  });

  it("scopes a user's own unsubscribe to that user", async () => {
    const { exec, calls } = makeExec([[]]);
    await deleteSubscriptionByEndpoint('u1', 'https://p/1', exec);
    expect(calls[0].text).toContain('user_id = $1');
    expect(calls[0].params).toEqual(['u1', 'https://p/1']);
  });

  it('deletes a push-service-rejected endpoint WITHOUT a user scope (the endpoint is the identity there)', async () => {
    const { exec, calls } = makeExec([[]]);
    await deleteDeadSubscription('https://p/1', exec);
    expect(calls[0].text).not.toContain('user_id');
    expect(calls[0].params).toEqual(['https://p/1']);
  });

  it('caps a stored error message so one push service cannot bloat the row', async () => {
    const { exec, calls } = makeExec([[]]);
    await recordDeliveryFailure('https://p/1', 'e'.repeat(2000), exec);
    expect(String((calls[0].params as unknown[])[1]).length).toBe(500);
  });
});

describe('buildCoalesceKey', () => {
  it('returns null when the caller wants every event through (an add is discrete)', () => {
    expect(buildCoalesceKey({ type: 'item_added', itemId: 'l1', actorId: 'u1' })).toBeNull();
  });

  it('collapses a burst of edits from one person on one page into a single key', () => {
    const t0 = 1_700_000_000_000;
    const a = buildCoalesceKey({ type: 'page_edited', itemId: 'm1', actorId: 'u1', coalesceSeconds: PAGE_EDIT_COALESCE_SECONDS }, t0);
    const b = buildCoalesceKey({ type: 'page_edited', itemId: 'm1', actorId: 'u1', coalesceSeconds: PAGE_EDIT_COALESCE_SECONDS }, t0 + 60_000);
    expect(a).toBe(b);
  });

  it('starts a new key once the window has passed, so a later edit still surfaces', () => {
    const t0 = 1_700_000_000_000;
    const a = buildCoalesceKey({ type: 'page_edited', itemId: 'm1', actorId: 'u1', coalesceSeconds: PAGE_EDIT_COALESCE_SECONDS }, t0);
    const b = buildCoalesceKey({ type: 'page_edited', itemId: 'm1', actorId: 'u1', coalesceSeconds: PAGE_EDIT_COALESCE_SECONDS }, t0 + (PAGE_EDIT_COALESCE_SECONDS + 1) * 1000);
    expect(a).not.toBe(b);
  });

  it('keeps two editors of the same page separate — each is their own event', () => {
    const t0 = 1_700_000_000_000;
    const a = buildCoalesceKey({ type: 'page_edited', itemId: 'm1', actorId: 'u1', coalesceSeconds: PAGE_EDIT_COALESCE_SECONDS }, t0);
    const b = buildCoalesceKey({ type: 'page_edited', itemId: 'm1', actorId: 'u2', coalesceSeconds: PAGE_EDIT_COALESCE_SECONDS }, t0);
    expect(a).not.toBe(b);
  });

  it('scopes milestone coalescing per milestone, not per timeline', () => {
    const t0 = 1_700_000_000_000;
    const a = buildCoalesceKey({ type: 'milestone_changed', itemId: 't1', actorId: 'u1', coalesceSeconds: MILESTONE_COALESCE_SECONDS, coalesceScope: 'ms_1' }, t0);
    const b = buildCoalesceKey({ type: 'milestone_changed', itemId: 't1', actorId: 'u1', coalesceSeconds: MILESTONE_COALESCE_SECONDS, coalesceScope: 'ms_2' }, t0);
    expect(a).not.toBe(b);
  });
});
