import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	IPollFunctions,
} from 'n8n-workflow';

export type SolytiqContext = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions;

/** Make an authenticated request against the Solytiq Cloud Admin API. */
export async function solytiqApiRequest(
	this: SolytiqContext,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const credentials = await this.getCredentials('solytiqCloudApi');
	const baseUrl = (credentials.baseUrl as string).replace(/\/+$/, '');
	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}/api/admin-read${endpoint}`,
		json: true,
	};
	if (body && Object.keys(body).length) {
		options.body = body;
	}
	if (qs && Object.keys(qs).length) {
		options.qs = qs;
	}
	return (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'solytiqCloudApi',
		options,
	)) as IDataObject;
}

/** Fetch the instance export (used for the dynamic dropdowns; needs the "read" scope). */
export async function fetchExport(
	this: SolytiqContext,
	qs: IDataObject = {},
): Promise<IDataObject> {
	return solytiqApiRequest.call(this, 'GET', '/export', undefined, qs);
}

/** Remove empty-string / null / undefined values (keeps `false` and `0`). */
export function compactBody(body: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(body)) {
		if (value === undefined || value === null || value === '') continue;
		out[key] = value;
	}
	return out;
}

function sortByName(options: INodePropertyOptions[]): INodePropertyOptions[] {
	return options.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadUsers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const data = await fetchExport.call(this);
	const users = (data.users as IDataObject[]) ?? [];
	return sortByName(
		users.map((u) => ({
			name: `${u.username}${u.fullName ? ` (${u.fullName})` : ''}`,
			value: u.id as string,
			description: u.email as string,
		})),
	);
}

/** Same as loadUsers but with a leading "key creator" default entry. */
export async function loadOwners(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const users = await loadUsers.call(this);
	return [{ name: 'API Key Creator (Default)', value: '' }, ...users];
}

export async function loadWorkspaces(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const data = await fetchExport.call(this);
	const workspaces = (data.workspaces as IDataObject[]) ?? [];
	return sortByName(
		workspaces.map((w) => ({
			name: `${w.emoji ? `${w.emoji} ` : ''}${w.name}`,
			value: w.id as string,
			description: `${w.visibility} · ${w.id}`,
		})),
	);
}

export async function loadFolders(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const data = await fetchExport.call(this);
	const folders = (data.folders as IDataObject[]) ?? [];
	return sortByName(
		folders.map((f) => ({
			name: `${f.emoji ? `${f.emoji} ` : ''}${f.name}`,
			value: f.id as string,
			description: f.id as string,
		})),
	);
}

export async function loadLists(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const data = await fetchExport.call(this);
	const lists = (data.lists as IDataObject[]) ?? [];
	return sortByName(
		lists.map((l) => ({
			name: `${l.emoji ? `${l.emoji} ` : ''}${l.name}`,
			value: l.id as string,
			description: l.id as string,
		})),
	);
}

export async function loadSections(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const listId = this.getCurrentNodeParameter('listId') as string;
	const data = await fetchExport.call(this);
	const sections = ((data.sections as IDataObject[]) ?? []).filter(
		(s) => !listId || s.list_id === listId,
	);
	return sections
		.sort((a, b) => (a.position as number) - (b.position as number))
		.map((s) => ({
			name: `${s.emoji ? `${s.emoji} ` : ''}${s.label}`,
			value: s.id as string,
			description: s.id as string,
		}));
}

export async function loadItems(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const data = await fetchExport.call(this);
	const items = (data.items as IDataObject[]) ?? [];
	const lists = (data.lists as IDataObject[]) ?? [];
	const listNames = new Map(lists.map((l) => [l.id as string, l.name as string]));
	return sortByName(
		items.map((t) => ({
			name: `${t.title}${t.list_id ? ` — ${listNames.get(t.list_id as string) ?? 'list'}` : ' — dashboard'}`,
			value: String(t.id),
			description: `id ${t.id}`,
		})),
	);
}

export async function loadTimelines(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const data = await fetchExport.call(this);
	const timelines = (data.timelines as IDataObject[]) ?? [];
	return sortByName(
		timelines.map((t) => ({
			name: `${t.emoji ? `${t.emoji} ` : ''}${t.name}`,
			value: t.id as string,
			description: t.id as string,
		})),
	);
}

export async function loadMilestones(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const data = await fetchExport.call(this);
	const milestones = (data.milestones as IDataObject[]) ?? [];
	const timelines = (data.timelines as IDataObject[]) ?? [];
	const timelineNames = new Map(timelines.map((t) => [t.id as string, t.name as string]));
	return sortByName(
		milestones.map((m) => ({
			name: `${m.title} — ${timelineNames.get(m.timeline_id as string) ?? 'timeline'}`,
			value: m.id as string,
			description: `${m.status}${m.milestone_date ? ` · ${m.milestone_date}` : ''}`,
		})),
	);
}

export async function loadMeetings(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const data = await fetchExport.call(this);
	const meetings = (data.meetings as IDataObject[]) ?? [];
	return meetings
		.sort((a, b) => String(b.meeting_date).localeCompare(String(a.meeting_date)))
		.map((m) => ({
			name: `${m.title} (${String(m.meeting_date).slice(0, 10)})`,
			value: m.id as string,
			description: m.id as string,
		}));
}
