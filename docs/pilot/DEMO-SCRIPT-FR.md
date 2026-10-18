# Script de démonstration — 15 minutes devant des responsables portuaires

**Public :** responsables techniques et opérationnels (ANP / Marsa Maroc).
**Durée :** 15 minutes, questions incluses dans le temps de chaque section.
**Règle d'or :** annoncez ce qui est simulé *avant* de le montrer. Les phrases
d'honnêteté ci-dessous sont à utiliser telles quelles — elles font partie de
la démo.

> Tout ce qui apparaît à l'écran est une **donnée synthétique de
> démonstration**. Le bandeau `DEMO — SYNTHETIC DATA` est visible en
> permanence : montrez-le dès la première minute.

---

## Préparation (avant la réunion)

```bash
npm install
npm run db:migrate   # crée le schéma
npm run db:seed      # charge les données synthétiques + 5 utilisateurs démo
npm run dev          # http://localhost:3000
```

**Vérifications :**
- La page de connexion affiche les cinq identités démo.
- Le tableau de bord affiche des chiffres (données chargées).
- Ouvrez un **second onglet** sur le tableau de bord, déjà connecté : c'est
  votre roue de secours si un écran se fige en direct.
- Coupez les notifications ; passez en plein écran.

---

## 1. Connexion et rôles (2 min)

Connectez-vous avec **Omar (Opérateur)** pour le fil principal.

Dites : *« La plateforme a cinq rôles : lecteur, opérateur, planificateur,
superviseur, administrateur. »* Basculez 10 secondes sur **Yasmine (Lectrice)**
pour montrer que les boutons d'action restent visibles mais que le serveur
refuse les actions non autorisées — puis revenez sur Omar.

**Phrase d'honnêteté (limite n° 2) :**
*« Ce login est une maquette de démonstration — il n'y a pas de mots de
passe. En production, le système utiliserait votre propre système
d'identité ; seul le modèle de rôles serait conservé. »*

## 2. Cycle de vie d'un rendez-vous — TAS (3 min)

1. Allez sur **`/appointments`** : vingt rendez-vous synthétiques, tous
   statuts mélangés (`demandé`, `confirmé`, `enregistré`, `terminé`,
   `annulé`, `absent`).
2. Cliquez **Nouveau rendez-vous** : créez-en un — plaque `CAS-2026-X`,
   conteneur `TCLU2026601`, horaire dans ~2 h. Montrez la validation
   (format UTC imposé, champs contrôlés).
3. Ouvrez la fiche, cliquez **Marquer confirmé** (transition
   `demandé → confirmé`).
4. Soumettez deux fois de suite : montrez qu'il n'y a pas de doublon.

**Phrases d'honnêteté :**
- (limite n° 1) *« Chaque enregistrement ici est généré pour la démo —
  plaques, conteneurs, horaires. Il n'y a aucune donnée portuaire réelle
  dans ce système. »*
- (limite n° 4) *« Les nouvelles tentatives sont sans risque : la base de
  données impose l'idempotence, donc une soumission en double ne peut pas
  créer un rendez-vous en double. »*

## 3. Scan au portail — GateWatch (3 min, SIMULÉ)

1. Allez sur **`/gate`**, sélectionnez le rendez-vous confirmé.
2. Soumettez un scan avec plaque et conteneur **exactement identiques** et
   confiance 90 → **acceptation automatique** ; le rendez-vous passe à
   `enregistré`.
3. Soumettez à nouveau avec un conteneur erroné, ou confiance 30 →
   **revue humaine** ; lisez à voix haute le motif affiché.
4. Allez sur **`/gate/reviews`**, connectez-vous en **Karim
   (Superviseur)** : approuvez un élément, rejetez-en un autre. Montrez que
   chaque décision enregistre qui et quand (piste d'audit).

**Phrases d'honnêteté :**
- *« Ceci est un scan simulé — personne ne photographie un vrai camion. La
  logique de vérification, elle, est réelle : une lecture qui ne correspond
  pas, ou une confiance faible ou absente, n'est jamais acceptée
  automatiquement — elle passe par un humain. »*
- (limite n° 3) *« Le scan ne peut pas faire passer un faux rendez-vous :
  le serveur recharge le rendez-vous depuis sa propre base par identifiant
  et ignore tout ce que le poste client envoie à son sujet. »*

## 4. Planification des quais — BerthWise (3 min)

1. Connectez-vous en **Salma (Planificatrice)**, allez sur **`/planning`** →
   nouveau plan.
2. Prenez un petit scénario (≤ 8 navires), solveur **exact** : la page de
   résultat affiche le plan avec l'indicateur **« optimalité prouvée »**.
3. Relancez le même scénario en **recuit simulé** : montrez le bandeau —
   résultat heuristique, qualité non certifiée.

**Phrase d'honnêteté (limite n° 5) :**
*« Le solveur exact prouve l'optimalité mais ne traite que 8 navires au
maximum ; les solveurs rapides sont des heuristiques et l'écran les étiquette
explicitement comme non certifiées. Le solveur lourd de recherche est
volontairement exclu de la démo interactive. »*

*(Optionnel, si le temps le permet : 9 navires ou plus en solveur exact —
le système bascule proprement sur une heuristique avec un motif explicite,
plutôt que d'échouer.)*

## 5. Simulation — PortTwin (2 min, NON CALIBRÉ)

1. **`/simulate`** → lancez un scénario prédéfini (graine 42, 100
   réplications).
2. Page de résultat : chaque indicateur est étiqueté **simulé** ou
   **supposé** — jamais « mesuré ».
3. **`/simulate/compare`** : deux scénarios côte à côte.

**Phrase d'honnêteté (limite n° 6) :**
*« Ce simulateur n'a jamais vu de données portuaires réelles : les chiffres
illustrent la mécanique du modèle, pas le port. Avant toute utilisation
décisionnelle, il devra être calibré sur des opérations observées. »*

## 6. Tableau de bord et audit (1 min)

1. **`/`** : les indicateurs sont calculés sur la base de démonstration —
   vos créations et scans de la démo ont fait bouger les chiffres en direct.
2. Concluez sur l'audit : *« Chaque action de cette démo — connexion,
   création, transition, scan, décision de revue, plan, simulation — est
   enregistrée dans un journal d'audit inaltérable. »*

## 7. Phrase de clôture (30 s)

*« Ceci est un prototype fonctionnel de la mécanique d'une plateforme —
rendez-vous, vérification, planification, simulation, audit — sur données
synthétiques. Les six limites documentées que je vous ai énoncées
constituent la feuille de route vers un système de production, et la
première étape serait un pilote supervisé sur vos données, avec décisions
humaines conservées. »*

---

## Questions anticipées

| Question probable | Réponse |
|---|---|
| « Les données sont-elles réelles ? » | Non — 100 % synthétiques, le bandeau l'indique en permanence. Des données réelles exigeraient une convention de partage (cf. note technique §6). |
| « Peut-on brancher nos données ? » | Oui, c'est l'étape n° 1 d'un pilote : formats à documenter avec vos équipes, import validé, puis remplacement des données synthétiques. |
| « Le système peut-il remplacer notre processus actuel ? » | Non — c'est une démo supervisée, pas un système de production. Pendant un pilote, toute décision resterait validée par un humain. |
| « L'optimiseur est-il vraiment optimal ? » | Seulement le solveur exact, jusqu'à 8 navires, avec preuve. Tout le reste est heuristique et étiqueté comme tel — l'écran ne triche jamais. |
| « Le simulateur prédit-il le trafic ? » | Non. Non calibré = illustratif. La calibration sur données observées est un prérequis explicite. |
| « Où sont hébergées les données ? » | Aujourd'hui : base locale de démonstration. L'hébergement du pilote (souveraineté incluse) est une question ouverte à trancher avec vous. |
| « Qui voit quoi ? » | Cinq rôles, appliqués par le serveur. Je peux vous montrer un refus en direct avec le rôle lecteur. |
| « Et si le système tombe en panne ? » | Excellente question — les procédures de repli font partie du cadrage du pilote (question ouverte n° 10). |
| « Combien ça coûte / quel délai pour un pilote ? » | Le cadrage (données, hébergement, gouvernance) doit précéder tout chiffrage sérieux. Je ne veux pas inventer de chiffres. |

## Si quelque chose échoue en direct

Restez calme : un incident géré avec transparence renforce la crédibilité.

| Incident | Repli |
|---|---|
| Port déjà utilisé / serveur ne démarre pas | `npx kill-port 3000` ou changez de port ; la démo n'en dépend pas. |
| Page blanche ou erreur | Rechargez ; vérifiez la console. Basculez sur l'onglet de secours (tableau de bord pré-chargé). |
| Base verrouillée / données incohérentes | `npm run db:reset && npm run db:seed` — 30 secondes, tout est reproductible. |
| Le scan ne répond pas | Vérifiez le rôle (il faut Omar/opérateur) ; reconnectez-vous. |
| Rien ne fonctionne | Basculez en mode récit : décrivez le flux en vous appuyant sur la note technique (§2–§4). Ne jamais improviser des chiffres. |

**Règle :** on ne masque jamais un échec — on l'explique. Le prototype est
présenté comme un prototype.

---

## Aide-mémoire timing

| # | Section | Min |
|---|---|---|
| 1 | Connexion et rôles | 2 |
| 2 | Rendez-vous | 3 |
| 3 | Scan au portail (simulé) | 3 |
| 4 | Planification (optimal vs heuristique) | 3 |
| 5 | Simulation (non calibrée) | 2 |
| 6 | Tableau de bord et audit | 1 |
| 7 | Clôture | 0,5 |
| | **Total** | **~15** |

Si le temps manque : coupez d'abord la comparaison de scénarios (§5), puis
la bascule 9-navires (§4). **Ne coupez jamais les phrases d'honnêteté —
elles sont la démo.**
