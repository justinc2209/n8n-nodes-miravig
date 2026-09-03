import type { Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

// Réutilise le mécanisme de licence de l'extension/web app (license.js) --
// PAS le système compte + apiKey de account.worker.js (accounts,
// /account/create, /quota/check), qui n'a aucune UI de création côté
// produit et n'est appelé nulle part en dehors des tests (vérifié dans le
// dépôt le 12/08/2026, voir la conversation de cadrage). Décision : le node
// n8n colle directement une clé de licence Lemon Squeezy, comme
// l'extension et le web app, plutôt que d'exiger la construction d'un
// nouveau parcours "créer un compte Miravig" avant tout lancement.
//
// Optionnelle : un utilisateur gratuit n'a besoin d'aucune credential --
// la détection reste complète et gratuite sans clé. Seuls le masquage
// automatique et le glossaire métier vérifient cette clé avant de
// s'appliquer (voir Miravig.node.ts).
export class MiravigApi implements ICredentialType {
	name = 'miravigApi';
	displayName = 'Miravig License API';
	// Même icône que le node (nodes/Miravig/miravig.svg) -- un seul fichier
	// source, jamais dupliqué, référencé en relatif depuis credentials/.
	icon: Icon = 'file:../nodes/Miravig/miravig.svg';
	documentationUrl = 'https://www.miravig.com/docs/n8n';
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

	// Déclaratif plutôt que methods.credentialTest sur le node : n8n donne
	// priorité absolue à cette propriété dès qu'elle existe --
	// CredentialsTester.getCredentialTestFunction() (n8n-io/n8n,
	// packages/cli/src/services/credentials-tester.service.ts) retourne dès
	// que `type.test` est défini, sans même regarder `testedBy` sur le node
	// (vérifié directement dans ce fichier, pas supposé). Les deux
	// mécanismes ne peuvent donc pas coexister -- un seul gagne, jamais un
	// filet de sécurité en plus de l'autre.
	//
	// /license/validate renvoie toujours 200 pour ce endpoint (jamais
	// 400/403 sur une clé absente -- voir account.worker.js#handleValidate,
	// corrigé le 03/09/2026 spécifiquement pour ce test) : clé vide ->
	// { tier: 'free' } (pas de champ `valid` -- ni succès ni échec à
	// signaler), clé invalide/expirée -> { valid: false, ... } (relayé par
	// Lemon Squeezy), clé valide -> { valid: true, ... }. La règle
	// ci-dessous ne signale une erreur QUE si `valid` vaut explicitement
	// false ; { tier: 'free' } n'a pas ce champ donc ne la déclenche jamais.
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
