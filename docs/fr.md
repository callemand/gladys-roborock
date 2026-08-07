# Roborock

Pilotez les aspirateurs robots de votre compte Roborock depuis Gladys Assistant.

Cette intégration s'adresse aux robots **appairés dans l'application Roborock**.
Elle communique avec eux **directement sur votre réseau local**, avec un repli
automatique sur le cloud Roborock lorsque le robot n'est pas joignable.

> Si votre robot est appairé dans l'**application Xiaomi Home** (Mi Home), il
> répond sur un tout autre service : c'est l'intégration **Xiaomi Home** qu'il vous
> faut. Les deux peuvent être installées en même temps si vous utilisez les deux
> applications.

## Fonctionnalités

Pour chaque robot de votre compte :

- **État** — l'état de fonctionnement du robot (nettoyage, en pause, retour à la
  base, en charge, à la base, erreur…).
- **Mode de fonctionnement** — démarrer ou arrêter un cycle de nettoyage.
- **Mode de nettoyage** — la puissance d'aspiration (silencieux, équilibré,
  turbo, max, doux).
- **Base** — renvoyer le robot vers sa base de charge.
- **Batterie** — le niveau de batterie actuel, en pourcentage.

## Configuration

Deux étapes, dans la boîte **Actions** :

1. Saisissez l'**e-mail de votre compte Roborock** et cliquez sur **M'envoyer un
   code par e-mail**. L'adresse est vérifiée avant tout envoi : une faute de
   frappe est signalée tout de suite, sans vous laisser attendre un e-mail.
2. Saisissez le **code reçu** et cliquez sur **Lier le compte avec ce code**.

L'action **Délier le compte** oublie la session. Un code ne sert qu'une fois et
expire vite : si le vôtre est refusé, redemandez-en un.

Ouvrez ensuite l'écran **Découverte** et lancez une analyse : vos robots
apparaissent et peuvent être ajoutés à Gladys.

> **Aucun mot de passe n'est demandé**, et c'est volontaire : beaucoup de comptes
> Roborock n'en ont aucun (inscription par code, ou via Google/Apple), et ceux qui
> en ont peuvent être protégés par une validation en deux étapes — le mot de passe
> est alors accepté puis refusé faute de second facteur. Le code couvre tous les
> cas.

Il n'y a **rien d'autre** à configurer : la région, vos robots, leurs clés de
chiffrement locales et leurs adresses IP sont tous découverts automatiquement.

## Fonctionnement

L'intégration découvre vos robots via le cloud Roborock, avec leur clé de
chiffrement locale et leur adresse IP. Les commandes et les relevés d'état passent
ensuite en priorité par le **réseau local** (TCP), avec un repli sur le cloud
(MQTT) si le robot n'est pas joignable. Le mode de communication utilisé est
affiché sous forme de badge sur l'appareil.

## Limites

- La **couche appareils** (transports MQTT et TCP local, commandes) n'a jamais été
  confrontée à un vrai robot sur un compte Roborock. L'authentification, elle, est
  vérifiée de bout en bout contre le vrai cloud. Si vous êtes dans ce cas, vos
  retours et vos journaux de débogage sont très utiles.
- Seule la famille de protocole Roborock « 1.0 » est prise en charge. Les gammes
  récentes utilisant un autre chiffrement (Dyad, Zeo) ne sont pas couvertes.
- Les codes de puissance d'aspiration varient selon les générations de modèles.
  Si votre modèle se comporte différemment, ouvrez une issue avec la valeur
  `fan_power` visible dans les journaux de débogage.
