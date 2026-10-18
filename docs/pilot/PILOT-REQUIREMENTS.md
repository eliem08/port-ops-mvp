# Exigences du pilote supervisé — Port Operations Intelligence Platform

**Objet :** ce document liste les exigences à satisfaire (ou à trancher
avec l'institution) avant tout pilote sur données réelles. Il ne préjuge
d'aucune affiliation : chaque section indique ce qui relève de
l'institution (tiers) et ce qui relève de l'équipe projet.

Convention : 🚫 = décision/donnée de l'institution requise · 🔧 = à la
charge de l'équipe projet.

---

## 1. Données anonymisées — spécifications (🚫 cadrage, 🔧 implémentation)

Avant D1 (jeu de données opérationnelles), la convention de partage (J1)
doit fixer :

- **Périmètre** : quelles tables / exports (journaux de rendez-vous
  camions, horodatages portail, plannings de quais), quelle profondeur
  historique, quelle fraîcheur (batch quotidien ? temps réel ?).
- **Champs personnels** : plaques d'immatriculation, noms de chauffeurs,
  transporteurs — qualifier chacun : *nécessaire*, *à pseudonymiser* ou
  *à supprimer*.
- **Règles d'anonymisation** : technique retenue (hachage salé,
  pseudonymisation réversible sous séquestre, suppression pure),
  qui détient la table de correspondance, durée de conservation.
- **Données synthétiques de substitution** : en attendant D1, le pilote
  peut démarrer sur données synthétiques étiquetées — à déclarer
  explicitement dans le cadrage, jamais présentées comme réelles.
- **Traçabilité des imports** : chaque lot importé est journalisé
  (source, date, volume, règles appliquées) — item D5.

## 2. Hébergement et résidence des données (🚫)

- **Lieu d'hébergement** : serveur désigné avec l'institution ; la
  souveraineté des données (territoire, opérateur) est tranchée dans la
  convention — voir questions ouvertes.
- **Environnements** : séparation démo / pilote (bases et secrets
  distincts) ; aucune donnée réelle sur l'environnement de démonstration.
- **Accès réseau** : liste des postes autorisés, VPN éventuel, pas
  d'exposition publique sans test d'intrusion (S1).

## 3. Intégration du fournisseur d'identité — IdP (🔧, paramètres 🚫)

- Remplacer l'authentification de démonstration par OIDC ou SAML (item I3).
- **Points d'intégration à fournir par l'institution** : URL du
  fournisseur, `client_id`, portée des groupes/attributs, mapping
  groupes → les cinq rôles applicatifs
  (`operations_viewer`, `operations_operator`, `planner`, `supervisor`,
  `administrator`).
- Conserver le modèle à cinq rôles ; la séparation des tâches
  (un superviseur ne valide pas sa propre revue) reste appliquée
  quel que soit l'IdP.
- Session : durée de vie, déconnexion, révocation — alignées sur la
  politique de l'institution.

## 4. Gestion des secrets (🔧)

- Coffre-fort (vault) avec rotation : secret de session, identifiants
  base de données, `client_secret` OIDC, clés de chiffrement.
- **Aucun secret** dans le code, dans l'historique git, ni en clair dans
  les variables d'environnement (un garde-fou refuse déjà le démarrage
  en production sans secret robuste — item S2).
- Inventaire des secrets et procédure de rotation documentés ; rotation
  testée avant le pilote.

## 5. Sauvegarde et restauration (🔧, RPO/RTO 🚫)

- **Sauvegardes** : base PostgreSQL du pilote (`pg_basebackup` / PITR),
  voir `docs/pilot/SQLITE-ASSESSMENT.md` pour le chemin de migration.
- **RPO / RTO** définis avec l'institution (item I5).
- **Exercice de restauration** complet avant le démarrage du pilote,
  compte-rendu conservé.
- Données de démonstration : sauvegardées séparément, jamais mélangées
  aux données du pilote.

## 6. Journalisation et supervision (🔧)

- Centralisation des logs applicatifs (accès, erreurs, décisions de
  revue) avec horodatage UTC et conservation définie.
- **Piste d'audit** : les `audit_events` applicatifs sont exportés vers
  le SIEM de l'institution le cas échéant (item S5).
- Alertes de disponibilité : le service répond / ne répond pas ;
  astreinte et canaux définis (item O4).
- Tableaux de bord : erreurs 5xx, temps de réponse, files de revue en
  attente.

## 7. Revue de sécurité — check-list (🔧, tiers S1)

- [ ] Test d'intrusion par un tiers, périmètre incluant l'authentification
      et les quatre modules (S1).
- [ ] Authentification de démonstration remplacée (I3, S2).
- [ ] Chiffrement en transit (TLS) et au repos validé (S3).
- [ ] Secrets en coffre-fort, rotation testée (I4).
- [ ] Modèle de menaces mis à jour après I1–I3 (S4).
- [ ] Dépendances auditées (`npm audit`, workflow CI existant).
- [ ] Aucune donnée réelle dans les journaux, les exports ou les
      sauvegardes de démonstration.
- [ ] Procédure de signalement d'incident écrite et connue de l'équipe
      pilote.

## 8. Responsabilité humaine — déclaration (🚫 cadrage juridique)

Principe non négociable pendant le pilote :

> **Aucune décision opérationnelle n'est prise par la plateforme seule.**
> Les vérifications automatiques (« auto-accept ») et les plans
> proposés sont des *recommandations* ; un opérateur humain désigné les
> valide, et c'est cette validation qui fait foi. Les seuils (ex. seuil
> de confiance 70) et les statuts sont des paramètres métier fixés avec
> le référent de l'institution (item O1), pas des constantes techniques.

- En cas de décision erronée (scan accepté à tort, plan inapplicable),
  la convention (J3) désigne qui décide et qui répond.
- Les opérateurs du pilote sont nommés (O1) et formés (O2) avant le
  démarrage.

## 9. Critères d'acceptation — modèle (🚫 co-construction, cf. J5)

À co-construire avec l'institution ; modèle minimal :

| # | Critère | Seuil proposé (à valider) | Mesure |
|---|---|---|---|
| A1 | Disponibilité du service pendant le pilote | ≥ 99 % hors maintenances planifiées | supervision |
| A2 | Scans à revue humaine traités sous 15 min ouvrées | ≥ 90 % | horodatages `review_items` |
| A3 | Zéro décision automatique sans validation humaine | 100 % | piste d'audit |
| A4 | Restauration testée avant démarrage | 1 exercice réussi | compte-rendu |
| A5 | Écart simulation / observations documenté | rapport de calibration ou « non calibré » explicite | `docs/` |
| A6 | Formation des opérateurs effectuée | 100 % des opérateurs nommés | émargement |

Le pilote est un succès si A1–A6 sont atteints **et** que l'institution
valide la poursuite par écrit. En cas d'échec : plan de retour en arrière
(O5).

## 10. Procédure de repli — système indisponible (🔧, cf. O3)

1. **Détection** : alerte de supervision → l'astreinte accuse réception
   sous 15 minutes.
2. **Bascule** : les opérateurs reprennent la procédure antérieure
   (papier / système précédent) — décrite dans le support de formation,
   pas improvisée le jour J.
3. **Communication** : l'équipe pilote est notifiée (canal défini en O4) ;
   un message d'indisponibilité est affiché si l'interface reste
   partiellement accessible.
4. **Reprise** : vérification d'intégrité de la base avant reconnexion ;
   les événements survenus pendant l'interruption sont saisis en
   rattrapage avec horodatage réel, marqués comme tels.
5. **Post-mortem** : incident documenté sous 5 jours ouvrés, piste
   d'audit vérifiée.

---

*Document de travail — aucune affiliation institutionnelle revendiquée.
Dernière mise à jour : 2026-10-19 — branche `harden/institutional-demo`.*
