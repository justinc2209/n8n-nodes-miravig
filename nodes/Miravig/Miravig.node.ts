import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestHelper,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

// La logique métier reste en JS pur, testée indépendamment de n8n (voir
// lib/core.js, lib/license-source.js et leurs suites de tests) — ce
// fichier ne fait que traduire les paramètres n8n en configuration pour
// core.analyze()/core.demasquerText(), et inversement pour la sortie.
//
// Fusion des deux anciens nodes (Miravig masquage + MiravigDemasquer) en un
// seul type avec un paramètre "Operation" -- revient sur la décision du
// 12/08/2026 documentée dans l'historique de MiravigDemasquer.node.ts (deux
// nodes séparés). Revirement assumé lors du cadrage du 12/08/2026 (suite) :
// aucun utilisateur externe du node à ce jour (jamais publié sur npm), donc
// aucune migration à gérer -- voir la discussion de cadrage pour le détail
// des raisons (conformité "un package = un service" de la vérification n8n
// notamment). Le workflow final continue de poser DEUX INSTANCES de ce
// node (une en "Mask" avant le LLM, une en "Unmask" après) -- inchangé.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./lib/core.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const license = require('./lib/license-source.js');

// URL réelle du Worker de licence (confirmée dans le dépôt le 12/08/2026 --
// même Worker que l'extension et le web app, extension-gardefou/license.js
// et Miravig V3/license.js). L'ancien endpoint /quota/check (compte +
// apiKey) est abandonné : ce système n'a aucune UI de création de compte
// côté produit et n'est appelé nulle part en dehors des tests -- voir la
// discussion de cadrage du 12/08/2026. Le node utilise désormais
// directement /license/validate, comme l'extension/web app.
const LICENSE_VALIDATE_URL = 'https://miravig-account.miravig-metrics.workers.dev/license/validate';

// Revalidation périodique plutôt qu'à chaque exécution (décision de
// cadrage du 12/08/2026) : 15 minutes, volontairement plus court que les
// 72h utilisées côté extension/web app -- un workflow n8n peut tourner sans
// supervision humaine pendant des jours, une résiliation d'abonnement doit
// se répercuter plus vite qu'un usage interactif où l'utilisateur rouvrirait
// de toute façon le panneau régulièrement.
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

// Couche de traduction français -> anglais, appliquée uniquement en sortie
// de ce node -- ne touche jamais lib/rules-source.js ni lib/glossary-source.js
// (moteur partagé bit-à-bit identique à l'extension et au web app, hors
// périmètre de cette session ; les y traduire changerait le comportement des
// deux autres produits). Découvert en testant en conditions réelles
// (12/08/2026, suite) : les libellés de detectSensitiveData() sont déjà
// correctement traduits via son paramètre `locale` (voir rules-source.js,
// fonction L(fr, en)) -- seul le libellé du glossaire métier
// (glossary-source.js, detectGlossaryMatches) est câblé en dur en français,
// sans notion de locale. Une table plutôt qu'un paramètre `locale` ajouté au
// module partagé : plus petite surface de changement, aucun risque sur les
// deux autres produits. Repli explicite sur la chaîne d'origine si jamais un
// nouveau libellé français apparaissait côté moteur partagé sans être ajouté
// ici -- jamais un texte vide ou une exception, juste pas encore traduit.
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

// Ne contient jamais la licence en clair (audit Semgrep du 21/08/2026, voir
// SESSION_LOG.md) : workflowStaticData (où ce record est persisté) est
// exporté avec le workflow, contrairement à localStorage/chrome.storage.local
// (privés, jamais partagés) côté web app/extension. licenseKeyHash est
// recalculé à la volée depuis la credential à chaque vérification, jamais lu
// depuis ce record -- voir checkLicense() plus bas.
interface LicenseCacheRecord {
	status: string;
	checkedAt: number;
	signatureHashed: string | null;
}

interface LicenseCheckResult {
	// false = aucune clé fournie, aucun appel réseau tenté (utilisateur
	// gratuit -- cas normal, pas une erreur).
	checked: boolean;
	// null = impossible à déterminer (échec réseau, choix "continuer" --
	// traité comme non-licencié par précaution, jamais comme licencié par
	// défaut : cohérent avec le comportement fail-closed déjà en place
	// côté extension, voir license.js#validate).
	valid: boolean | null;
	warning: string | null;
}

function deriveStatus(data: IDataObject): string {
	const licenseKeyMeta = data.license_key as IDataObject | undefined;
	if (licenseKeyMeta && typeof licenseKeyMeta.status === 'string') return licenseKeyMeta.status;
	return data.valid === true ? 'active' : 'inactive';
}

// Vérifie la licence auprès du Worker (ou du cache workflowStaticData s'il
// est encore frais et signé valide) -- une seule fois par exécution du
// node, jamais par élément d'un lot (même principe que l'ancien
// /quota/check, décision Session 29/07/2026). N'appelle le réseau QUE si
// une clé est configurée : un utilisateur gratuit qui ne demande ni
// masquage ni glossaire métier ne déclenche jamais cette fonction (voir
// execute()), et un utilisateur gratuit qui les demande quand même reçoit
// un message de gating explicite sans jamais avoir eu besoin d'une clé.
async function checkLicense(ctx: IExecuteFunctions, licenseKey: string): Promise<LicenseCheckResult> {
	if (!licenseKey) return { checked: false, valid: false, warning: null };

	// licenseKeyHash recalculé ICI, depuis la clé réellement configurée dans
	// la credential -- jamais lu depuis workflowStaticData. Sert à la fois de
	// clé de cache (aucun fragment de la licence en clair, même partiel, dans
	// un nom de propriété qui finit dans le JSON exporté) et de valeur
	// couverte par la signature vérifiée plus bas.
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
			// Le Worker renvoie 400/403 avec un corps JSON exploitable
			// (licence invalide/n'appartenant pas à Miravig) -- ce n'est
			// PAS un échec de vérification (le réseau fonctionne, la
			// réponse est sans ambiguïté), donc ça ne doit jamais tomber
			// dans le même bloc catch qu'une vraie panne réseau.
			ignoreHttpStatusErrors: true,
			// Découvert en testant en conditions réelles (12/08/2026, suite) :
			// sans timeout explicite, un Worker qui accepte la connexion mais
			// ne répond jamais bloque le workflow indéfiniment -- jamais
			// atteint la logique onLicenseCheckFailure. 10s : la vérification
			// n'a lieu qu'une fois toutes les LICENSE_CACHE_MS grâce au cache
			// (15 min en production), un délai occasionnel de 10s au pire
			// n'affecte donc pas la fluidité du reste. Un timeout se résout
			// en rejet de promesse comme n'importe quelle autre panne réseau
			// (DNS, connexion refusée...) -- intercepté par le même bloc
			// catch ci-dessous, aucun chemin de code séparé à maintenir.
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
		// Panne réseau réelle (Worker injoignable, DNS, timeout...) -- PAS
		// une réponse explicite du Worker (ce cas est déjà couvert par
		// `response.valid` ci-dessus, qui ne passe jamais par ce bloc catch).
		// Révision de cadrage du 12/08/2026 (suite) : le fail-closed ne doit
		// s'appliquer qu'à une réponse EXPLICITE "invalid" du Worker, pas à
		// une simple panne réseau -- une panne retombe sur le DERNIER statut
		// vérifié en cache (valid ou invalid, peu importe lequel), pas
		// systématiquement sur "non licencié". La fraîcheur (15 min) ne
		// s'applique qu'au chemin nominal ci-dessus ; ici, c'est un repli de
		// dernier recours, un cache signé même périmé reste une meilleure
		// information qu'aucune. Seule l'absence totale de cache exploitable
		// (jamais vérifié avec succès sur ce node, ou signature invalide --
		// falsifié ou corrompu) retombe sur l'ancien comportement
		// fail-closed ("valid: null"), faute de mieux.
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

// Résout le gating masquage/glossaire métier pour une exécution -- jamais
// de retour silencieux à un comportement dégradé : si l'une des deux
// fonctionnalités payantes est demandée sans licence valide, le message
// l'explique toujours dans la sortie plutôt que de simplement ne rien
// faire sans un mot.
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

	if (onLicenseCheckFailure !== 'stop' && onLicenseCheckFailure !== 'continue') {
		throw new NodeOperationError(
			ctx.getNode(),
			'"On License Check Failure" must be set explicitly (no default) before running this node with Automatic Masking or a Business Glossary configured.',
			{ itemIndex: nodeItemIndex },
		);
	}

	const result = await checkLicense(ctx, licenseKey);

	// "stop" ne coupe plus l'exécution sur N'IMPORTE quel avertissement --
	// seulement quand `valid` reste réellement indéterminé (`null`, aucun
	// cache exploitable pour se rattraper). Un repli réussi sur un cache
	// signé (voir checkLicense) porte un avertissement informatif mais
	// aboutit à une vraie valeur booléenne : le workflow continue sur cette
	// base, "stop" n'a rien à interrompre.
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
		// Une seule sortie par défaut (spec de cadrage du 12/08/2026) :
		// la 2e sortie ("Flagged") n'apparaît que si l'utilisateur active
		// explicitement "Route Flagged Items to a Second Output" en mode
		// Mask -- réduit la ressemblance avec un node de flux (IF-like) par
		// défaut, point de vigilance identifié pour la vérification n8n
		// (classification "logic/flow control", jamais tranché formellement
		// avec la documentation n8n -- à vérifier séparément avant
		// soumission, voir README).
		outputs:
			'={{$parameter["operation"] === "mask" && $parameter["enableRoutingOutput"] === true ? ["main", "main"] : ["main"]}}',
		// outputNames n'accepte pas d'expression (contrairement à `outputs`,
		// voir n8n-workflow/Interfaces.d.ts) -- tableau fixe, sans effet
		// quand une seule sortie est résolue (le 2e nom est simplement
		// inutilisé).
		outputNames: ['Result', 'Flagged'],
		credentials: [{ name: 'miravigApi', required: false, testedBy: 'miravigApiTest' }],
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
				// Déviation volontaire de la règle de lint n8n
				// node-param-default-wrong-for-options (qui veut 'stop' ou
				// 'continue' ici) : mettre un default reviendrait à laisser un
				// comportement de sécurité s'appliquer silencieusement si
				// l'utilisateur ne touche jamais ce champ, exactement ce que
				// resolveGating() est conçu pour empêcher (voir le message
				// d'erreur qu'elle lève si la valeur n'est pas explicitement
				// 'stop' ou 'continue'). Assumé : le scan officiel restera en
				// erreur sur ce point.
				default: '',
				required: true,
				displayOptions: { show: { operation: ['mask'] } },
				description:
					'What to do if Automatic Masking or the Business Glossary are configured but Miravig cannot verify your subscription (licensing endpoint unreachable). No default value -- explicit choice required, even if you never use these features on this node. Irrelevant if neither Automatic Masking nor a Business Glossary is configured.',
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
				// Déviation volontaire de node-param-default-wrong-for-options,
				// même raison que "On License Check Failure" ci-dessus : ne pas
				// laisser un défaut choisir silencieusement à la place de
				// l'utilisateur entre "stop" et "continue" ici. Assumé : le scan
				// officiel restera en erreur sur ce point.
				default: '',
				required: true,
				displayOptions: { show: { operation: ['unmask'] } },
				description:
					'What to do if a [TERM_G{N}] placeholder is found but its number N is not in the supplied glossary (desynchronized snapshot, term removed/reordered since masking...). No default value -- explicit choice required.',
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
				// Déviation volontaire de node-param-description-miscased-id : le
				// champ JSON réel est "id" en minuscules (voir entry.id/term.id
				// dans lib/glossary-source.js et lib/core.js) -- l'autofix de
				// cette règle écrirait "ID" dans l'exemple ci-dessous, ce qui
				// documenterait un nom de champ faux (JSON est sensible à la
				// casse) et casserait silencieusement la fonctionnalité pour
				// quiconque copie l'exemple littéralement. Assumé : le scan
				// officiel restera en erreur sur ce point.
				description:
					'Terms to detect (Mask mode) or resolve (Unmask mode) in addition to the native categories, pasted manually -- never read from a user\'s real glossary (no network sync). Requires an active Miravig subscription in both modes (see node credentials); same JSON on both the Mask and Unmask instances of this node in a workflow. Format: [{"term": "ProjectPhoenix2026", "id": 12, "groups": ["General", "Project Alpha"]}]. "id" is optional -- recommended (stable, order-independent) whenever available, e.g. from a CSV export of the web app/extension glossary; falls back to array position (1-based) otherwise, which only works if both node instances receive the exact same JSON in the exact same order. "groups" is optional and Mask-mode only -- a term without a group is always active regardless of "Active Glossary Groups".',
			},
		],
	};

	// Appelé par le bouton "Test" de l'UI credentials n8n (voir
	// credentials: [...] ci-dessus, testedBy: 'miravigApiTest'). La clé est
	// optionnelle par conception (MiravigApi.credentials.ts) -- un champ
	// laissé vide n'est donc jamais un échec, juste rappelé comme "usage
	// gratuit" plutôt que testé contre le Worker. Réutilise volontairement
	// le même endpoint/format que checkLicense() plus bas, sans dupliquer
	// la logique de cache ni de repli sur un statut mis en cache -- un
	// simple aller-retour réseau suffit pour ce bouton.
	methods = {
		credentialTest: {
			async miravigApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const licenseKey = (credential.data as IDataObject | undefined)?.licenseKey as
					| string
					| undefined;
				if (!licenseKey) {
					return {
						status: 'OK',
						message:
							'No license key set -- detection stays free and unlimited. Add a key here only to unlock automatic masking and the business glossary.',
					};
				}
				try {
					// this.helpers n'expose que `request` (déprécié) dans le type
					// ICredentialTestFunctions de cette version de n8n-workflow --
					// httpRequest existe bel et bien à l'exécution (IHttpRequestHelper
					// existe précisément pour ce cas, voir n8n-workflow/interfaces.d.ts),
					// le type est juste incomplet ici. Cast explicite plutôt qu'un
					// `any` généralisé, et commenté pour ne pas laisser croire à un
					// oubli si n8n-workflow corrige ce type dans une future version.
					const helpers = this.helpers as unknown as IHttpRequestHelper['helpers'];
					const response = (await helpers.httpRequest({
						method: 'POST',
						url: LICENSE_VALIDATE_URL,
						body: { licenseKey },
						json: true,
						// Le Worker renvoie 400/403 avec un corps JSON exploitable
						// pour une licence invalide -- jamais une exception, donc
						// jamais interprété comme une panne réseau (même principe
						// que ignoreHttpStatusErrors dans checkLicense()).
						ignoreHttpStatusErrors: true,
						timeout: 10000,
					})) as IDataObject;
					if (response && response.valid === true) {
						return { status: 'OK', message: 'License key verified -- subscription active.' };
					}
					return {
						status: 'Error',
						message: 'This license key was not recognized as active by the Miravig licensing service.',
					};
				} catch (error) {
					return {
						status: 'Error',
						message: `Could not reach the Miravig licensing service (${(error as Error).message}).`,
					};
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();

		// Operation et bascule de sortie déterminent la FORME du node
		// (nombre de sorties) -- résolues une fois pour l'exécution entière,
		// pas par élément, cohérent avec la façon dont `outputs` lui-même
		// n'est évalué qu'une fois par n8n (pas par item).
		const operation = this.getNodeParameter('operation', 0) as string;
		const enableRoutingOutput =
			operation === 'mask' ? (this.getNodeParameter('enableRoutingOutput', 0, false) as boolean) : false;
		const outputCount = operation === 'mask' && enableRoutingOutput ? 2 : 1;
		const outputs: INodeExecutionData[][] = Array.from({ length: outputCount }, () => []);

		// Licence lue une seule fois par exécution (pas par élément d'un
		// lot) -- même principe que l'ancien /quota/check (décision Session
		// 29/07/2026). Credential absente = utilisateur gratuit, cas normal,
		// jamais une erreur : `required: false` sur la credential le permet.
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

	// Un glossaire non appliqué (non licencié) n'est jamais transmis à
	// analyze() -- la détection elle-même du glossaire métier est la
	// fonctionnalité payante (pas seulement son masquage), voir la
	// discussion de cadrage du 12/08/2026 sur le modèle économique.
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

	// Empreinte du glossaire toujours calculée sur le glossaire TEL QUE
	// CONFIGURÉ (pas seulement celui effectivement appliqué) : un node
	// Unmask en aval doit pouvoir détecter une désynchronisation même dans
	// les cas de gating (ex. le masquage a été refusé ici faute de licence
	// -- il n'y a alors aucun placeholder à comparer, mais si la config
	// affichait quand même un glossaire nonvide on le documente pour
	// cohérence avec le reste de la sortie).
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

	if (onLookupFailure !== 'stop' && onLookupFailure !== 'continue') {
		throw new NodeOperationError(
			ctx.getNode(),
			'"On Unmask Failure" must be set explicitly (no default value) before running this node.',
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

	// Checksum désynchronisation (garde-fou de cadrage du 12/08/2026) :
	// comparaison TOUJOURS "continuer avec avertissement visible", jamais
	// bloquante -- sévérité distincte, volontairement plus faible, de
	// "onLookupFailure" ci-dessus (qui gère un échec de résolution PAR
	// placeholder, potentiellement bloquant sur choix explicite de
	// l'utilisateur). Les deux mécanismes sont orthogonaux et coexistent :
	// le checksum donne un signal précoce, non bloquant, qui pointe vers la
	// cause probable si onLookupFailure finit par déclencher une erreur.
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
