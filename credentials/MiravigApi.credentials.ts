import type { ICredentialType, INodeProperties } from 'n8n-workflow';

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
	displayName = 'Miravig License';
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
}
