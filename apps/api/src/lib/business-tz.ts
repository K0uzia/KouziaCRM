/**
 * Fuseau de l'entreprise imposé au processus (API, worker), avant tout autre module : les bornes calendaires locales
 * (mois de l'URSSAF, livre des recettes, échéances, « aujourd'hui ») sont celles de Paris, quel que soit le fuseau de la
 * machine (un conteneur Alpine ou Docker est en UTC par défaut, et aucun TZ n'y était fixé). Importé en premier.
 */
process.env.TZ = "Europe/Paris";

export {};
