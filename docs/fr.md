# Roborock

Pilotez vos aspirateurs robots Roborock directement depuis Gladys Assistant.

Cette intégration s'adresse aux robots **Roborock appairés dans l'application
Xiaomi Home** (Mi Home). Elle communique avec eux **directement sur votre réseau
local**, avec un repli automatique sur le cloud Xiaomi lorsque le robot n'est pas
joignable en local.

## Fonctionnalités

Pour chaque robot de votre compte, l'intégration expose :

- **État** — l'état de fonctionnement du robot (nettoyage, en pause, retour à la
  base, en charge, à la base, erreur…).
- **Mode de fonctionnement** — démarrer ou arrêter un cycle de nettoyage.
- **Mode de nettoyage** — la puissance d'aspiration (silencieux, équilibré,
  turbo, max, doux).
- **Base** — renvoyer le robot vers sa base de charge.
- **Batterie** — le niveau de batterie actuel, en pourcentage.

## Configuration

1. Installez l'intégration.
2. Cliquez sur **« Lier le compte Xiaomi »**. L'intégration vous renvoie un lien.
3. **Ouvrez ce lien** et validez la connexion avec votre compte Xiaomi (vous
   pouvez aussi le scanner avec l'application Xiaomi Home).
4. Cliquez sur **« Vérifier la connexion »** : le nombre de robots trouvés
   s'affiche.
5. Ouvrez l'écran **Découverte** et lancez une analyse : vos robots apparaissent
   et peuvent être ajoutés à Gladys.

> Vous n'avez **jamais** à saisir votre mot de passe Xiaomi dans Gladys, et
> l'opération n'est nécessaire **qu'une seule fois** : la session est mémorisée
> et réutilisée automatiquement après un redémarrage.

Il n'y a **rien à configurer** : la région du serveur Xiaomi, vos robots, leurs
clés de chiffrement locales et leurs adresses IP sont tous découverts
automatiquement.

## Fonctionnement

L'intégration découvre vos robots via le cloud Xiaomi, avec leur clé de
chiffrement locale et leur adresse IP. Les commandes et les relevés d'état
passent ensuite en priorité par le **réseau local** (protocole miIO chiffré),
avec un repli sur le cloud si le robot n'est pas joignable. Le mode de
communication utilisé est affiché sous forme de badge sur l'appareil.

## Limites

- Les robots rattachés à un compte **Roborock** (et non Xiaomi) ne sont pas
  pris en charge.
- Les codes de puissance d'aspiration varient selon les générations de modèles.
  Si votre modèle se comporte différemment, ouvrez une issue avec la valeur
  `fan_power` visible dans les journaux de débogage.
