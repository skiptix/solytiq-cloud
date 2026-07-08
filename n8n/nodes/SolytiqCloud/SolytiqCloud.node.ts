import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	compactBody,
	loadFolders,
	loadItems,
	loadLists,
	loadMeetings,
	loadMilestones,
	loadOwners,
	loadSections,
	loadTimelines,
	loadUsers,
	loadWorkspaces,
	solytiqApiRequest,
} from './GenericFunctions';

const ownerIdField = (resource: string, description: string) => ({
	displayName: 'Owner Name or ID',
	name: 'ownerId',
	type: 'options' as const,
	typeOptions: { loadOptionsMethod: 'getOwners' },
	default: '',
	description: `${description} Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.`,
});

export class SolytiqCloud implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Solytiq Cloud',
		name: 'solytiqCloud',
		icon: 'file:solytiq-cloud.png',
		usableAsTool: true,
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with the Solytiq Cloud Admin API',
		defaults: {
			name: 'Solytiq Cloud',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'solytiqCloudApi',
				required: true,
			},
		],
		properties: [
			// ────────────────────────────── Resource ──────────────────────────────
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'export',
				options: [
					{ name: 'Export', value: 'export', description: 'Full instance data export (read scope)' },
					{ name: 'Folder', value: 'folder' },
					{ name: 'Item', value: 'item', description: 'A task on the dashboard or inside a list' },
					{ name: 'List', value: 'list' },
					{ name: 'Meeting', value: 'meeting' },
					{ name: 'Milestone', value: 'milestone' },
					{ name: 'Section', value: 'section' },
					{ name: 'Timeline', value: 'timeline' },
					{ name: 'User', value: 'user' },
					{ name: 'Workspace', value: 'workspace' },
				],
			},

			// ────────────────────────────── Operations ────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['export'] } },
				default: 'get',
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get the instance export',
						description:
							'Download everything the API key can see: users, workspaces, folders, lists, sections, items, timelines, milestones, meetings, attachments and timings',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['user'] } },
				default: 'create',
				options: [
					{ name: 'Create', value: 'create', action: 'Create a user' },
					{ name: 'Delete', value: 'delete', action: 'Delete a user' },
					{ name: 'Update', value: 'update', action: 'Update a user' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['workspace'] } },
				default: 'create',
				options: [
					{ name: 'Create', value: 'create', action: 'Create a workspace' },
					{ name: 'Delete', value: 'delete', action: 'Delete a workspace' },
					{ name: 'Update', value: 'update', action: 'Update a workspace' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['folder'] } },
				default: 'create',
				options: [
					{ name: 'Create', value: 'create', action: 'Create a folder' },
					{ name: 'Delete', value: 'delete', action: 'Delete a folder' },
					{ name: 'Update', value: 'update', action: 'Update a folder' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['list'] } },
				default: 'create',
				options: [
					{ name: 'Create', value: 'create', action: 'Create a list' },
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a list',
						description: 'Soft delete — the list goes to the trash (30-day restore)',
					},
					{ name: 'Update', value: 'update', action: 'Update a list' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['section'] } },
				default: 'create',
				options: [{ name: 'Create', value: 'create', action: 'Create a section in a list' }],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['item'] } },
				default: 'create',
				options: [
					{ name: 'Create', value: 'create', action: 'Create an item' },
					{ name: 'Delete', value: 'delete', action: 'Delete an item' },
					{ name: 'Update', value: 'update', action: 'Update an item' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['timeline'] } },
				default: 'create',
				options: [
					{ name: 'Create', value: 'create', action: 'Create a timeline' },
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete a timeline',
						description: 'Soft delete — the timeline goes to the trash (30-day restore)',
					},
					{ name: 'Update', value: 'update', action: 'Update a timeline' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['milestone'] } },
				default: 'create',
				options: [
					{ name: 'Create', value: 'create', action: 'Create a milestone' },
					{ name: 'Delete', value: 'delete', action: 'Delete a milestone' },
					{ name: 'Update', value: 'update', action: 'Update a milestone' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['meeting'] } },
				default: 'create',
				options: [
					{ name: 'Create', value: 'create', action: 'Create a meeting' },
					{ name: 'Delete', value: 'delete', action: 'Delete a meeting' },
					{ name: 'Update', value: 'update', action: 'Update a meeting' },
				],
			},

			// ────────────────────────────── Export ────────────────────────────────
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['export'], operation: ['get'] } },
				options: [
					{
						displayName: 'Workspace Name or ID',
						name: 'workspaceId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getWorkspaces' },
						default: '',
						description:
							'Only include this workspace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'User Name or ID',
						name: 'userId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getUsers' },
						default: '',
						description:
							'Only include workspaces this user owns or is a member of. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
				],
			},

			// ────────────────────────────── User ──────────────────────────────────
			{
				displayName: 'Username',
				name: 'username',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['user'], operation: ['create'] } },
			},
			{
				displayName: 'Password',
				name: 'password',
				type: 'string',
				typeOptions: { password: true },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['user'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['user'], operation: ['create'] } },
				options: [
					{ displayName: 'Email', name: 'email', type: 'string', placeholder: 'name@email.com', default: '' },
					{ displayName: 'Full Name', name: 'fullName', type: 'string', default: '' },
					{ displayName: 'Is Admin', name: 'isAdmin', type: 'boolean', default: false },
				],
			},
			{
				displayName: 'User Name or ID',
				name: 'userId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getUsers' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['user'], operation: ['update', 'delete'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['user'], operation: ['update'] } },
				options: [
					{ displayName: 'Full Name', name: 'fullName', type: 'string', default: '' },
					{ displayName: 'Is Admin', name: 'isAdmin', type: 'boolean', default: false },
					{
						displayName: 'Password',
						name: 'password',
						type: 'string',
						typeOptions: { password: true },
						default: '',
						description: 'Changing the password signs the user out everywhere',
					},
					{ displayName: 'Username', name: 'username', type: 'string', default: '' },
				],
			},

			// ────────────────────────────── Workspace ─────────────────────────────
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['workspace'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['workspace'], operation: ['create'] } },
				options: [
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					ownerIdField('workspace', 'The user who will own the workspace.'),
					{
						displayName: 'Visibility',
						name: 'visibility',
						type: 'options',
						options: [
							{ name: 'Private', value: 'private' },
							{ name: 'Public', value: 'public' },
						],
						default: 'private',
					},
				],
			},
			{
				displayName: 'Workspace Name or ID',
				name: 'workspaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getWorkspaces' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['workspace'], operation: ['update', 'delete'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>. Deleting only works when the workspace holds no lists, folders or timelines.',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['workspace'], operation: ['update'] } },
				options: [
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{
						displayName: 'Visibility',
						name: 'visibility',
						type: 'options',
						options: [
							{ name: 'Private', value: 'private' },
							{ name: 'Public', value: 'public' },
						],
						default: 'private',
					},
				],
			},

			// ────────────────────────────── Folder ────────────────────────────────
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['folder'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['folder'], operation: ['create'] } },
				options: [
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{
						displayName: 'Is Public',
						name: 'isPublic',
						type: 'boolean',
						default: true,
						description: 'Whether the folder is visible to other workspace members',
					},
					ownerIdField('folder', 'The user who will own the folder.'),
					{
						displayName: 'Workspace Name or ID',
						name: 'workspaceId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getWorkspaces' },
						default: '',
						description:
							'Defaults to the owner\'s Personal workspace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
				],
			},
			{
				displayName: 'Folder Name or ID',
				name: 'folderId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getFolders' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['folder'], operation: ['update', 'delete'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['folder'], operation: ['update'] } },
				options: [
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{ displayName: 'Is Public', name: 'isPublic', type: 'boolean', default: true },
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
				],
			},

			// ────────────────────────────── List ──────────────────────────────────
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['list'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['list'], operation: ['create'] } },
				options: [
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{
						displayName: 'Folder Name or ID',
						name: 'folderId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getFolders' },
						default: '',
						description:
							'Must belong to the owner. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Is Public',
						name: 'isPublic',
						type: 'boolean',
						default: false,
						description: 'Whether the list is visible to other workspace members',
					},
					ownerIdField('list', 'The user who will own the list.'),
					{
						displayName: 'Workspace Name or ID',
						name: 'workspaceId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getWorkspaces' },
						default: '',
						description:
							'Defaults to the owner\'s Personal workspace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
				],
			},
			{
				displayName: 'List Name or ID',
				name: 'listId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getLists' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['list'], operation: ['update', 'delete'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['list'], operation: ['update'] } },
				options: [
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{ displayName: 'Is Public', name: 'isPublic', type: 'boolean', default: false },
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
				],
			},

			// ────────────────────────────── Section ───────────────────────────────
			{
				displayName: 'List Name or ID',
				name: 'listId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getLists' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['section'], operation: ['create'] } },
				description:
					'The list to add the section to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Label',
				name: 'label',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['section'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['section'], operation: ['create'] } },
				options: [{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' }],
			},

			// ────────────────────────────── Item ──────────────────────────────────
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['item'], operation: ['create'] } },
			},
			{
				displayName: 'Add To',
				name: 'itemLocation',
				type: 'options',
				noDataExpression: true,
				default: 'dashboard',
				displayOptions: { show: { resource: ['item'], operation: ['create'] } },
				options: [
					{ name: 'Dashboard', value: 'dashboard', description: 'A standalone dashboard task' },
					{ name: 'List Section', value: 'list', description: 'A task inside a list section' },
				],
			},
			{
				displayName: 'List Name or ID',
				name: 'listId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getLists' },
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['item'], operation: ['create'], itemLocation: ['list'] },
				},
				description:
					'Must belong to the owner. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Section Name or ID',
				name: 'sectionId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getSections', loadOptionsDependsOn: ['listId'] },
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['item'], operation: ['create'], itemLocation: ['list'] },
				},
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['item'], operation: ['create'] } },
				options: [
					{
						displayName: 'Deadline',
						name: 'deadline',
						type: 'string',
						placeholder: 'YYYY-MM-DD',
						default: '',
					},
					{ displayName: 'Note', name: 'note', type: 'string', default: '' },
					ownerIdField('item', 'The user who will own the item.'),
					{
						displayName: 'Priority',
						name: 'priority',
						type: 'options',
						options: [
							{ name: 'High', value: 'High' },
							{ name: 'Low', value: 'Low' },
							{ name: 'Medium', value: 'Medium' },
						],
						default: 'Medium',
					},
					{
						displayName: 'Workspace Name or ID',
						name: 'workspaceId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getWorkspaces' },
						default: '',
						description:
							'Dashboard items only — list items inherit the list\'s workspace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
				],
			},
			{
				displayName: 'Item Name or ID',
				name: 'itemId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getItems' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['item'], operation: ['update', 'delete'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['item'], operation: ['update'] } },
				options: [
					{
						displayName: 'Checked',
						name: 'checked',
						type: 'boolean',
						default: false,
						description: 'Whether the item is marked as done',
					},
					{
						displayName: 'Deadline',
						name: 'deadline',
						type: 'string',
						placeholder: 'YYYY-MM-DD',
						default: '',
					},
					{ displayName: 'Note', name: 'note', type: 'string', default: '' },
					{
						displayName: 'Priority',
						name: 'priority',
						type: 'options',
						options: [
							{ name: 'High', value: 'High' },
							{ name: 'Low', value: 'Low' },
							{ name: 'Medium', value: 'Medium' },
						],
						default: 'Medium',
					},
					{ displayName: 'Title', name: 'title', type: 'string', default: '' },
				],
			},

			// ────────────────────────────── Timeline ──────────────────────────────
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['timeline'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['timeline'], operation: ['create'] } },
				options: [
					{ displayName: 'Color', name: 'color', type: 'color', default: '' },
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{
						displayName: 'Folder Name or ID',
						name: 'folderId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getFolders' },
						default: '',
						description:
							'Must belong to the owner. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Is Public',
						name: 'isPublic',
						type: 'boolean',
						default: false,
						description: 'Whether the timeline is visible to other workspace members',
					},
					{
						displayName: 'Layout',
						name: 'layout',
						type: 'options',
						options: [
							{ name: 'Compact', value: 'compact' },
							{ name: 'Detailed', value: 'detailed' },
							{ name: 'Vertical', value: 'vertical' },
						],
						default: 'vertical',
					},
					ownerIdField('timeline', 'The user who will own the timeline.'),
					{ displayName: 'Subtitle', name: 'subtitle', type: 'string', default: '' },
					{
						displayName: 'Workspace Name or ID',
						name: 'workspaceId',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getWorkspaces' },
						default: '',
						description:
							'Defaults to the owner\'s Personal workspace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
				],
			},
			{
				displayName: 'Timeline Name or ID',
				name: 'timelineId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTimelines' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['timeline'], operation: ['update', 'delete'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['timeline'], operation: ['update'] } },
				options: [
					{ displayName: 'Color', name: 'color', type: 'color', default: '' },
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{ displayName: 'Is Public', name: 'isPublic', type: 'boolean', default: false },
					{
						displayName: 'Layout',
						name: 'layout',
						type: 'options',
						options: [
							{ name: 'Compact', value: 'compact' },
							{ name: 'Detailed', value: 'detailed' },
							{ name: 'Vertical', value: 'vertical' },
						],
						default: 'vertical',
					},
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'Subtitle', name: 'subtitle', type: 'string', default: '' },
				],
			},

			// ────────────────────────────── Milestone ─────────────────────────────
			{
				displayName: 'Timeline Name or ID',
				name: 'timelineId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTimelines' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['milestone'], operation: ['create'] } },
				description:
					'The timeline to add the milestone to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['milestone'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['milestone'], operation: ['create'] } },
				options: [
					{ displayName: 'Color', name: 'color', type: 'color', default: '' },
					{
						displayName: 'Date',
						name: 'date',
						type: 'string',
						placeholder: 'YYYY-MM-DD',
						default: '',
					},
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: [
							{ name: 'Done', value: 'done' },
							{ name: 'In Progress', value: 'in-progress' },
							{ name: 'Upcoming', value: 'upcoming' },
						],
						default: 'upcoming',
					},
					{
						displayName: 'Time',
						name: 'time',
						type: 'string',
						placeholder: 'HH:MM',
						default: '',
					},
				],
			},
			{
				displayName: 'Milestone Name or ID',
				name: 'milestoneId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getMilestones' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['milestone'], operation: ['update', 'delete'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['milestone'], operation: ['update'] } },
				options: [
					{ displayName: 'Color', name: 'color', type: 'color', default: '' },
					{
						displayName: 'Date',
						name: 'date',
						type: 'string',
						placeholder: 'YYYY-MM-DD',
						default: '',
					},
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{ displayName: 'Emoji', name: 'emoji', type: 'string', default: '' },
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: [
							{ name: 'Done', value: 'done' },
							{ name: 'In Progress', value: 'in-progress' },
							{ name: 'Upcoming', value: 'upcoming' },
						],
						default: 'upcoming',
					},
					{
						displayName: 'Time',
						name: 'time',
						type: 'string',
						placeholder: 'HH:MM',
						default: '',
					},
					{ displayName: 'Title', name: 'title', type: 'string', default: '' },
				],
			},

			// ────────────────────────────── Meeting ───────────────────────────────
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['meeting'], operation: ['create'] } },
			},
			{
				displayName: 'Date',
				name: 'date',
				type: 'string',
				required: true,
				placeholder: 'YYYY-MM-DD',
				default: '',
				displayOptions: { show: { resource: ['meeting'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['meeting'], operation: ['create'] } },
				options: [
					{
						displayName: 'All Day',
						name: 'allDay',
						type: 'boolean',
						default: false,
						description: 'Whether the meeting lasts all day (start/end time are ignored)',
					},
					{ displayName: 'Color', name: 'color', type: 'color', default: '' },
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{
						displayName: 'End Time',
						name: 'endTime',
						type: 'string',
						placeholder: 'HH:MM',
						default: '',
					},
					{ displayName: 'Location', name: 'location', type: 'string', default: '' },
					ownerIdField('meeting', 'The user who will own the meeting.'),
					{
						displayName: 'Start Time',
						name: 'startTime',
						type: 'string',
						placeholder: 'HH:MM',
						default: '',
					},
				],
			},
			{
				displayName: 'Meeting Name or ID',
				name: 'meetingId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getMeetings' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['meeting'], operation: ['update', 'delete'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['meeting'], operation: ['update'] } },
				description:
					'Note: the API fully replaces Description, Location, Start Time, End Time and Color on every update — fields you do not set here are cleared on the meeting',
				options: [
					{ displayName: 'All Day', name: 'allDay', type: 'boolean', default: false },
					{ displayName: 'Color', name: 'color', type: 'color', default: '' },
					{
						displayName: 'Date',
						name: 'date',
						type: 'string',
						placeholder: 'YYYY-MM-DD',
						default: '',
					},
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{
						displayName: 'End Time',
						name: 'endTime',
						type: 'string',
						placeholder: 'HH:MM',
						default: '',
					},
					{ displayName: 'Location', name: 'location', type: 'string', default: '' },
					{
						displayName: 'Start Time',
						name: 'startTime',
						type: 'string',
						placeholder: 'HH:MM',
						default: '',
					},
					{ displayName: 'Title', name: 'title', type: 'string', default: '' },
				],
			},
		],
	};

	methods = {
		loadOptions: {
			getUsers: loadUsers,
			getOwners: loadOwners,
			getWorkspaces: loadWorkspaces,
			getFolders: loadFolders,
			getLists: loadLists,
			getSections: loadSections,
			getItems: loadItems,
			getTimelines: loadTimelines,
			getMilestones: loadMilestones,
			getMeetings: loadMeetings,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let response: IDataObject;

				if (resource === 'export') {
					const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
					response = await solytiqApiRequest.call(this, 'GET', '/export', undefined, compactBody(filters));
				} else if (resource === 'user') {
					if (operation === 'create') {
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'POST', '/users', compactBody({
							username: this.getNodeParameter('username', i),
							password: this.getNodeParameter('password', i),
							...additional,
						} as IDataObject));
					} else if (operation === 'update') {
						const userId = this.getNodeParameter('userId', i) as string;
						const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'PUT', `/users/${userId}`, updateFields);
					} else {
						const userId = this.getNodeParameter('userId', i) as string;
						response = await solytiqApiRequest.call(this, 'DELETE', `/users/${userId}`);
					}
				} else if (resource === 'workspace') {
					if (operation === 'create') {
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'POST', '/workspaces', compactBody({
							name: this.getNodeParameter('name', i),
							...additional,
						} as IDataObject));
					} else if (operation === 'update') {
						const workspaceId = this.getNodeParameter('workspaceId', i) as string;
						const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'PUT', `/workspaces/${workspaceId}`, updateFields);
					} else {
						const workspaceId = this.getNodeParameter('workspaceId', i) as string;
						response = await solytiqApiRequest.call(this, 'DELETE', `/workspaces/${workspaceId}`);
					}
				} else if (resource === 'folder') {
					if (operation === 'create') {
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'POST', '/folders', compactBody({
							name: this.getNodeParameter('name', i),
							...additional,
						} as IDataObject));
					} else if (operation === 'update') {
						const folderId = this.getNodeParameter('folderId', i) as string;
						const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'PUT', `/folders/${folderId}`, updateFields);
					} else {
						const folderId = this.getNodeParameter('folderId', i) as string;
						response = await solytiqApiRequest.call(this, 'DELETE', `/folders/${folderId}`);
					}
				} else if (resource === 'list') {
					if (operation === 'create') {
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'POST', '/lists', compactBody({
							name: this.getNodeParameter('name', i),
							...additional,
						} as IDataObject));
					} else if (operation === 'update') {
						const listId = this.getNodeParameter('listId', i) as string;
						const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'PUT', `/lists/${listId}`, updateFields);
					} else {
						const listId = this.getNodeParameter('listId', i) as string;
						response = await solytiqApiRequest.call(this, 'DELETE', `/lists/${listId}`);
					}
				} else if (resource === 'section') {
					const listId = this.getNodeParameter('listId', i) as string;
					const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
					response = await solytiqApiRequest.call(this, 'POST', `/lists/${listId}/sections`, compactBody({
						label: this.getNodeParameter('label', i),
						...additional,
					} as IDataObject));
				} else if (resource === 'item') {
					if (operation === 'create') {
						const itemLocation = this.getNodeParameter('itemLocation', i) as string;
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						const body: IDataObject = {
							title: this.getNodeParameter('title', i),
							...additional,
						};
						if (itemLocation === 'list') {
							body.listId = this.getNodeParameter('listId', i);
							body.sectionId = this.getNodeParameter('sectionId', i);
							delete body.workspaceId; // list items inherit the list's workspace
						}
						response = await solytiqApiRequest.call(this, 'POST', '/items', compactBody(body));
					} else if (operation === 'update') {
						const itemId = this.getNodeParameter('itemId', i) as string;
						const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'PUT', `/items/${itemId}`, updateFields);
					} else {
						const itemId = this.getNodeParameter('itemId', i) as string;
						response = await solytiqApiRequest.call(this, 'DELETE', `/items/${itemId}`);
					}
				} else if (resource === 'timeline') {
					if (operation === 'create') {
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'POST', '/timelines', compactBody({
							name: this.getNodeParameter('name', i),
							...additional,
						} as IDataObject));
					} else if (operation === 'update') {
						const timelineId = this.getNodeParameter('timelineId', i) as string;
						const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'PUT', `/timelines/${timelineId}`, updateFields);
					} else {
						const timelineId = this.getNodeParameter('timelineId', i) as string;
						response = await solytiqApiRequest.call(this, 'DELETE', `/timelines/${timelineId}`);
					}
				} else if (resource === 'milestone') {
					if (operation === 'create') {
						const timelineId = this.getNodeParameter('timelineId', i) as string;
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'POST', `/timelines/${timelineId}/milestones`, compactBody({
							title: this.getNodeParameter('title', i),
							...additional,
						} as IDataObject));
					} else if (operation === 'update') {
						const milestoneId = this.getNodeParameter('milestoneId', i) as string;
						const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'PUT', `/milestones/${milestoneId}`, updateFields);
					} else {
						const milestoneId = this.getNodeParameter('milestoneId', i) as string;
						response = await solytiqApiRequest.call(this, 'DELETE', `/milestones/${milestoneId}`);
					}
				} else if (resource === 'meeting') {
					if (operation === 'create') {
						const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'POST', '/meetings', compactBody({
							title: this.getNodeParameter('title', i),
							date: this.getNodeParameter('date', i),
							...additional,
						} as IDataObject));
					} else if (operation === 'update') {
						const meetingId = this.getNodeParameter('meetingId', i) as string;
						const updateFields = this.getNodeParameter('updateFields', i, {}) as IDataObject;
						response = await solytiqApiRequest.call(this, 'PUT', `/meetings/${meetingId}`, updateFields);
					} else {
						const meetingId = this.getNodeParameter('meetingId', i) as string;
						response = await solytiqApiRequest.call(this, 'DELETE', `/meetings/${meetingId}`);
					}
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`, {
						itemIndex: i,
					});
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(response),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
