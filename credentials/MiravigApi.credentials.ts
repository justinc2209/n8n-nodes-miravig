import type { Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

// Reuses the licensing mechanism from the extension/web app (license.js) --
// NOT the account + apiKey system from account.worker.js (accounts,
// /account/create, /quota/check), which has no product-side creation UI
// and is never called outside of tests (verified in the repo on
// 12/08/2026, see the scoping conversation). Decision: the n8n node pastes
// a Lemon Squeezy license key directly, like the extension and web app,
// rather than requiring a new "create a Miravig account" flow before
// launch.
//
// Optional: a free user needs no credential at all -- detection stays
// complete and free without a key. Only automatic masking and the
// business glossary check this key before applying (see Miravig.node.ts).
export class MiravigApi implements ICredentialType {
	name = 'miravigApi';
	displayName = 'Miravig License API';
	// Same icon as the node (nodes/Miravig/miravig.svg) -- a single source
	// file, never duplicated, referenced relatively from credentials/.
	icon: Icon = 'file:../nodes/Miravig/miravig.svg';
	documentationUrl = 'https://www.miravig.com/mode-emploi-n8n.html';
	properties: INodeProperties[] = [
		{
			displayName: 'License Key',
			name: 'licenseKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Optional. Your Miravig subscription license key (from your Lemon Squeezy purchase receipt) -- same key used in the browser extension and web app. Leave empty for free use: detection stays complete either way, but automatic masking and the business glossary require a valid key. Sent only to the Miravig licensing endpoint for validation.',
		},
	];

	// Declarative rather than methods.credentialTest on the node: n8n gives
	// absolute priority to this property as soon as it exists --
	// CredentialsTester.getCredentialTestFunction() (n8n-io/n8n,
	// packages/cli/src/services/credentials-tester.service.ts) returns as
	// soon as `type.test` is defined, without even looking at `testedBy` on
	// the node (verified directly in that file, not assumed). The two
	// mechanisms can therefore never coexist -- one wins outright, never a
	// safety net on top of the other.
	//
	// /license/validate always returns 200 for this endpoint (never
	// 400/403 on a missing key -- see account.worker.js#handleValidate,
	// fixed on 03/09/2026 specifically for this test): empty key ->
	// { tier: 'free' } (no `valid` field -- neither a success nor a
	// failure to report), invalid/expired key -> { valid: false, ... }
	// (relayed from Lemon Squeezy), valid key -> { valid: true, ... }. The
	// rule below only reports an error when `valid` is explicitly false;
	// { tier: 'free' } has no such field so it never triggers it.
	test: ICredentialTestRequest = {
		request: {
			method: 'POST',
			url: 'https://miravig-account.miravig-metrics.workers.dev/license/validate',
			body: { licenseKey: '={{$credentials.licenseKey}}' },
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'valid',
					value: false,
					message: 'This license key was not recognized as active by the Miravig licensing service.',
				},
			},
		],
	};
}
