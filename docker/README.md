# Environnement Gladys de test (dev) pour gladys-roborock

Environnement **isolé de la production** pour développer/tester l'intégration
sans risque. Voir aussi [`docs/map-diagnostic.md`](../docs/map-diagnostic.md)
pour le diagnostic de carte, qui lui se lance **directement depuis le Mac** et
ne nécessite pas ce Docker.

## Ce que ça fournit

- Un Gladys de test (`gladys-roborock-test`), **volume dédié**, **port 1444**
  (la prod reste intouchée), `restart: unless-stopped` (survit aux reboots du
  NAS, donc **pas besoin de refaire l'association Roborock**).
- Optionnellement, le build **local** de l'intégration branché dessus
  (profil `integration`).

## Démarrer le Gladys de test

```bash
cd docker
cp .env.example .env            # ajuster TZ au besoin
docker compose -f docker-compose.dev.yml up -d gladys-test
```

Gladys de test : <http://localhost:1444> (ou `http://<ip-nas>:1444` sur le
Synology). Crée un compte local de test (distinct de la prod).

Logs :

```bash
docker compose -f docker-compose.dev.yml logs -f gladys-test
```

## Brancher le build local de l'intégration

1. Dans le Gladys de **test** (port 1444), installe l'intégration Roborock
   (store d'intégration) et récupère le **token** + le **selector** qu'il
   attribue à l'intégration.
2. Renseigne-les dans `docker/.env` (`GLADYS_INTEGRATION_TOKEN`,
   `GLADYS_INTEGRATION_SELECTOR`).
3. Lance le conteneur d'intégration (build depuis le `Dockerfile` local) :

```bash
docker compose -f docker-compose.dev.yml --profile integration up -d --build
docker compose -f docker-compose.dev.yml logs -f gladys-roborock-dev
```

## Réseau Docker sur Synology — joindre le QV35A en TCP local

> ⚠️ Point d'attention du brief. Le robot est sur le LAN. Sur le réseau
> **bridge** par défaut, le conteneur d'intégration peut ne **pas** joindre le
> robot (port TCP `58867`), ce qui forcerait silencieusement toutes les
> commandes sur le **cloud** et empêcherait de tester le transport local.

Si le transport local ne s'active jamais (toujours « cloud » dans les logs),
passe le service `gladys-roborock-dev` en **réseau host** (voir le commentaire
dans `docker-compose.dev.yml`) : il faut alors retirer `ports:` et pointer
`GLADYS_HOST_API_URL` sur l'adresse du NAS plutôt que sur le nom de service.

Le conteneur doit pouvoir :

- joindre le Gladys de test,
- joindre Internet (Roborock Cloud),
- joindre **directement** le QV35A en `58867/tcp` sur le LAN.

## Recréer / nettoyer

```bash
docker compose -f docker-compose.dev.yml down        # garde le volume (et le lien)
docker compose -f docker-compose.dev.yml down -v     # efface tout (ré-association nécessaire)
```
