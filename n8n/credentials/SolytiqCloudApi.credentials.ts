import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SolytiqCloudApi implements ICredentialType {
	name = 'solytiqCloudApi';

	displayName = 'Solytiq Cloud API';

	documentationUrl = 'https://www.npmjs.com/package/n8n-nodes-solytiq-cloud';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://your-solytiq-cloud-instance.com',
			required: true,
			description:
				'The base URL of your Solytiq Cloud instance (scheme + host, without /api)',
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description:
				'An Admin API key created in Solytiq Cloud (Settings → Admin API keys). The key\'s scopes decide which operations are allowed.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiToken}}',
			},
		},
	};

	// A cheap authenticated call: the userId filter matches no user, so the
	// export comes back nearly empty. Requires the key to have the "read" scope.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(new RegExp("/+$"), "")}}',
			url: '/api/admin-read/export',
			qs: {
				userId: '00000000-0000-0000-0000-000000000000',
			},
		},
	};
}
