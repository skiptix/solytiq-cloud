import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
	compactBody,
	fetchExport,
	loadUsers,
	loadWorkspaces,
} from '../SolytiqCloud/GenericFunctions';

// Which export collection backs each watchable resource, and which JSON keys
// carry its creation / update timestamps.
const RESOURCE_CONFIG: Record<
	string,
	{ collection: string; createdKey: string; updatedKey?: string }
> = {
	folder: { collection: 'folders', createdKey: 'created_at' },
	item: { collection: 'items', createdKey: 'created_at', updatedKey: 'updated_at' },
	list: { collection: 'lists', createdKey: 'created_at' },
	meeting: { collection: 'meetings', createdKey: 'created_at', updatedKey: 'updated_at' },
	milestone: { collection: 'milestones', createdKey: 'created_at' },
	timeline: { collection: 'timelines', createdKey: 'created_at' },
	user: { collection: 'users', createdKey: 'createdAt' },
	workspace: { collection: 'workspaces', createdKey: 'created_at' },
};

export class SolytiqCloudTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Solytiq Cloud Trigger',
		name: 'solytiqCloudTrigger',
		icon: 'file:solytiq-cloud.png',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"] + ": " + $parameter["resource"]}}',
		description: 'Starts the workflow when something is created or updated in Solytiq Cloud',
		defaults: {
			name: 'Solytiq Cloud Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'solytiqCloudApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'item',
				options: [
					{ name: 'Folder', value: 'folder' },
					{ name: 'Item', value: 'item' },
					{ name: 'List', value: 'list' },
					{ name: 'Meeting', value: 'meeting' },
					{ name: 'Milestone', value: 'milestone' },
					{ name: 'Timeline', value: 'timeline' },
					{ name: 'User', value: 'user' },
					{ name: 'Workspace', value: 'workspace' },
				],
			},
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				default: 'created',
				options: [
					{ name: 'Created', value: 'created' },
					{
						name: 'Created or Updated',
						value: 'createdOrUpdated',
						description:
							'Update detection is only available for items and meetings (the API exposes an update timestamp for those)',
					},
				],
				displayOptions: { show: { resource: ['item', 'meeting'] } },
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				options: [
					{
						displayName: 'Workspace Name or ID',
						name: 'workspaceId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getWorkspaces' },
						default: '',
						description:
							'Only watch this workspace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'User Name or ID',
						name: 'userId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getUsers' },
						default: '',
						description:
							'Only watch data of workspaces this user owns or is a member of. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			getUsers: loadUsers,
			getWorkspaces: loadWorkspaces,
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const resource = this.getNodeParameter('resource') as string;
		const event = this.getNodeParameter('event', 'created') as string;
		const filters = this.getNodeParameter('filters', {}) as IDataObject;
		const config = RESOURCE_CONFIG[resource];

		const staticData = this.getWorkflowStaticData('node');
		const lastPoll = staticData.lastPoll as string | undefined;
		const now = new Date().toISOString();

		const data = await fetchExport.call(this, compactBody(filters));
		const rows = (data[config.collection] as IDataObject[]) ?? [];

		// Postgres renders TIMESTAMP columns without a timezone suffix; the
		// backend runs on UTC, so treat suffix-less values as UTC.
		const toEpoch = (value: unknown): number => {
			if (typeof value !== 'string' || !value) return NaN;
			const normalized = /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
			return Date.parse(normalized);
		};

		const timestampOf = (row: IDataObject): number => {
			const created = toEpoch(row[config.createdKey]);
			if (event === 'createdOrUpdated' && config.updatedKey) {
				const updated = toEpoch(row[config.updatedKey]);
				if (!Number.isNaN(updated) && (Number.isNaN(created) || updated > created)) {
					return updated;
				}
			}
			return created;
		};

		staticData.lastPoll = now;

		// Manual execution: return the latest rows so the user can inspect the shape.
		if (this.getMode() === 'manual') {
			const sample = rows.sort((a, b) => timestampOf(b) - timestampOf(a)).slice(0, 10);
			if (!sample.length) return null;
			return [this.helpers.returnJsonArray(sample)];
		}

		// First scheduled poll: just set the cursor.
		if (!lastPoll) return null;

		const lastPollEpoch = Date.parse(lastPoll);
		const fresh = rows.filter((row) => {
			const ts = timestampOf(row);
			return !Number.isNaN(ts) && ts > lastPollEpoch;
		});

		if (!fresh.length) return null;
		return [this.helpers.returnJsonArray(fresh)];
	}
}
