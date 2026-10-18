# Note technique — Plateforme d'intelligence des opérations portuaires (MVP de démonstration)

**Document :** note technique à l'attention des décideurs ANP / Marsa Maroc
**Statut du système :** prototype de démonstration supervisée — **données 100 % synthétiques**
**Version :** branche `feat/mvp-slice-1` (octobre 2026)
**Langue :** français

---

## 1. Objet

Ce document présente une plateforme de démonstration qui intègre, dans une
application web unique, quatre modules d'aide à la décision pour les opérations
portuaires : coordination des rendez-vous camions, vérification au portail,
planification des postes à quai et simulation des opérations.

Il ne s'agit **ni d'un système de production, ni d'une offre commerciale**.
C'est un prototype fonctionnel dont le but est de montrer la *mécanique*
d'une telle plateforme — écrans, règles métier, traçabilité — sur des données
fictives, afin qu'une institution portuaire puisse juger, en connaissance de
cause, de l'intérêt d'un pilote supervisé.

Aucune donnée réelle de l'ANP ou de Marsa Maroc n'a été utilisée, et le
document ne prétend rien sur vos systèmes, vos processus ou vos données.

## 2. Les quatre modules intégrés

| Module | Fonction | Origine du code métier |
|---|---|---|
| **TAS** (Truck Appointment System) | Création et suivi des rendez-vous camions ; machine à états à six statuts (`demandé → confirmé → enregistré → terminé`, avec `annulé` / `absent`) | `eliem08/tas-casablanca` |
| **GateWatch** | Vérification au portail : un scan (simulé) est comparé au rendez-vous enregistré ; décision automatique ou renvoi vers un opérateur humain | `eliem08/gatewatch` |
| **BerthWise** | Affectation des navires aux postes à quai : solveur exact (optimalité prouvée, ≤ 8 navires) ou heuristiques rapides, étiquetées comme telles | `eliem08/berthwise` |
| **PortTwin** | Simulateur d'opérations portuaires : scénarios, indicateurs, comparaison — **modèle non calibré, résultats illustratifs** | `eliem08/porttwin` |

Les algorithmes de ces quatre modules ont été développés et testés
séparément (245 tests automatisés au total sur la plateforme), puis intégrés
sans modification : le code métier est *recopié à l'identique* depuis les
dépôts sources, avec traçabilité des versions (voir `docs/INTEGRATION-MATRIX.md`).

## 3. Architecture, en termes simples

- **Une seule application web** (Next.js), avec un tableau de bord, une
  navigation unifiée et cinq rôles : *lecteur*, *opérateur*, *planificateur*,
  *superviseur*, *administrateur*.
- **Les contrôles d'accès sont appliqués par le serveur**, jamais seulement
  par l'interface : un utilisateur sans le bon rôle reçoit un refus, même
  s'il appelle directement l'API.
- **Base de données SQLite** : chaque rendez-vous, chaque vérification,
  chaque plan, chaque simulation et chaque action est enregistré de façon
  persistante, avec une **piste d'audit inaltérable** (qui a fait quoi, quand).
- **Frontière de confiance explicite** : lors d'un scan au portail, le serveur
  recharge le rendez-vous depuis *sa propre base* par identifiant ; les
  données envoyées par le poste client ne sont jamais prises pour argent
  comptant (ce point a fait l'objet de tests dédiés).
- **Aucun service externe** : pas de cloud, pas de file de messages, pas de
  dépendance réseau pour fonctionner en démonstration.

## 4. Ce que la démonstration prouve — et ne prouve pas

**Elle prouve :**
- que les quatre fonctions métier peuvent coexister dans un flux opérationnel
  cohérent (rendez-vous → scan → décision → planification → simulation) ;
- que les règles métier sont appliquées réellement : statuts invalides
  refusés, scans douteux renvoyés à l'humain, optimalité affichée uniquement
  quand elle est prouvée ;
- que toute action est traçable (audit) et que les indicateurs du tableau de
  bord sont calculés sur les données enregistrées, jamais codés en dur.

**Elle ne prouve pas :**
- aucune performance sur données réelles (les données sont fictives) ;
- aucune validité prédictive du simulateur (modèle non calibré) ;
- aucune aptitude à la production (authentification de démonstration,
  hébergement local, pas de test d'intrusion).

## 5. Limites documentées (résumé honnête)

Six limites sont documentées en détail dans `docs/LIMITATIONS.md`. En résumé :

1. **Données** — tout est synthétique ; aucune donnée portuaire réelle.
2. **Authentification** — maquette de démonstration (pas de mots de passe) ;
   la production exigerait votre système d'identité.
3. **Anti-fraude au portail** — *résolu par construction* : le serveur ne fait
   confiance qu'à sa base (vérifié par tests).
4. **Idempotence** — *corrigé* : les soumissions en double ne créent pas de
   doublons (contraintes base de données, vérifié par tests).
5. **Optimisation des quais** — le solveur exact prouve l'optimalité mais est
   limité à 8 navires ; au-delà, heuristiques rapides explicitement
   étiquetées « non certifiées ».
6. **Simulateur** — jamais calibré sur données réelles ; résultats
   illustratifs, pas prédictifs.

## 6. Ce qu'un pilote supervisé exigerait de votre côté

Un pilote ne peut pas démarrer sur la base du prototype seul. Voici ce qui
serait nécessaire, côté institution :

- **Données** : un jeu de données opérationnelles (même partiel et
  anonymisé) — journaux de rendez-vous camions, horodatages de passage au
  portail, plannings de quais — sous convention de partage de données, pour
  remplacer les données synthétiques et calibrer le simulateur.
- **Infrastructure** : hébergement défini par vos soins (ou validé), avec
  sauvegardes ; le prototype actuel tourne sur une base SQLite locale, ce qui
  ne convient pas à un usage multi-utilisateur réel.
- **Identités** : raccordement à votre système d'authentification
  (l'authentification de démonstration serait remplacée, seul le modèle de
  rôles serait conservé).
- **Rôles humains** : désignation d'opérateurs, planificateurs et
  superviseurs pilotes, ainsi qu'un référent métier pour valider les règles
  (seuils de confiance, statuts, quais).
- **Gouvernance** : accord sur la propriété des données, la responsabilité en
  cas de décision erronée, et les procédures de repli si le système est
  indisponible.

La liste complète figure dans `docs/pilot/PILOT-READINESS-CHECKLIST.md`, et
les questions restées sans réponse dans `docs/pilot/UNRESOLVED-QUESTIONS.md`.

## 7. Prochaines étapes proposées

1. **Démonstration de 15 minutes** (script en
   `docs/pilot/DEMO-SCRIPT-FR.md`) devant vos équipes techniques.
2. **Échange sur les questions ouvertes** — formats de données, contraintes
   d'hébergement, gouvernance.
3. Si l'intérêt est confirmé : cadrage d'un **pilote supervisé** (périmètre
   limité, données réelles partielles, décisions humaines conservées).

---

*Ce prototype a été conçu pour être jugé sévèrement : chaque limite est
écrite, chaque chiffre est traçable, chaque « optimal » est prouvé ou
étiqueté. C'est la condition d'une confiance durable si un pilote voit le
jour.*
