# Check-list de préparation — du prototype au pilote supervisé

**Objectif :** passer de la démo actuelle (données synthétiques, hébergement
local, authentification de démonstration) à un pilote supervisé sur données
réelles partielles.

**Légende des statuts :**
- ✅ **Prêt** — acquis, vérifié, rien à faire.
- 🔧 **À travailler** — à la charge de l'équipe projet (ilyass / prestataire).
- 🚫 **Bloqué (tiers)** — nécessite une décision, une donnée ou une action de
  l'institution portuaire ou d'un tiers.

---

## 1. Données

| # | Élément | Statut | Notes |
|---|---|---|---|
| D1 | Jeu de données opérationnelles (même partiel) | 🚫 Bloqué (tiers) | Journaux de rendez-vous camions, horodatages portail, plannings de quais — sous convention de partage. Sans cela, tout reste synthétique. |
| D2 | Formats et schéma des données sources | 🚫 Bloqué (tiers) | Formats inconnus à ce jour (CSV ? exports applicatifs ? API ?). À documenter avec les équipes SI du port. |
| D3 | Volume et profondeur historique | 🚫 Bloqué (tiers) | Détermine la faisabilité de la calibration du simulateur (cf. limite n° 6). |
| D4 | Exigences d'anonymisation | 🚫 Bloqué (tiers) | Quelles données personnelles (plaques, chauffeurs) doivent être masquées, et selon quelles règles. |
| D5 | Pipeline d'alimentation du pilote | 🔧 À travailler | Import batch ou connecteur ; validation des formats ; journalisation des imports. |
| D6 | Données synthétiques actuelles | ✅ Prêt | Étiquetées, isolées, remplaçables sans toucher au code métier. |

## 2. Infrastructure

| # | Élément | Statut | Notes |
|---|---|---|---|
| I1 | Hébergement du pilote | 🔧 À travailler | Le prototype tourne en local (SQLite). Cible : serveur défini avec l'institution (souveraineté des données à trancher, cf. questions ouvertes). |
| I2 | Base de données multi-utilisateur | 🔧 À travailler | Migration SQLite → PostgreSQL (ou équivalent) avec sauvegardes et restauration testée. |
| I3 | Fournisseur d'identité (SSO) | 🔧 À travailler | Remplacer l'authentification de démonstration par OIDC/SAML ; conserver le modèle à cinq rôles. |
| I4 | Gestion des secrets | 🔧 À travailler | Coffre-fort (vault) avec rotation ; aucun secret dans le code ni dans les variables d'environnement en clair. |
| I5 | Sauvegardes et plan de reprise | 🔧 À travailler | RPO/RTO à définir avec l'institution ; exercice de restauration avant le pilote. |
| I6 | Supervision / journaux | 🔧 À travailler | Centralisation des logs, alertes de disponibilité. Actuellement : logs locaux uniquement. |

## 3. Sécurité

| # | Élément | Statut | Notes |
|---|---|---|---|
| S1 | Test d'intrusion | 🔧 À travailler | À faire réaliser par un tiers avant toute exposition au-delà du cercle pilote. |
| S2 | Remplacement de l'authentification démo | 🔧 À travailler | Voir I3. L'authentification actuelle refuse déjà de démarrer en production sans secret robuste — c'est un garde-fou, pas une solution. |
| S3 | Chiffrement des données sensibles | 🔧 À travailler | Chiffrement au repos et en transit à valider selon les exigences de l'institution. |
| S4 | Revue du modèle de menaces | ✅ Prêt | `docs/SECURITY.md` : modèle documenté ; 28 tests de régression sécurité au vert. À mettre à jour après I1–I3. |
| S5 | Traçabilité (audit) | ✅ Prêt | Piste d'audit inaltérable déjà en place ; à connecter au SIEM de l'institution le cas échéant. |

## 4. Juridique et gouvernance

| # | Élément | Statut | Notes |
|---|---|---|---|
| J1 | Convention de partage de données | 🚫 Bloqué (tiers) | Périmètre, finalités, durée, anonymisation, sous-traitance. Prérequis à D1. |
| J2 | Propriété et réutilisation des données | 🚫 Bloqué (tiers) | Qui possède les données du pilote ? Peuvent-elles servir à améliorer les modèles ? |
| J3 | Responsabilité en cas de décision erronée | 🚫 Bloqué (tiers) | Ex. : un scan accepté à tort, un plan de quais inapplicable. Le pilote doit définir qui décide et qui répond. |
| J4 | Maintien de la décision humaine | 🔧 À travailler | Principe : pendant le pilote, aucune décision automatique sans validation humaine. À inscrire dans le cadrage. |
| J5 | Critères d'acceptation du pilote | 🚫 Bloqué (tiers) | Comment jugera-t-on que le pilote est un succès ? Indicateurs à co-construire. |

## 5. Opérations

| # | Élément | Statut | Notes |
|---|---|---|---|
| O1 | Équipe pilote côté institution | 🚫 Bloqué (tiers) | Opérateurs, planificateurs, superviseurs désignés ; référent métier pour les règles (seuils, statuts). |
| O2 | Formation des utilisateurs | 🔧 À travailler | Supports à produire à partir du guide de démonstration ; sessions avant le démarrage. |
| O3 | Procédures de repli (système indisponible) | 🔧 À travailler | Que font les opérateurs si la plateforme est hors ligne ? Procédure papier / système antérieur à décrire. |
| O4 | Support pendant le pilote | 🔧 À travailler | Canaux, délais de réponse, astreinte éventuelle. |
| O5 | Plan de retour en arrière | 🔧 À travailler | Conditions d'arrêt du pilote ; restitution / suppression des données. |
| O6 | Guide de démonstration (15 min) | ✅ Prêt | `docs/pilot/DEMO-SCRIPT-FR.md`, testé pas à pas. |

## 6. Technique (plateforme)

| # | Élément | Statut | Notes |
|---|---|---|---|
| T1 | Intégration des quatre modules | ✅ Prêt | 245 tests au vert ; 12 critères d'acceptation vérifiés. |
| T2 | Calibration du simulateur | 🚫 Bloqué (tiers) | Impossible sans D1/D3. Le simulateur reste illustratif jusqu'à calibration sur données observées. |
| T3 | Validation des solveurs sur tailles réelles | 🚫 Bloqué (tiers) | Benchmark des solveurs sur instances réelles (nombre de navires/quais) avant tout usage décisionnel. |
| T4 | Documentation technique | ✅ Prêt | Architecture, sécurité, limites, matrice d'intégration, récupération — voir `docs/`. |

---

## Lecture rapide

- **Prêts (9)** : tout ce qui dépend uniquement du prototype existant.
- **À travailler (14)** : chantiers d'ingénierie et d'organisation, réalisables
  une fois le cadrage posé.
- **Bloqués par un tiers (12)** : tous nécessitent des décisions ou des
  données de l'institution. **Aucun pilote ne démarre tant que D1, J1 et O1
  ne sont pas levés.**

*Dernière mise à jour : 2026-10-18 — branche `feat/mvp-slice-1`.*
