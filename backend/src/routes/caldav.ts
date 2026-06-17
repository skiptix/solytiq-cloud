// ---------------------------------------------------------------------------
// CalDAV server (read for tasks/milestones, read-write for meetings).
//
// Mounted at /caldav (outside /api so the per-IP API rate limiter doesn't
// throttle the client's frequent polling). Authentication is HTTP Basic with
// the user's email + a generated CalDAV app password.
//
// This is a focused subset of RFC 4791 / WebDAV that is sufficient for Apple
// Calendar, Thunderbird and similar clients: OPTIONS, PROPFIND, REPORT
// (calendar-query / calendar-multiget / sync-collection), GET, PUT, DELETE,
// PROPPATCH.
// ---------------------------------------------------------------------------

import { Request, Response } from 'express';
import { verifyCaldavLogin } from '../caldav/credentials';
import {
  getCollections, getCollection, getResources, getResource, getCtag,
  getCollectionCalendar, upsertMeetingFromICal, deleteMeetingByResource, CalCollection,
} from '../caldav/data';

const BASE = '/caldav';

const xmlEscape = (s: string | null | undefined) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Href helpers (always use the authenticated user's id) ────────────────────
const principalHref = (uid: string) => `${BASE}/principals/${uid}/`;
const homeHref = (uid: string) => `${BASE}/calendars/${uid}/`;
const collectionHref = (uid: string, col: string) => `${homeHref(uid)}${encodeURIComponent(col)}/`;
const resourceHref = (uid: string, col: string, name: string) => `${collectionHref(uid, col)}${encodeURIComponent(name)}.ics`;

function segments(req: Request): string[] {
  return req.path.split('/').filter(Boolean).map(s => decodeURIComponent(s));
}

function multistatus(responses: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">${responses}</d:multistatus>`;
}

function propResponse(href: string, propsXml: string, status = 'HTTP/1.1 200 OK'): string {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${propsXml}</d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
}

function notFoundResponse(href: string): string {
  return `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
}

function principalProps(uid: string, displayName: string): string {
  return [
    `<d:resourcetype><d:principal/></d:resourcetype>`,
    `<d:displayname>${xmlEscape(displayName)}</d:displayname>`,
    `<d:current-user-principal><d:href>${principalHref(uid)}</d:href></d:current-user-principal>`,
    `<d:principal-URL><d:href>${principalHref(uid)}</d:href></d:principal-URL>`,
    `<c:calendar-home-set><d:href>${homeHref(uid)}</d:href></c:calendar-home-set>`,
  ].join('');
}

function homeProps(uid: string): string {
  return [
    `<d:resourcetype><d:collection/></d:resourcetype>`,
    `<d:displayname>Solytiq Calendars</d:displayname>`,
    `<d:current-user-principal><d:href>${principalHref(uid)}</d:href></d:current-user-principal>`,
  ].join('');
}

function calendarProps(uid: string, col: CalCollection, ctag: string): string {
  const comps = col.components.map(c => `<c:comp name="${c}"/>`).join('');
  const privs = col.writable
    ? `<d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege>`
    : `<d:privilege><d:read/></d:privilege>`;
  return [
    `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>`,
    `<d:displayname>${xmlEscape(col.name)}</d:displayname>`,
    `<cs:getctag>${ctag}</cs:getctag>`,
    `<d:sync-token>${ctag}</d:sync-token>`,
    `<c:supported-calendar-component-set>${comps}</c:supported-calendar-component-set>`,
    `<ic:calendar-color>${col.color}</ic:calendar-color>`,
    `<c:calendar-description>${xmlEscape(col.name)}</c:calendar-description>`,
    `<d:owner><d:href>${principalHref(uid)}</d:href></d:owner>`,
    `<d:current-user-privilege-set>${privs}</d:current-user-privilege-set>`,
    `<d:supported-report-set>` +
      `<d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report>` +
      `<d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report>` +
      `<d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>` +
    `</d:supported-report-set>`,
  ].join('');
}

const resourceProps = (etag: string) =>
  `<d:resourcetype/><d:getetag>${etag}</d:getetag><d:getcontenttype>text/calendar; charset=utf-8; component=vevent</d:getcontenttype>`;

function sendXml(res: Response, xml: string, status = 207) {
  res.status(status).set('Content-Type', 'application/xml; charset=utf-8').set('DAV', '1, 2, 3, calendar-access').send(xml);
}

// ── Method handlers ──────────────────────────────────────────────────────────
async function handlePropfind(req: Request, res: Response, uid: string, displayName: string) {
  const segs = segments(req);
  const depth = req.get('Depth') ?? '0';

  // root / principal discovery
  if (segs.length === 0 || segs[0] === 'principals') {
    const href = segs[0] === 'principals' ? principalHref(uid) : `${BASE}/`;
    sendXml(res, multistatus(propResponse(href, principalProps(uid, displayName))));
    return;
  }

  // calendar home
  if (segs[0] === 'calendars' && segs.length <= 2) {
    let body = propResponse(homeHref(uid), homeProps(uid));
    if (depth !== '0') {
      const cols = await getCollections(uid);
      for (const col of cols) {
        const ctag = await getCtag(uid, col.id);
        body += propResponse(collectionHref(uid, col.id), calendarProps(uid, col, ctag));
      }
    }
    sendXml(res, multistatus(body));
    return;
  }

  // a calendar collection
  if (segs[0] === 'calendars' && segs.length === 3) {
    const colId = segs[2];
    const col = await getCollection(uid, colId);
    if (!col) { sendXml(res, multistatus(notFoundResponse(collectionHref(uid, colId))), 207); return; }
    const ctag = await getCtag(uid, colId);
    let body = propResponse(collectionHref(uid, colId), calendarProps(uid, col, ctag));
    if (depth !== '0') {
      const resources = await getResources(uid, colId);
      for (const r of resources) body += propResponse(resourceHref(uid, colId, r.name), resourceProps(r.etag));
    }
    sendXml(res, multistatus(body));
    return;
  }

  // a single resource
  if (segs[0] === 'calendars' && segs.length === 4) {
    const colId = segs[2];
    const name = segs[3].replace(/\.ics$/i, '');
    const r = await getResource(uid, colId, name);
    if (!r) { sendXml(res, multistatus(notFoundResponse(resourceHref(uid, colId, name)))); return; }
    sendXml(res, multistatus(propResponse(resourceHref(uid, colId, name), resourceProps(r.etag))));
    return;
  }

  sendXml(res, multistatus(notFoundResponse(req.originalUrl)));
}

async function handleReport(req: Request, res: Response, uid: string) {
  const segs = segments(req);
  if (segs[0] !== 'calendars' || segs.length < 3) { res.sendStatus(400); return; }
  const colId = segs[2];
  const col = await getCollection(uid, colId);
  if (!col) { res.sendStatus(404); return; }

  const body = typeof req.body === 'string' ? req.body : '';
  const isMultiget = /calendar-multiget/i.test(body);
  const isSync = /sync-collection/i.test(body);

  const wantData = (xml: string, r: { etag: string; ics: string }) =>
    `<d:getetag>${r.etag}</d:getetag><c:calendar-data>${xml}</c:calendar-data>`;

  let responses = '';

  if (isMultiget) {
    const hrefs = [...body.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi)].map(m => m[1].trim());
    for (const href of hrefs) {
      const name = decodeURIComponent(href.split('/').pop() ?? '').replace(/\.ics$/i, '');
      const r = await getResource(uid, colId, name);
      if (r) responses += propResponse(resourceHref(uid, colId, name), wantData(xmlEscape(r.ics), r));
      else responses += notFoundResponse(href);
    }
  } else {
    // calendar-query (filters ignored — return everything) and sync-collection
    const resources = await getResources(uid, colId);
    for (const r of resources) {
      responses += propResponse(resourceHref(uid, colId, r.name), wantData(xmlEscape(r.ics), r));
    }
  }

  let xml = multistatus(responses);
  if (isSync) {
    const ctag = await getCtag(uid, colId);
    xml = xml.replace('</d:multistatus>', `<d:sync-token>${ctag}</d:sync-token></d:multistatus>`);
  }
  sendXml(res, xml);
}

async function handleGet(req: Request, res: Response, uid: string, head: boolean) {
  const segs = segments(req);

  // A single resource → its iCalendar document.
  if (segs[0] === 'calendars' && segs.length === 4) {
    const colId = segs[2];
    const name = segs[3].replace(/\.ics$/i, '');
    const r = await getResource(uid, colId, name);
    if (!r) { res.sendStatus(404); return; }
    res.status(200).set('Content-Type', 'text/calendar; charset=utf-8').set('ETag', r.etag);
    if (head) res.end(); else res.send(r.ics);
    return;
  }

  // A whole calendar collection → merged VCALENDAR (so a browser/GET-only client
  // can still download it instead of seeing "Method Not Allowed").
  if (segs[0] === 'calendars' && segs.length === 3) {
    const col = await getCollection(uid, segs[2]);
    if (!col) { res.sendStatus(404); return; }
    const ics = await getCollectionCalendar(uid, segs[2]);
    res.status(200).set('Content-Type', 'text/calendar; charset=utf-8');
    if (head) res.end(); else res.send(ics);
    return;
  }

  // Root / principal / home → a friendly note (CalDAV is not browsable by GET).
  res.status(200).set('Content-Type', 'text/plain; charset=utf-8');
  if (head) res.end();
  else res.send('Solytiq CalDAV endpoint. Add this URL to a CalDAV client (e.g. Apple Calendar) — it is not browsable in a web browser.');
}

async function handlePut(req: Request, res: Response, uid: string) {
  const segs = segments(req);
  if (segs[0] !== 'calendars' || segs.length !== 4) { res.sendStatus(400); return; }
  const colId = segs[2];
  const col = await getCollection(uid, colId);
  if (!col) { res.sendStatus(404); return; }
  if (!col.writable) { res.sendStatus(403); return; }   // tasks/milestones are read-only
  const name = segs[3].replace(/\.ics$/i, '');
  const body = typeof req.body === 'string' ? req.body : '';
  const result = await upsertMeetingFromICal(uid, name, body);
  if (!result) { res.sendStatus(400); return; }
  res.set('ETag', result.etag);
  res.sendStatus(result.created ? 201 : 204);
}

async function handleDelete(req: Request, res: Response, uid: string) {
  const segs = segments(req);
  if (segs[0] !== 'calendars' || segs.length !== 4) { res.sendStatus(400); return; }
  const colId = segs[2];
  const col = await getCollection(uid, colId);
  if (!col) { res.sendStatus(404); return; }
  if (!col.writable) { res.sendStatus(403); return; }
  const name = segs[3].replace(/\.ics$/i, '');
  const ok = await deleteMeetingByResource(uid, name);
  res.sendStatus(ok ? 204 : 404);
}

function handleProppatch(req: Request, res: Response) {
  // We don't persist client-side calendar properties (color/displayname), but
  // pretend-accept them so clients (Apple) don't surface an error.
  const names = [...(typeof req.body === 'string' ? req.body : '').matchAll(/<([a-z0-9]+:[a-z-]+)/gi)]
    .map(m => m[1])
    .filter(n => /color|displayname|calendar-order|calendar-timezone/i.test(n));
  const props = (names.length ? names : ['ic:calendar-color']).map(n => `<${n}/>`).join('');
  sendXml(res, multistatus(`<d:response><d:href>${req.originalUrl}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`));
}

// ── Entry middleware ─────────────────────────────────────────────────────────
export default async function caldavHandler(req: Request, res: Response): Promise<void> {
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.set('DAV', '1, 2, 3, calendar-access')
      .set('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT')
      .sendStatus(200);
    return;
  }

  // HTTP Basic auth (email + CalDAV app password).
  const auth = req.get('Authorization') ?? '';
  if (!auth.toLowerCase().startsWith('basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Solytiq Calendar"').sendStatus(401);
    return;
  }
  let email = '', password = '';
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    email = decoded.slice(0, i);
    password = decoded.slice(i + 1);
  } catch { /* fall through to 401 */ }

  const session = await verifyCaldavLogin(email, password);
  if (!session) {
    res.set('WWW-Authenticate', 'Basic realm="Solytiq Calendar"').sendStatus(401);
    return;
  }
  const uid = session.userId;
  const displayName = email;

  try {
    switch (method) {
      case 'PROPFIND':  await handlePropfind(req, res, uid, displayName); break;
      case 'REPORT':    await handleReport(req, res, uid); break;
      case 'GET':       await handleGet(req, res, uid, false); break;
      case 'HEAD':      await handleGet(req, res, uid, true); break;
      case 'PUT':       await handlePut(req, res, uid); break;
      case 'DELETE':    await handleDelete(req, res, uid); break;
      case 'PROPPATCH': handleProppatch(req, res); break;
      case 'MKCALENDAR':
      case 'MKCOL':
      case 'MOVE':
      case 'COPY':      res.sendStatus(403); break;
      default:          res.sendStatus(405);
    }
  } catch (err) {
    console.error('CalDAV error:', err);
    if (!res.headersSent) res.sendStatus(500);
  }
}
