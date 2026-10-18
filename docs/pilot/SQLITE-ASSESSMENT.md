# SQLite — évaluation pour la démo et limites pour le pilote

**Statut :** SQLite (`node:sqlite`, fichier local) est le moteur de la démo
actuelle et du prototype durci. Ce document dit pourquoi c'est acceptable
aujourd'hui, où sont les limites, et ce que demanderait un pilote.

## Pourquoi SQLite suffit pour la démo

1. **Instance unique.** La démo tourne sur un seul processus Node
   (`next start`) avec une seule base fichier. Aucune concurrence
   inter-processus à gérer.
2. **Faible concurrence.** Charge attendue : un opérateur de démonstration,
   quelques dizaines de requêtes/minute. Les écritures critiques sont
   déjà atomiques (transactions `withTransaction` : création
   d'événements + revue + check-in ; idempotence par `INSERT OR IGNORE`).
3. **Zéro opération.** Pas de serveur à administrer, pas de mot de passe
   de base à gérer, sauvegarde = copie du fichier.
4. **Transactions ACID réelles.** SQLite garantit l'atomicité utilisée par
   le code (création d'un scan + élément de revue + check-in dans une
   seule transaction).

## Limites — à lire avant tout pilote

| Limite | Conséquence |
|---|---|
| Pas de multi-instance | Impossible de faire tourner 2 serveurs sur la même base ; pas de haute disponibilité, pas de répartition de charge. |
| Verrouillage en écriture | Un écrivain à la fois (verrou fichier). Suffisant pour la démo ; devient un goulot avec plusieurs opérateurs concurrents. |
| Permissions fichier | La sécurité repose sur les permissions du fichier `.db` — tout processus lisant le fichier lit tout. Pas de contrôle d'accès par rôle au niveau base. |
| Sauvegarde = copie à froid | Pas de sauvegarde à chaud native sans l'API backup ; une copie pendant une écriture peut être incohérente (utiliser `VACUUM INTO` ou l'API `sqlite3_backup`). |
| Mode WAL | Non activé par défaut ici (mode journal `delete`). WAL améliorerait la concurrence lecture/écriture mais impose : même volume pour le fichier `-wal`, sauvegardes incluant le WAL, et reste mono-hôte. Ne pas l'activer sans procédure de sauvegarde adaptée. |
| Pas de chiffrement natif | Le chiffrement au repos dépend du chiffrement disque (ex. LUKS) — pas de chiffrement au niveau base dans cette version. |
| Auditabilité limitée | La piste d'audit est applicative (pas de log binaire répliquable). Pour un pilote : exporter les `audit_events` vers le SIEM de l'institution. |

## Chemin de migration vers PostgreSQL (pilote) — à faire, pas fait

Ne pas implémenter pendant la démo. Le jour du pilote :

1. **Schéma** : traduire `src/lib/db/migrations.ts` (types `TEXT`→`TEXT`,
   `INTEGER`→`INTEGER`, `datetime('now')`→`now()`, `UNIQUE` inchangés ;
   ajouter les vraies contraintes FK).
2. **Accès** : remplacer `node:sqlite` par un client PG (ex. `pg` ou
   Prisma) derrière une couche `getDb()` inchangée pour le code métier ;
   transactions via `BEGIN/COMMIT` au lieu de `withTransaction`
   (même sémantique).
3. **Idempotence** : `INSERT … ON CONFLICT DO NOTHING` remplace
   `INSERT OR IGNORE`.
4. **Secrets** : chaîne de connexion dans le coffre (cf. I4), jamais en
   clair.
5. **Sauvegardes** : `pg_basebackup` / PITR, RPO/RTO définis avec
   l'institution (cf. I5), exercice de restauration avant le pilote.
6. **Tests** : la suite actuelle utilise SQLite en mémoire ; prévoir un
   conteneur PG pour les tests d'intégration du pilote.

## Recommandation

- **Démo / présentation institutionnelle** : SQLite, sans changement.
- **Pilote supervisé multi-utilisateur** : PostgreSQL, selon le chemin
  ci-dessus — c'est l'item I2 de la check-list, toujours « à travailler ».
