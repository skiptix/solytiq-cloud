import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock the data + credentials layers so no DB is needed.
vi.mock('../caldav/credentials', () => ({
  verifyCaldavLogin: vi.fn(async (email: string, pw: string) =>
    email === 'a@b.com' && pw === 'pass' ? { userId: 'u1' } : null),
}));
vi.mock('../caldav/data', () => ({
  getCollections: vi.fn(async () => [
    { id: 'ws-1', kind: 'workspace', name: 'Personal', color: '#5e4dbb', components: ['VEVENT', 'VTODO'], writable: false },
    { id: 'meetings', kind: 'meetings', name: 'Meetings', color: '#3b82f6', components: ['VEVENT'], writable: true },
  ]),
  getCollection: vi.fn(async (_u: string, id: string) =>
    id === 'ws-1' || id === 'meetings'
      ? { id, kind: id === 'meetings' ? 'meetings' : 'workspace', name: id, color: '#000', components: ['VEVENT'], writable: id === 'meetings' }
      : null),
  getResources: vi.fn(async () => [{ name: 'task-1', etag: '"e1"', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }]),
  getResource: vi.fn(async () => ({ name: 'task-1', etag: '"e1"', ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' })),
  getCtag: vi.fn(async () => 'ctag123'),
  upsertMeetingFromICal: vi.fn(),
  deleteMeetingByResource: vi.fn(),
}));

import caldavHandler from '../routes/caldav';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/caldav', express.text({ type: () => true, limit: '1mb' }), caldavHandler);
  await new Promise<void>(resolve => { server = app.listen(0, resolve); });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => { server?.close(); });

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }
function dav(method: string, path: string, opts: { auth?: boolean; depth?: string; body?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.auth !== false) headers['Authorization'] = 'Basic ' + Buffer.from('a@b.com:pass').toString('base64');
    if (opts.depth) headers['Depth'] = opts.depth;
    if (opts.body) { headers['Content-Type'] = 'application/xml'; headers['Content-Length'] = String(Buffer.byteLength(opts.body)); }
    const req = http.request(`${base}${path}`, { method, headers }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('caldav server discovery', () => {
  it('challenges unauthenticated requests', async () => {
    const r = await dav('PROPFIND', '/caldav/', { auth: false, depth: '0' });
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toMatch(/Basic/);
  });

  it('rejects wrong credentials', async () => {
    const r = await new Promise<Resp>((resolve, reject) => {
      const headers = { Authorization: 'Basic ' + Buffer.from('a@b.com:wrong').toString('base64'), Depth: '0' };
      const req = http.request(`${base}/caldav/`, { method: 'PROPFIND', headers }, res => {
        let body = ''; res.on('data', c => (body += c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject); req.end();
    });
    expect(r.status).toBe(401);
  });

  it('returns current-user-principal + calendar-home-set at the root', async () => {
    const r = await dav('PROPFIND', '/caldav/', { depth: '0' });
    expect(r.status).toBe(207);
    expect(r.body).toContain('current-user-principal');
    expect(r.body).toContain('/caldav/principals/u1/');
    expect(r.body).toContain('calendar-home-set');
    expect(r.body).toContain('/caldav/calendars/u1/');
  });

  it('returns calendar-home-set on the principal', async () => {
    const r = await dav('PROPFIND', '/caldav/principals/u1/', { depth: '0' });
    expect(r.status).toBe(207);
    expect(r.body).toContain('/caldav/calendars/u1/');
  });

  it('lists calendar collections at the home (Depth 1)', async () => {
    const r = await dav('PROPFIND', '/caldav/calendars/u1/', { depth: '1' });
    expect(r.status).toBe(207);
    expect(r.body).toContain('/caldav/calendars/u1/ws-1/');
    expect(r.body).toContain('/caldav/calendars/u1/meetings/');
    expect(r.body).toContain('supported-calendar-component-set');
    expect(r.body).toContain('getctag');
  });

  it('enumerates resources in a collection (Depth 1)', async () => {
    const r = await dav('PROPFIND', '/caldav/calendars/u1/ws-1/', { depth: '1' });
    expect(r.status).toBe(207);
    expect(r.body).toContain('/caldav/calendars/u1/ws-1/task-1.ics');
    expect(r.body).toContain('getetag');
  });

  it('advertises capabilities on OPTIONS without auth', async () => {
    const r = await dav('OPTIONS', '/caldav/', { auth: false });
    expect(r.status).toBe(200);
    expect(String(r.headers['dav'])).toContain('calendar-access');
  });

  it('serves a calendar-query REPORT', async () => {
    const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop></c:calendar-query>`;
    const r = await dav('REPORT', '/caldav/calendars/u1/ws-1/', { depth: '1', body });
    expect(r.status).toBe(207);
    expect(r.body).toContain('task-1.ics');
    expect(r.body).toContain('calendar-data');
  });
});
