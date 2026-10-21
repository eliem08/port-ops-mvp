# Check-list de préparation — du prototype au pilote supervisé

**Objectif :** passer de la démo actuelle (données synthétiques, hébergement
local, authentification de démonstration) à un pilote supervisé sur données
réelles partielles.

Documents associés : `docs/pilot/PILOT-REQUIREMENTS.md` (exigences
détaillées : données anonymisées, hébergement, IdP, secrets, sauvegardes,
supervision, revue de sécurité, responsabilité humaine, critères
d'acceptation, repli) et `docs/pilot/SQLITE-ASSESSMENT.md` (pourquoi SQLite
suffit pour la démo, ses limites, chemin de migration PostgreSQL).

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
| D5 | Pipeline d'alimentation du pilote | ✅ Prêt | Import CSV des rendez-vous (`/data/import`) : validation ligne par ligne (ISO 6346, dates UTC, statuts), essai à blanc, import tout-ou-rien, ré-import sans doublon via `external_ref`, historique et audit. Le format exact des exports sources reste à confirmer (D2). |
| D6 | Données synthétiques actuelles | ✅ Prêt | Étiquetées, isolées, remplaçables sans toucher au code métier. |

## 2. Infrastructure

| # | Élément | Statut | Notes |
|---|---|---|---|
| I1 | Hébergement du pilote | ✅ Prêt (livrable) | Image Docker non-root + `docker-compose.yml` (volume persistant, HTTPS automatique via Caddy), sondes `/api/health` et `/api/ready`. Le choix du lieu d'hébergement (souveraineté) reste une décision de l'institution. |
| I2 | Base de données multi-utilisateur | 🔧 À travailler | SQLite (WAL) multi-utilisateur sur un seul nœud, avec migrations automatiques et sauvegardes vérifiées — suffisant pour un pilote mono-site. Migration PostgreSQL nécessaire seulement pour la haute disponibilité multi-nœuds (cf. `SQLITE-ASSESSMENT.md`). |
| I3 | Fournisseur d'identité (SSO) | ✅ Prêt | OpenID Connect (code + PKCE, jetons vérifiés via JWKS) avec correspondance groupes → cinq rôles ; comptes locaux avec mot de passe, verrouillage et MFA TOTP. Reste à enregistrer le client chez l'IdP de l'institution (`docs/OPERATIONS.md` §2). |
| I4 | Gestion des secrets | ✅ Prêt (côté plateforme) | Aucun secret dans le code ; secrets injectés par l'environnement / le coffre-fort de l'hébergeur ; refus de démarrer sans `AUTH_SECRET` robuste ; clé de chiffrement des données distincte (`DATA_ENCRYPTION_KEY`). La rotation dépend du coffre-fort retenu. |
| I5 | Sauvegardes et plan de reprise | ✅ Prêt (outillage) | Sauvegardes à chaud vérifiées (`integrity_check`), planifiées et à la demande, rétention, restauration vérifiée conservant l'ancienne base. RPO/RTO à fixer avec l'institution ; copie hors site et exercice de restauration à planifier. |
| I6 | Supervision / journaux | ✅ Prêt | Journaux JSON structurés, métriques Prometheus (`/api/metrics`), sonde de disponibilité, envoi de la piste d'audit vers un SIEM (webhook, au-moins-une-fois). |

## 3. Sécurité

| # | Élément | Statut | Notes |
|---|---|---|---|
| S1 | Test d'intrusion | 🔧 À travailler | À faire réaliser par un tiers avant toute exposition au-delà du cercle pilote. |
| S2 | Remplacement de l'authentification démo | ✅ Prêt | Authentification de démonstration supprimée : comptes nominatifs, MFA, SSO, sessions révocables, protection CSRF (cf. `docs/SECURITY.md`). |
| S3 | Chiffrement des données sensibles | 🔧 À travailler (partiel) | En transit : HTTPS + HSTS. Au repos : secrets MFA chiffrés (AES-256-GCM) ; chiffrement du volume de données à assurer par l'hébergeur. À valider selon les exigences de l'institution. |
| S4 | Revue du modèle de menaces | ✅ Prêt | `docs/SECURITY.md` : contrôles, responsabilités de l'exploitant et risques résiduels ; 346 tests automatisés dont les parcours d'authentification complets. |
| S5 | Traçabilité (audit) | ✅ Prêt | Piste d'audit inaltérable (connexions, échecs, verrouillages, changements de comptes et de politique, imports, exports) ; consultation filtrée, export CSV et envoi vers le SIEM de l'institution. |

## 4. Juridique et gouvernance

| # | Élément | Statut | Notes |
|---|---|---|---|
| J1 | Convention de partage de données | 🚫 Bloqué (tiers) | Périmètre, finalités, durée, anonymisation, sous-traitance. Prérequis à D1. |
| J2 | Propriété et réutilisation des données | 🚫 Bloqué (tiers) | Qui possède les données du pilote ? Peuvent-elles servir à améliorer les modèles ? |
| J3 | Responsabilité en cas de décision erronée | 🚫 Bloqué (tiers) | Ex. : un scan accepté à tort, un plan de quais inapplicable. Le pilote doit définir qui décide et qui répond. |
| J4 | Maintien de la décision humaine | ✅ Prêt | Réglage administrateur : désactiver l'acceptation automatique au portail (chaque scan validé par un superviseur) ou relever le seuil de confiance ; changements tracés. Reste à inscrire le principe dans le cadrage du pilote. |
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
| T1 | Intégration des quatre modules | ✅ Prêt | 346 tests au vert ; pont explicite rendez-vous → simulation testé de bout en bout ; parité actions/UI ↔ API REST vérifiée (cf. `docs/INTEGRATION-MATRIX.md`). |
| T2 | Calibration du simulateur | 🚫 Bloqué (tiers) | Impossible sans D1/D3. Le simulateur reste illustratif jusqu'à calibration sur données observées. |
| T3 | Validation des solveurs sur tailles réelles | 🚫 Bloqué (tiers) | Benchmark des solveurs sur instances réelles (nombre de navires/quais) avant tout usage décisionnel. |
| T4 | Documentation technique | ✅ Prêt | Architecture, sécurité, limites, matrice d'intégration, récupération — voir `docs/`. |

---

## Lecture rapide

- **Prêts (14)** : tout ce qui relève de la plateforme — intégration, identité
  (SSO/MFA), secrets, sauvegardes, supervision, import de données, audit,
  décision humaine, hébergement conteneurisé.
- **À travailler (7)** : test d'intrusion (S1), validation du chiffrement (S3),
  PostgreSQL si haute disponibilité requise (I2), et les volets organisationnels
  du pilote (formation, repli, support, retour arrière — O2 à O5).
- **Bloqués par un tiers (11)** : tous nécessitent des décisions ou des
  données de l'institution. **Aucun pilote ne démarre tant que D1, J1 et O1
  ne sont pas levés.**

*Dernière mise à jour : 2026-10-21 — branche `feat/production-readiness`.
Recomptage vérifié : 14 ✅ / 7 🔧 / 11 🚫 sur 32 éléments.*
