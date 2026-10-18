/**
 * Version du contrat entre l'API et l'interface d'administration (source unique, lue aussi par apps/web). À
 * augmenter quand une réponse ou une entrée de l'API change d'une façon qu'une interface plus ancienne lirait mal :
 * l'interface ouverte avec un autre numéro doit alors être rechargée avant de continuer.
 */
export const API_CONTRACT = 1;

/** En-têtes des réponses /api : version du build de l'interface servie et numéro du contrat. */
export const BUILD_HEADER = "X-Kouzia-Build";
export const CONTRACT_HEADER = "X-Kouzia-Contract";
