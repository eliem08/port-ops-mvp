# Questions ouvertes — préalables à tout pilote

Ces questions n'ont pas de réponse à ce jour. Elles doivent être tranchées
**avant** le cadrage d'un pilote supervisé. Aucune hypothèse n'a été faite
sur les systèmes, processus ou données de l'ANP ou de Marsa Maroc.

---

## A. Données

1. **Formats** — Sous quels formats les données opérationnelles sont-elles
   disponibles (exports CSV, base de données, API, fichiers applicatifs) ?
2. **Périmètre** — Quelles données peuvent être partagées pour un pilote :
   rendez-vous camions, passages au portail, affectations de quais,
   autres ? Y a-t-il des exclusions ?
3. **Volume et historique** — Quelle profondeur historique est accessible
   (semaines, mois) ? Quel volume journalier approximatif ?
4. **Fraîcheur** — Les données pilotes seront-elles un extrait figé, un
   import régulier, ou un flux temps réel ?
5. **Anonymisation** — Quelles règles s'appliquent aux données personnelles
   (plaques d'immatriculation, noms de chauffeurs) ? Qui valide
   l'anonymisation ?
6. **Qualité** — Quel est le niveau de complétude et de fiabilité attendu
   des données sources (champs manquants, doublons, horodatages incohérents) ?

## B. Opérations

7. **Exploitation quotidienne** — Qui opère le système au jour le jour
   pendant le pilote (vos équipes, l'équipe projet, mixte) ?
8. **Rôles** — Le modèle à cinq rôles (lecteur, opérateur, planificateur,
   superviseur, administrateur) correspond-il à votre organisation ? Quelles
   adaptations ?
9. **Décision humaine** — Quelles décisions doivent impérativement rester
   humaines pendant le pilote (validation des scans, approbation des plans
   de quais) ?
10. **Repli** — Si la plateforme est indisponible, quelle est la procédure
    de secours (retour au processus actuel, mode dégradé) ?
11. **Horaires** — Le pilote couvre-t-il les opérations 24/7 ou des plages
    définies ? Quel support hors heures ouvrées ?
12. **Formation** — Combien d'utilisateurs à former, avec quel niveau de
    familiarité numérique ?

## C. Juridique et gouvernance

13. **Convention de données** — Quel est le processus et le délai pour une
    convention de partage de données ?
14. **Propriété des données** — Qui possède les données générées pendant le
    pilote ? Peuvent-elles être utilisées pour améliorer les modèles ?
15. **Responsabilité** — En cas de décision erronée assistée par le système
    (scan accepté à tort, plan inapplicable), qui est responsable ?
16. **Durée et sortie** — Quelle durée pour le pilote ? Quelles conditions
    d'arrêt anticipé ? Que deviennent les données à la fin (restitution,
    suppression) ?
17. **Critères de succès** — Quels indicateurs détermineront que le pilote
    est concluant (temps d'attente, exactitude, adoption) ?

## D. Technique

18. **Hébergement** — Où le pilote doit-il être hébergé (vos
    infrastructures, cloud souverain, tiers) ? Contraintes de souveraineté
    des données ?
19. **Identités** — Quel système d'authentification doit être utilisé
    (SSO existant, annuaire, nouveau) ? Le MFA est-il exigé ?
20. **Intégrations** — Le pilote doit-il s'interfacer avec des systèmes
    existants (TOS, contrôle d'accès, vidéoprotection) ? Si oui, lesquels et
    par quels moyens techniques ?
21. **Réseau** — Contraintes réseau (zones, pare-feu, accès distants) pour
    l'accès à la plateforme ?
22. **Tailles réelles** — Quels sont les ordres de grandeur à traiter
    (navires/jour, camions/jour, quais) pour valider les solveurs ?
23. **Seuils métier** — Quels seuils de confiance et quelles règles de
    gestion s'appliquent aujourd'hui au contrôle des accès portail ?

---

*Ces 23 questions constituent l'ordre du jour minimal du premier atelier de
cadrage. Tant qu'elles sont sans réponse, le prototype reste un outil de
démonstration — ce qui est exactement son rôle actuel.*
