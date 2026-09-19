import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

// Business logic stays in plain JS, tested independently of n8n (see
// lib/core.js, lib/license-source.js and their test suites) -- this
// file only translates n8n parameters into configuration for
// core.analyze()/core.demasquerText(), and back for the output.
//
// Merges the two former nodes (Miravig masking + MiravigDemasquer) into a
// single type with an "Operation" parameter -- reverses the decision from
// 12/08/2026 documented in MiravigDemasquer.node.ts's history (two
// separate nodes). Reversal decided during the 12/08/2026 scoping session
// (follow-up): no external user of the node to date (never published on
// npm), so no migration to manage -- see the scoping discussion for the
// full reasoning (n8n verification's "one package = one service"
// compliance, among others). The final workflow still requires TWO
// INSTANCES of this node (one in "Mask" mode before the LLM, one in
// "Unmask" mode after) -- unchanged.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./lib/core.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const license = require('./lib/license-source.js');

// Real URL of the license Worker (confirmed in the repo on 12/08/2026 --
// same Worker as the extension and web app, extension-gardefou/license.js
// and Miravig V3/license.js). The old /quota/check endpoint (account +
// apiKey) is abandoned: that system has no product-side account-creation
// UI and is never called outside of tests -- see the scoping discussion
// from 12/08/2026. The node now calls /license/validate directly, like
// the extension/web app.
const LICENSE_VALIDATE_URL = 'https://miravig-account.miravig-metrics.workers.dev/license/validate';

// Periodic revalidation rather than on every execution (scoping decision
// from 12/08/2026): 15 minutes, deliberately shorter than the 72h used on
// the extension/web app side -- an n8n workflow can run unsupervised for
// days, a cancelled subscription needs to propagate faster than in an
// interactive surface where the user would reopen the panel regularly
// anyway.
const LICENSE_CACHE_MS = 15 * 60 * 1000;

const ALL_CATEGORIES = [
	'credit-card', 'siren', 'siret', 'social-security',
	'national-id-es', 'national-id-de', 'national-id-pt', 'national-id-it',
	'national-id-au', 'national-id-ch', 'national-id-ca',
	'passport', 'iban', 'tax-id', 'license-plate', 'connection-string',
	'jwt', 'ip-address', 'geolocation', 'api-key', 'password', 'email',
	'phone', 'address', 'legal-person-name',
	'special-category-health', 'special-category-ethnicity',
	'special-category-religion', 'special-category-political',
	'special-category-union', 'special-category-sexual-orientation',
	'special-category-criminal',
	'business-term',
];

// French -> English translation layer, applied only at this node's
// output -- never touches lib/rules-source.js or lib/glossary-source.js
// (shared engine, bit-for-bit identical to the extension and web app, out
// of scope for this session; translating it there would change the
// behavior of the two other products). Discovered while testing under
// real conditions (12/08/2026, follow-up): detectSensitiveData()'s labels
// are already correctly translated via its `locale` parameter (see
// rules-source.js, function L(fr, en)) -- only the business glossary
// label (glossary-source.js, detectGlossaryMatches) is hardcoded in
// French, with no locale concept. A lookup table rather than adding a
// `locale` parameter to the shared module: a smaller surface of change,
// no risk to the two other products. Explicit fallback to the original
// string if a new French label ever appeared on the shared-engine side
// without being added here -- never an empty string or an exception,
// just not translated yet.
const FRENCH_TO_ENGLISH_DETECTION_LABELS: Record<string, string> = {
	'Terme du glossaire métier': 'Business glossary term',
};

function translateDetectionLabel(label: string): string {
	return FRENCH_TO_ENGLISH_DETECTION_LABELS[label] ?? label;
}

function translateDetections(
	detections: Array<{ category: string; confidence: string; label: string; masked: boolean }>,
) {
	return detections.map((d) => ({ ...d, label: translateDetectionLabel(d.label) }));
}

// Never contains the license key in plain text (Semgrep audit from
// 21/08/2026, see SESSION_LOG.md): workflowStaticData (where this record
// is persisted) is exported with the workflow, unlike
// localStorage/chrome.storage.local (private, never shared) on the web
// app/extension side. licenseKeyHash is recomputed on the fly from the
// credential on every check, never read back from this record -- see
// checkLicense() below.
interface LicenseCacheRecord {
	status: string;
	checkedAt: number;
	signatureHashed: string | null;
}

interface LicenseCheckResult {
	// false = no key provided, no network call attempted (free user --
	// normal case, not an error).
	checked: boolean;
	// null = impossible to determine (network failure, "continue" choice --
	// treated as not licensed as a precaution, never as licensed by
	// default: consistent with the fail-closed behavior already in place
	// on the extension side, see license.js#validate).
	valid: boolean | null;
	warning: string | null;
}

function deriveStatus(data: IDataObject): string {
	const licenseKeyMeta = data.license_key as IDataObject | undefined;
	if (licenseKeyMeta && typeof licenseKeyMeta.status === 'string') return licenseKeyMeta.status;
	return data.valid === true ? 'active' : 'inactive';
}

// Checks the license against the Worker (or the workflowStaticData cache
// if it is still fresh and validly signed) -- once per node execution,
// never per item in a batch (same principle as the old /quota/check,
// Session decision from 29/07/2026). Only calls the network IF a key is
// configured: a free user who requests neither masking nor the business
// glossary never triggers this function (see execute()), and a free user
// who requests them anyway gets an explicit gating message without ever
// needing a key.
async function checkLicense(ctx: IExecuteFunctions, licenseKey: string): Promise<LicenseCheckResult> {
	if (!licenseKey) return { checked: false, valid: false, warning: null };

	// licenseKeyHash recomputed HERE, from the key actually configured in
	// the credential -- never read from workflowStaticData. Serves both as
	// the cache key (no fragment of the plaintext license, even partial, in
	// a property name that ends up in the exported JSON) and as the value
	// covered by the signature verified below.
	const licenseKeyHash = license.sha256Hex(licenseKey);
	const staticData = ctx.getWorkflowStaticData('node') as IDataObject;
	const cacheKey = `licenseCache_${licenseKeyHash.slice(0, 16)}`;
	const cached = staticData[cacheKey] as LicenseCacheRecord | undefined;

	if (
		cached &&
		license.isCacheFresh(cached, LICENSE_CACHE_MS) &&
		(await license.verifyLicenseSignatureHashed({ licenseKeyHash, status: cached.status, checkedAt: cached.checkedAt, signatureHashed: cached.signatureHashed }))
	) {
		return { checked: true, valid: cached.status === 'active' || cached.status === 'valid', warning: null };
	}

	try {
		const response = (await ctx.helpers.httpRequest({
			method: 'POST',
			url: LICENSE_VALIDATE_URL,
			body: { licenseKey },
			json: true,
			// The Worker returns 400/403 with a usable JSON body
			// (invalid license / doesn't belong to Miravig) -- this is
			// NOT a verification failure (the network works, the
			// response is unambiguous), so it must never fall into the
			// same catch block as a genuine network failure.
			ignoreHttpStatusErrors: true,
			// Discovered while testing under real conditions (12/08/2026,
			// follow-up): without an explicit timeout, a Worker that accepts
			// the connection but never responds blocks the workflow
			// indefinitely -- never reaching the onLicenseCheckFailure
			// logic. 10s: the check only happens once per LICENSE_CACHE_MS
			// thanks to the cache (15 min in production), so an occasional
			// 10s delay at worst does not affect the smoothness of the
			// rest. A timeout resolves as a rejected promise like any other
			// network failure (DNS, connection refused...) -- caught by the
			// same catch block below, no separate code path to maintain.
			timeout: 10000,
		})) as IDataObject;

		const status = deriveStatus(response);
		const record: LicenseCacheRecord = {
			status,
			checkedAt: (response.checkedAt as number) || Date.now(),
			signatureHashed: (response.signatureHashed as string) || null,
		};
		staticData[cacheKey] = record;

		return { checked: true, valid: response.valid === true, warning: null };
	} catch (error) {
		// Genuine network failure (Worker unreachable, DNS, timeout...) -- NOT
		// an explicit response from the Worker (that case is already covered
		// by `response.valid` above, which never falls into this catch
		// block). Scoping revision from 12/08/2026 (follow-up): fail-closed
		// should only apply to an EXPLICIT "invalid" response from the
		// Worker, not to a plain network failure -- a failure falls back to
		// the LAST verified status in cache (valid or invalid, whichever it
		// is), not systematically to "not licensed". Freshness (15 min)
		// only applies to the nominal path above; here, this is a
		// last-resort fallback, a signed cache even if stale is still
		// better information than none. Only a total absence of a usable
		// cache (never successfully verified on this node, or an invalid
		// signature -- forged or corrupted) falls back to the old
		// fail-closed behavior ("valid: null"), for lack of anything
		// better.
		if (
			cached &&
			(await license.verifyLicenseSignatureHashed({ licenseKeyHash, status: cached.status, checkedAt: cached.checkedAt, signatureHashed: cached.signatureHashed }))
		) {
			const cachedValid = cached.status === 'active' || cached.status === 'valid';
			return {
				checked: true,
				valid: cachedValid,
				warning: `Could not verify your Miravig subscription right now (licensing endpoint unreachable) -- using the last verified status from ${new Date(cached.checkedAt).toISOString()} (${cachedValid ? 'licensed' : 'not licensed'}).`,
			};
		}
		return {
			checked: true,
			valid: null,
			warning:
				'Could not verify your Miravig subscription (licensing endpoint unreachable, no previously verified status available on this node) -- paid feature(s) not applied as a precaution.',
		};
	}
}

interface GatingResult {
	maskingApplied: boolean;
	businessGlossaryApplied: boolean;
	licenseChecked: boolean;
	licenseValid: boolean | null;
	licenseWarning: string | null;
	gatingMessage: string | null;
}

// Resolves masking/business-glossary gating for one execution -- never a
// silent fallback to degraded behavior: if either paid feature is
// requested without a valid license, the output always explains it
// rather than just silently doing nothing.
async function resolveGating(
	ctx: IExecuteFunctions,
	licenseKey: string,
	maskingRequested: boolean,
	businessGlossaryRequested: boolean,
	onLicenseCheckFailure: string,
	nodeItemIndex: number,
): Promise<GatingResult> {
	if (!maskingRequested && !businessGlossaryRequested) {
		return {
			maskingApplied: false,
			businessGlossaryApplied: false,
			licenseChecked: false,
			licenseValid: null,
			licenseWarning: null,
			gatingMessage: null,
		};
	}

	// The field now has a default ('stop') -- this guard no longer protects
	// against a field left empty, but is still useful against an n8n
	// expression ({{ }}) that would resolve to something other than
	// 'stop' or 'continue' at runtime (the field doesn't have
	// noDataExpression).
	if (onLicenseCheckFailure !== 'stop' && onLicenseCheckFailure !== 'continue') {
		throw new NodeOperationError(
			ctx.getNode(),
			'"On License Check Failure" must resolve to "Stop Workflow" or "Continue Anyway".',
			{ itemIndex: nodeItemIndex },
		);
	}

	const result = await checkLicense(ctx, licenseKey);

	// "stop" no longer cuts execution on ANY warning -- only when `valid`
	// remains genuinely indeterminate (`null`, no usable cache to fall
	// back on). A successful fallback to a signed cache (see checkLicense)
	// carries an informational warning but resolves to a real boolean
	// value: the workflow continues on that basis, "stop" has nothing to
	// interrupt.
	if (result.valid === null && onLicenseCheckFailure === 'stop') {
		throw new NodeOperationError(
			ctx.getNode(),
			`${result.warning} Execution stopped ("On License Check Failure" = "Stop workflow").`,
			{ itemIndex: nodeItemIndex },
		);
	}

	const licensed = result.valid === true;
	let gatingMessage: string | null = null;
	if (!licensed) {
		const requested = [
			maskingRequested ? 'Automatic Masking' : null,
			businessGlossaryRequested ? 'Business Glossary' : null,
		].filter(Boolean).join(' and ');
		gatingMessage = result.warning
			? `${requested} requested but not applied -- ${result.warning}`
			: `${requested} requires an active Miravig subscription -- not applied. Configure a valid License Key in the node credentials to unlock it.`;
	}

	return {
		maskingApplied: licensed && maskingRequested,
		businessGlossaryApplied: licensed && businessGlossaryRequested,
		licenseChecked: result.checked,
		licenseValid: result.valid,
		licenseWarning: result.warning,
		gatingMessage,
	};
}

function parseBusinessGlossary(
	ctx: IExecuteFunctions,
	raw: string,
	itemIndex: number,
): Array<{ term: string; id?: number; groups?: string[]; caseSensitive?: boolean }> {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Business Glossary: invalid JSON in the "Business Glossary (JSON)" parameter (${(error as Error).message}).`,
			{ itemIndex },
		);
	}
}

export class Miravig implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Miravig',
		name: 'miravig',
		icon: 'file:miravig.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Detects sensitive data before sending text to an LLM, and reverses masking afterwards -- same detection engine as the Miravig browser extension and web app. Prompt-quality checks (variables, unfilled placeholders, JSON-wrapping risk, verbatim-preservation risk) are not part of this node -- see the separate n8n-checker.html tool for those.',
		defaults: { name: 'Miravig' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		// A single output by default (12/08/2026 scoping spec): the 2nd
		// output ("Flagged") only appears if the user explicitly enables
		// "Route Flagged Items to a Second Output" in Mask mode --
		// reduces the resemblance to a flow-control node (IF-like) by
		// default, a concern flagged for n8n verification ("logic/flow
		// control" classification, never formally settled against n8n's
		// documentation -- to check separately before submission, see
		// README).
		outputs:
			'={{$parameter["operation"] === "mask" && $parameter["enableRoutingOutput"] === true ? ["main", "main"] : ["main"]}}',
		// outputNames does not accept an expression (unlike `outputs`, see
		// n8n-workflow/Interfaces.d.ts) -- a fixed array, with no effect
		// when only one output is resolved (the 2nd name is simply
		// unused).
		outputNames: ['Result', 'Flagged'],
		// The credentials UI's "Test" button test is declarative
		// (MiravigApi.credentials.ts, `test` property), not `testedBy`
		// here -- see the comment on `test` in that file for why the two
		// mechanisms can't coexist.
		credentials: [{ name: 'miravigApi', required: false }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'mask',
				options: [
					{
						name: 'Mask',
						value: 'mask',
						description: 'Detect sensitive data and replace it with placeholders before sending text to an LLM',
						action: 'Detect sensitive data and replace it with placeholders before sending text to an LLM',
					},
					{
						name: 'Unmask',
						value: 'unmask',
						description: 'Restore original values from [TERM_G{N}] placeholders in an LLM response',
						action: 'Restore original values from [TERM_G{N}] placeholders in an LLM response',
					},
				],
			},
			// --- Mask ---------------------------------------------------
			{
				displayName: 'Text to Analyze',
				name: 'field',
				type: 'string',
				default: '={{ $json.text }}',
				required: true,
				displayOptions: { show: { operation: ['mask'] } },
				description:
					'The text to analyze before sending it to an LLM. No automatic scan of the whole incoming object -- you choose the field explicitly, to avoid noise on technical data that never reaches an LLM.',
			},
			{
				displayName: 'Attachment Field (Optional)',
				name: 'binaryPropertyName',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['mask'] } },
				description:
					'If a binary file (image, PDF...) is present on this item, Miravig flags its presence without analyzing it (no OCR in v1, see the documentation) -- to avoid a false sense of security about what is not covered. Leave empty if not applicable.',
			},
			{
				displayName: 'Behavior on Detection',
				name: 'behavior',
				type: 'options',
				default: 'passthrough',
				displayOptions: { show: { operation: ['mask'] } },
				options: [
					{
						name: 'Pass Through and Annotate',
						value: 'passthrough',
						description: 'The text continues on the main output, with detection details added to the output',
					},
					{
						name: 'Stop Execution',
						value: 'stop',
						description: 'Explicit error if a detection occurs, the workflow stops',
					},
				],
			},
			{
				displayName: 'Route Flagged Items to a Second Output',
				name: 'enableRoutingOutput',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['mask'], behavior: ['passthrough'] } },
				description:
					'Whether to send items with detections to a dedicated second output ("Flagged") instead of the main output. Disabled by default -- a single output, like most non-branching nodes, until you explicitly opt in.',
			},
			{
				displayName: 'Automatic Masking',
				name: 'maskingEnabled',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['mask'] } },
				description:
					'Whether to automatically replace detections with placeholders. Requires an active Miravig subscription (see node credentials) -- if requested without one, detection still runs and is reported, but masking itself is not applied, with an explicit message in the output. Disabled by default; when enabled, no constraint tied to Miravig\'s internal confidence level -- you remain responsible for your own activity, data and flows (see documentation).',
			},
			{
				displayName: 'Masking Scope',
				name: 'maskingScope',
				type: 'options',
				default: 'global',
				displayOptions: { show: { operation: ['mask'], maskingEnabled: [true] } },
				options: [
					{ name: 'All Categories', value: 'global' },
					{ name: 'Selected Categories', value: 'perCategory' },
				],
			},
			{
				displayName: 'Categories to Mask',
				name: 'maskingCategories',
				type: 'multiOptions',
				default: [],
				displayOptions: { show: { operation: ['mask'], maskingEnabled: [true], maskingScope: ['perCategory'] } },
				options: ALL_CATEGORIES.map((c) => ({ name: c, value: c })),
			},
			{
				displayName: 'Active Glossary Groups',
				name: 'activeGlossaryGroups',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['mask'] } },
				description:
					'Comma-separated list of groups (e.g. "General, Project Alpha") determining which terms from the Business Glossary below are active for this execution. Accepts an n8n expression ({{ }}) to drive the selection from an earlier node. Empty = no named group active (only terms without a group stay detected). Not used in Unmask mode -- placeholder resolution always considers the full glossary regardless of group.',
			},
			{
				displayName: 'On License Check Failure',
				name: 'onLicenseCheckFailure',
				type: 'options',
				// default: 'stop' -- the more protective of the two (the
				// workflow stops rather than continuing without a verifiable
				// license): a user who never touches this field gets the
				// safest behavior, not a silent degradation.
				default: 'stop',
				required: true,
				displayOptions: { show: { operation: ['mask'] } },
				description:
					'What to do if Automatic Masking or the Business Glossary are configured but Miravig cannot verify your subscription (licensing endpoint unreachable). Irrelevant if neither Automatic Masking nor a Business Glossary is configured.',
				options: [
					{
						name: 'Stop Workflow (Recommended)',
						value: 'stop',
						description: 'Explicit error, the workflow stops -- never an unverified paid feature applied silently',
					},
					{
						name: 'Continue Anyway -- At Your Own Risk',
						value: 'continue',
						description:
							'The workflow continues; the paid feature(s) are treated as NOT licensed for this run (fail-closed, same behavior as the browser extension), with an explicit warning in the output',
					},
				],
			},
			// --- Unmask ---------------------------------------------------
			{
				displayName: 'Text to Unmask',
				name: 'field',
				type: 'string',
				default: '={{ $json.miravigOutputText }}',
				required: true,
				displayOptions: { show: { operation: ['unmask'] } },
				description:
					'The text containing [TERM_G{N}] placeholders to reveal. Defaults to the output field of a Miravig node running in Mask mode earlier in the workflow.',
			},
			{
				displayName: 'Unmask?',
				name: 'unmaskEnabled',
				type: 'boolean',
				default: true,
				displayOptions: { show: { operation: ['unmask'] } },
				description:
					'Whether to unmask the text. Lets you disable unmasking via an n8n expression (e.g. based on a value from an earlier node) without a separate IF node -- if disabled, the text passes through unchanged.',
			},
			{
				displayName: 'On Unmask Failure',
				name: 'onLookupFailure',
				type: 'options',
				// default: 'stop', same reasoning as "On License Check
				// Failure" above: the more protective of the two options.
				default: 'stop',
				required: true,
				displayOptions: { show: { operation: ['unmask'] } },
				description:
					'What to do if a [TERM_G{N}] placeholder is found but its number N is not in the supplied glossary (desynchronized snapshot, term removed or reordered since masking)',
				options: [
					{
						name: 'Stop Workflow (Recommended)',
						value: 'stop',
						description: 'Explicit error, the workflow stops -- never a partially-unmasked text going unnoticed',
					},
					{
						name: 'Continue Anyway -- At Your Own Risk',
						value: 'continue',
						description: 'The workflow continues; unresolved placeholders remain as-is in the output text',
					},
				],
			},
			// --- Shared (Mask + Unmask) -----------------------------------
			{
				displayName: 'Business Glossary (JSON)',
				name: 'businessGlossary',
				type: 'json',
				default: '[]',
				// No literal JSON example here (see README for the exact,
				// complete format) -- an older version quoted the "id" key in
				// this description, which the node-param-description-miscased-id
				// lint rule flags as a term to capitalize ("ID"). The real
				// field in the code is indeed lowercase "id" (entry.id/term.id,
				// see lib/glossary-source.js and lib/core.js) -- documenting
				// "ID" here would have been misleading. Prose only, without
				// the standalone quoted word "id", to satisfy the rule
				// honestly rather than with a fix that would have introduced
				// an inaccuracy.
				description:
					'Terms to detect (Mask mode) or resolve (Unmask mode) in addition to the native categories, pasted manually -- never read from a user\'s real glossary (no network sync). Requires an active Miravig subscription in both modes (see node credentials); same JSON on both the Mask and Unmask instances of this node in a workflow. See the README ("Business Glossary (JSON)" section) for the exact format: each entry needs a "term", plus an optional stable numeric identifier (recommended whenever available, e.g. from a CSV export of the web app/extension glossary) and optional groups. "groups" is optional and Mask-mode only -- a term without a group is always active regardless of "Active Glossary Groups".',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();

		// Operation and the output toggle determine the node's SHAPE
		// (number of outputs) -- resolved once for the whole execution,
		// not per item, consistent with how `outputs` itself is only
		// evaluated once by n8n (not per item).
		const operation = this.getNodeParameter('operation', 0) as string;
		const enableRoutingOutput =
			operation === 'mask' ? (this.getNodeParameter('enableRoutingOutput', 0, false) as boolean) : false;
		const outputCount = operation === 'mask' && enableRoutingOutput ? 2 : 1;
		const outputs: INodeExecutionData[][] = Array.from({ length: outputCount }, () => []);

		// License read once per execution (not per item in a batch) --
		// same principle as the old /quota/check (Session decision from
		// 29/07/2026). Missing credential = free user, a normal case,
		// never an error: `required: false` on the credential allows it.
		const credentials = await this.getCredentials('miravigApi').catch(() => undefined);
		const licenseKey = ((credentials?.licenseKey as string) || '').trim();

		for (let i = 0; i < items.length; i++) {
			if (operation === 'unmask') {
				await executeUnmask(this, items, i, outputs[0], licenseKey);
			} else {
				await executeMask(this, items, i, outputs, licenseKey, enableRoutingOutput);
			}
		}

		return outputs;
	}
}

async function executeMask(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	i: number,
	outputs: INodeExecutionData[][],
	licenseKey: string,
	enableRoutingOutput: boolean,
): Promise<void> {
	const text = ctx.getNodeParameter('field', i) as string;
	const binaryPropertyName = ctx.getNodeParameter('binaryPropertyName', i, '') as string;
	const behavior = ctx.getNodeParameter('behavior', i) as string;
	const maskingEnabled = ctx.getNodeParameter('maskingEnabled', i) as boolean;
	const maskingScope = ctx.getNodeParameter('maskingScope', i, 'global') as string;
	const maskingCategories = ctx.getNodeParameter('maskingCategories', i, []) as string[];
	const businessGlossaryRaw = ctx.getNodeParameter('businessGlossary', i, '[]') as string;
	const activeGlossaryGroupsRaw = ctx.getNodeParameter('activeGlossaryGroups', i, '') as string;
	const onLicenseCheckFailure = ctx.getNodeParameter('onLicenseCheckFailure', i, '') as string;

	const businessGlossaryTerms = parseBusinessGlossary(ctx, businessGlossaryRaw, i);
	const activeGlossaryGroups = activeGlossaryGroupsRaw.split(',').map((g) => g.trim()).filter(Boolean);

	const gating = await resolveGating(
		ctx,
		licenseKey,
		maskingEnabled,
		businessGlossaryTerms.length > 0,
		onLicenseCheckFailure,
		i,
	);

	// A glossary that isn't applied (not licensed) is never passed to
	// analyze() -- detection of the business glossary itself is the paid
	// feature (not just its masking), see the 12/08/2026 scoping
	// discussion on the pricing model.
	const effectiveGlossaryTerms = gating.businessGlossaryApplied ? businessGlossaryTerms : [];

	const result = core.analyze(text, {
		locale: 'en',
		behavior,
		routingEnabled: enableRoutingOutput,
		masking: gating.maskingApplied
			? { enabled: true, scope: maskingScope, categories: maskingCategories }
			: { enabled: false },
		glossary: { terms: effectiveGlossaryTerms, activeGroups: activeGlossaryGroups },
	});

	const hasBinaryAttachment =
		binaryPropertyName &&
		items[i].binary &&
		Object.prototype.hasOwnProperty.call(items[i].binary, binaryPropertyName);

	// Glossary checksum always computed on the glossary AS CONFIGURED (not
	// just the one actually applied): a downstream Unmask node must be
	// able to detect a desync even in gating cases (e.g. masking was
	// refused here for lack of a license -- there is then no placeholder
	// to compare, but if the config still showed a non-empty glossary we
	// document it for consistency with the rest of the output).
	const glossaryChecksum =
		gating.maskingApplied && effectiveGlossaryTerms.length > 0
			? core.glossaryChecksum(effectiveGlossaryTerms)
			: null;

	const outputJson: IDataObject = {
		...items[i].json,
		miravigOutputText: result.outputText,
		miravig: {
			operation: 'mask',
			hasDetections: result.hasDetections,
			detections: translateDetections(result.detections),
			attachmentDetectedNotAnalyzed: Boolean(hasBinaryAttachment),
			masking: { requested: maskingEnabled, applied: gating.maskingApplied },
			businessGlossary: {
				requested: businessGlossaryTerms.length > 0,
				applied: gating.businessGlossaryApplied,
				checksum: glossaryChecksum,
			},
			license: {
				checked: gating.licenseChecked,
				valid: gating.licenseValid,
				warning: gating.licenseWarning,
			},
			...(gating.gatingMessage ? { gatingMessage: gating.gatingMessage } : {}),
		},
	};

	if (behavior === 'stop' && result.hasDetections) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Miravig detected a sensitive data item or prompt-quality issue (${result.detections
				.map((d: { category: string }) => d.category)
				.join(', ')}) -- execution stopped ("Behavior on Detection" = "Stop Execution").`,
			{ itemIndex: i },
		);
	}

	const outItem: INodeExecutionData = { json: outputJson, pairedItem: { item: i } };

	if (enableRoutingOutput && result.shouldRoute) {
		outputs[1].push(outItem);
	} else {
		outputs[0].push(outItem);
	}
}

async function executeUnmask(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	i: number,
	output: INodeExecutionData[],
	licenseKey: string,
): Promise<void> {
	const text = ctx.getNodeParameter('field', i) as string;
	const unmaskEnabled = ctx.getNodeParameter('unmaskEnabled', i) as boolean;
	const onLookupFailure = ctx.getNodeParameter('onLookupFailure', i) as string;
	const businessGlossaryRaw = ctx.getNodeParameter('businessGlossary', i, '[]') as string;

	// Same reasoning as resolveGating()'s guard above: the field now has
	// a default ('stop'), this check protects against an n8n expression
	// resolving to something else, not against an empty field.
	if (onLookupFailure !== 'stop' && onLookupFailure !== 'continue') {
		throw new NodeOperationError(
			ctx.getNode(),
			'"On Unmask Failure" must resolve to "Stop Workflow" or "Continue Anyway".',
			{ itemIndex: i },
		);
	}

	if (!unmaskEnabled) {
		output.push({
			json: { ...items[i].json, miravigUnmaskedText: text, miravig: { operation: 'unmask', applied: false } },
			pairedItem: { item: i },
		});
		return;
	}

	const businessGlossaryTerms = parseBusinessGlossary(ctx, businessGlossaryRaw, i);

	// Desync checksum (12/08/2026 scoping guard): comparison ALWAYS
	// "continue with a visible warning", never blocking -- a distinct,
	// deliberately lower severity than "onLookupFailure" above (which
	// handles a resolution failure PER placeholder, potentially blocking
	// on the user's explicit choice). The two mechanisms are orthogonal
	// and coexist: the checksum gives an early, non-blocking signal that
	// points to the likely cause if onLookupFailure ends up throwing an
	// error.
	const incomingMiravig = (items[i].json.miravig as IDataObject | undefined) || {};
	const incomingBusinessGlossary = (incomingMiravig.businessGlossary as IDataObject | undefined) || {};
	const incomingChecksum = (incomingBusinessGlossary.checksum as string | undefined) || null;
	const localChecksum = businessGlossaryTerms.length > 0 ? core.glossaryChecksum(businessGlossaryTerms) : null;
	const textHasPlaceholders = core.hasUnresolvedGlossaryPlaceholders(text);

	let checksumStatus: string;
	let checksumWarning: string | null = null;
	if (incomingChecksum && localChecksum) {
		checksumStatus = incomingChecksum === localChecksum ? 'match' : 'mismatch';
		if (checksumStatus === 'mismatch') {
			checksumWarning =
				'Business Glossary checksum mismatch: the glossary pasted here does not match the one used when this text was masked -- placeholders may resolve to the wrong term. Continuing anyway (see documentation); double-check both node instances use the exact same glossary.';
		}
	} else if (incomingChecksum && !localChecksum) {
		checksumStatus = 'missing-local-glossary';
		checksumWarning =
			'This text was masked using a Business Glossary, but no glossary is configured on this Unmask node -- any [TERM_G{N}] placeholder will remain unresolved. Continuing anyway (see documentation).';
	} else if (!incomingChecksum && localChecksum && textHasPlaceholders) {
		checksumStatus = 'missing-upstream-checksum';
		checksumWarning =
			'This text contains [TERM_G{N}] placeholders but no glossary checksum arrived with the item -- the LLM node between Mask and Unmask may not have carried the "miravig" field forward. Continuing anyway (see documentation), but synchronization could not be verified.';
	} else {
		checksumStatus = 'not-applicable';
	}

	const gating = businessGlossaryTerms.length > 0
		? await resolveGating(ctx, licenseKey, false, true, 'continue', i)
		: {
				maskingApplied: false,
				businessGlossaryApplied: false,
				licenseChecked: false,
				licenseValid: null,
				licenseWarning: null,
				gatingMessage: null,
			};

	const effectiveGlossaryTerms = gating.businessGlossaryApplied ? businessGlossaryTerms : [];
	const result = core.demasquerText(text, { terms: effectiveGlossaryTerms });

	if (result.resolved < result.total && onLookupFailure === 'stop') {
		throw new NodeOperationError(
			ctx.getNode(),
			`Incomplete unmasking: ${result.resolved} of ${result.total} placeholder(s) resolved -- at least one number is missing from the supplied glossary (desynchronized snapshot with the Miravig node that masked this text?). Execution stopped ("On Unmask Failure" = "Stop Workflow").`,
			{ itemIndex: i },
		);
	}

	output.push({
		json: {
			...items[i].json,
			miravigUnmaskedText: result.text,
			miravig: {
				operation: 'unmask',
				applied: true,
				total: result.total,
				resolved: result.resolved,
				checksum: { local: localChecksum, incoming: incomingChecksum, status: checksumStatus },
				businessGlossary: { requested: businessGlossaryTerms.length > 0, applied: gating.businessGlossaryApplied },
				...(gating.gatingMessage ? { gatingMessage: gating.gatingMessage } : {}),
				...(checksumWarning ? { warning: checksumWarning } : {}),
			},
		},
		pairedItem: { item: i },
	});
}
