// Smoke test: loads the compiled nodes, checks description integrity, and
// exercises execute()/poll()/loadOptions against a local mock Admin API.
import { createServer } from 'node:http';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { SolytiqCloud } = require('./dist/nodes/SolytiqCloud/SolytiqCloud.node.js');
const { SolytiqCloudTrigger } = require('./dist/nodes/SolytiqCloudTrigger/SolytiqCloudTrigger.node.js');
const { SolytiqCloudApi } = require('./dist/credentials/SolytiqCloudApi.credentials.js');

const node = new SolytiqCloud();
const trigger = new SolytiqCloudTrigger();
const cred = new SolytiqCloudApi();
assert.equal(cred.name, 'solytiqCloudApi');
assert.ok(node.description.properties.length > 10);

// 1. Every loadOptionsMethod referenced must exist.
const available = new Set(Object.keys(node.methods.loadOptions));
const collect = (props, out = []) => {
	for (const p of props) {
		if (p.typeOptions?.loadOptionsMethod) out.push(p.typeOptions.loadOptionsMethod);
		if (Array.isArray(p.options)) collect(p.options.filter((o) => o.name && o.type), out);
	}
	return out;
};
for (const m of collect(node.description.properties)) {
	assert.ok(available.has(m), `main node references missing loadOptions method ${m}`);
}
const trigAvailable = new Set(Object.keys(trigger.methods.loadOptions));
for (const m of collect(trigger.description.properties)) {
	assert.ok(trigAvailable.has(m), `trigger references missing loadOptions method ${m}`);
}
console.log('✓ nodes load, loadOptions methods all resolve');

// 2. Mock API server.
const requests = [];
const exportPayload = {
	users: [{ id: 'u1', username: 'niels', fullName: 'Niels', email: 'n@x.de', createdAt: '2026-01-01T00:00:00Z' }],
	workspaces: [{ id: 'ws_1', name: 'Personal', emoji: null, visibility: 'private', created_at: '2026-01-01T00:00:00Z' }],
	folders: [], sections: [{ id: 'sec_1', list_id: 'list_1', label: 'Tasks', position: 0 }],
	lists: [{ id: 'list_1', name: 'Groceries', emoji: '🛒', created_at: '2026-01-01T00:00:00Z' }],
	items: [{ id: '111', title: 'Milk', list_id: 'list_1', created_at: '2026-07-07T10:00:00', updated_at: '2026-07-07T11:00:00' }],
	timelines: [{ id: 'timeline_1', name: 'Launch', created_at: '2026-01-01T00:00:00Z' }],
	milestones: [{ id: 'milestone_1', timeline_id: 'timeline_1', title: 'Beta', status: 'upcoming', milestone_date: '2026-08-01' }],
	meetings: [{ id: 'mt_1', title: 'Standup', meeting_date: '2026-07-08', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-08T09:00:00Z' }],
};
const server = createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
		res.setHeader('content-type', 'application/json');
		if (req.url.startsWith('/api/admin-read/export')) return res.end(JSON.stringify(exportPayload));
		res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }));
	});
});
await new Promise((r) => server.listen(0, r));
const baseUrl = `http://127.0.0.1:${server.address().port}/`; // trailing slash on purpose

// 3. Minimal n8n context mocks.
const credentials = { baseUrl, apiToken: 'tok_123' };
const httpHelper = async (_credType, options) => {
	const url = new URL(options.url);
	if (options.qs) for (const [k, v] of Object.entries(options.qs)) url.searchParams.set(k, String(v));
	const resp = await fetch(url, {
		method: options.method,
		headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.apiToken}` },
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	return await resp.json();
};
const baseCtx = {
	getCredentials: async () => credentials,
	helpers: {
		httpRequestWithAuthentication: httpHelper,
		returnJsonArray: (data) => (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
		constructExecutionMetaData: (data, { itemData }) => data.map((d) => ({ ...d, pairedItem: itemData })),
	},
	getNode: () => ({ name: 'test' }),
	continueOnFail: () => false,
};

const makeExecCtx = (params) => ({
	...baseCtx,
	getInputData: () => [{ json: {} }],
	getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
});

// item create into a list section
let out = await node.execute.call(makeExecCtx({
	resource: 'item', operation: 'create', title: 'Buy milk', itemLocation: 'list',
	listId: 'list_1', sectionId: 'sec_1',
	additionalFields: { priority: 'High', deadline: '2026-07-10', ownerId: '', workspaceId: 'ws_SHOULD_BE_DROPPED' },
}));
let last = requests.at(-1);
assert.equal(last.url, '/api/admin-read/items');
assert.deepEqual(last.body, { title: 'Buy milk', priority: 'High', deadline: '2026-07-10', listId: 'list_1', sectionId: 'sec_1' });
assert.equal(last.auth, 'Bearer tok_123');
assert.ok(out[0][0].json.ok);

// user update with password
await node.execute.call(makeExecCtx({
	resource: 'user', operation: 'update', userId: 'u1', updateFields: { password: 'newpw', isAdmin: false },
}));
last = requests.at(-1);
assert.equal(last.method, 'PUT');
assert.equal(last.url, '/api/admin-read/users/u1');
assert.deepEqual(last.body, { password: 'newpw', isAdmin: false });

// export with filters
await node.execute.call(makeExecCtx({ resource: 'export', operation: 'get', filters: { workspaceId: 'ws_1', userId: '' } }));
last = requests.at(-1);
assert.equal(last.method, 'GET');
assert.ok(last.url.includes('workspaceId=ws_1') && !last.url.includes('userId'));

// milestone create
await node.execute.call(makeExecCtx({
	resource: 'milestone', operation: 'create', timelineId: 'timeline_1', title: 'GA',
	additionalFields: { status: 'in-progress' },
}));
last = requests.at(-1);
assert.equal(last.url, '/api/admin-read/timelines/timeline_1/milestones');
assert.deepEqual(last.body, { title: 'GA', status: 'in-progress' });

// workspace delete
await node.execute.call(makeExecCtx({ resource: 'workspace', operation: 'delete', workspaceId: 'ws_1' }));
last = requests.at(-1);
assert.equal(last.method, 'DELETE');
assert.equal(last.url, '/api/admin-read/workspaces/ws_1');
console.log('✓ execute() routes, bodies and auth verified for 5 operations');

// 4. loadOptions
const loadCtx = { ...baseCtx, getCurrentNodeParameter: () => 'list_1' };
const sections = await node.methods.loadOptions.getSections.call(loadCtx);
assert.deepEqual(sections.map((s) => s.value), ['sec_1']);
const owners = await node.methods.loadOptions.getOwners.call(loadCtx);
assert.equal(owners[0].value, '');
assert.equal(owners[1].value, 'u1');
const milestones = await node.methods.loadOptions.getMilestones.call(loadCtx);
assert.ok(milestones[0].name.includes('Launch'));
console.log('✓ loadOptions dropdowns build correctly');

// 5. trigger poll
const staticData = {};
const makePollCtx = (mode, params) => ({
	...baseCtx,
	getMode: () => mode,
	getWorkflowStaticData: () => staticData,
	getNodeParameter: (name, fallback) => (name in params ? params[name] : fallback),
});
// manual returns sample
let pollOut = await trigger.poll.call(makePollCtx('manual', { resource: 'item', event: 'created', filters: {} }));
assert.equal(pollOut[0].length, 1);
// first scheduled poll sets cursor, returns null
delete staticData.lastPoll;
pollOut = await trigger.poll.call(makePollCtx('trigger', { resource: 'item', event: 'created', filters: {} }));
assert.equal(pollOut, null);
// nothing new
pollOut = await trigger.poll.call(makePollCtx('trigger', { resource: 'item', event: 'created', filters: {} }));
assert.equal(pollOut, null);
// backdate cursor between created_at and updated_at -> item appears via updated_at
staticData.lastPoll = '2026-07-07T10:30:00Z';
pollOut = await trigger.poll.call(makePollCtx('trigger', { resource: 'item', event: 'createdOrUpdated', filters: {} }));
assert.equal(pollOut[0].length, 1);
assert.equal(pollOut[0][0].json.title, 'Milk');
console.log('✓ trigger poll cursor logic verified');

server.close();
console.log('ALL SMOKE TESTS PASSED');
