# Diagnostic de récupération de carte (milestone 1)

> Objectif de cette étape : **prouver** que la carte du QV35A (`roborock.vacuum.a168`)
> est récupérable et **identifier son format brut**. Pas encore de renderer.

## Comment la carte revient réellement

Contrairement à `get_status`, la carte **n'est pas** dans la réponse RPC (102).
`get_map_v1` répond 102 par un simple accusé ; la carte est **poussée dans une
trame séparée protocole 301**, sur le même canal (TCP local ou MQTT cloud).

Il faut envoyer un objet **`security`** dans la commande, et la trame 301 est
encapsulée en **4 couches** :

| Couche | Contenu                                                                  | Traitée par                  |
| ------ | ------------------------------------------------------------------------ | ---------------------------- |
| 1      | AES‑128‑ECB par message (clé = timestamp + localKey + sel)               | `decodeMessage()` (existant) |
| 2      | En‑tête 24 octets : `endpoint(8)                                         | 8                            | request_id(uint16 LE) | 6`  | `decodeMapFrame()` |
| 3      | AES‑128‑CBC (clé = `nonce` envoyé dans `security`, IV = 16 zéros, PKCS7) | `decodeMapFrame()`           |
| 4      | gzip → blob **RRMap** (commence par `rr`)                                | `decodeMapFrame()`           |

- `endpoint = base64(md5(rriot.k)[8:14])` (8 car., par compte).
- `nonce = 16 octets aléatoires` (par requête).

Algorithme porté depuis python‑roborock (Apache‑2.0, même licence que ce repo) —
réimplémenté, pas copié. Voir [`src/roborock/map.js`](../src/roborock/map.js).

## Lancer le diagnostic (depuis une machine sur le même LAN que le robot)

Le script fait son **propre login isolé** (il ne touche pas à la prod) et met la
session en cache dans `./.mapdiag/` (gitignored) pour les runs suivants.

```bash
# 1) demander un code par e-mail
node scripts/mapDiag.js request --email vous@exemple.fr

# 2) lier avec le code reçu (met la session en cache)
node scripts/mapDiag.js login --email vous@exemple.fr --code 123456

# 3) lister les robots
node scripts/mapDiag.js devices

# 4) récupérer + diagnostiquer la carte
node scripts/mapDiag.js map            # ou --duid <duid> --timeout 15000
```

Le script affiche, **sans jamais logguer de secret** (token, localKey, rriot,
nonce) :

- le transport utilisé (local vs cloud) ;
- l'accusé RPC 102 ;
- pour chaque couche : type JS, Buffer ?, taille, magic bytes (`1f 8b` gzip,
  `rr` RRMap), et un hex‑dump du début ;

et sauvegarde les payloads bruts de chaque couche sous `./.mapdiag/` pour
analyse commune ensuite.

## Représentation structurée (milestone 2)

Le blob RRMap est transformé en objet exploitable par
[`src/roborock/mapParser.js`](../src/roborock/mapParser.js)
(`parseRRMap(buffer)`), et exposé via l'API cible du client :

```js
const map = await client.getMap(duid);
// { version, image{width,height,top,left,segmentCountDeclared,segmentCountInPixels,segments[]},
//   robot{x,y,angle}, charger{x,y,angle}, path{points[]}, noGoAreas[], virtualWalls[], ... }
```

Coordonnées en **millimètres** natifs ; grille image à `PIXEL_SIZE_MM` (50 mm/px).

Pour voir/sauver la structure depuis le diagnostic :

```bash
node scripts/mapDiag.js map --json      # affiche un résumé + écrit .mapdiag/*.map.json
```

Inspecteur bas niveau des blocs (lecture seule) :

```bash
node scripts/mapInspect.js .mapdiag/<fichier>.rrmap.bin
```

Validé sur le QV35A : IMAGE (9 déclarés / 8 en pixels), robot, dock, PATH (708
points), 4 zones interdites, 6 murs virtuels.

### Réconciliation segments ↔ pièces

`client.getMap(duid)` rattache le nom de pièce à chaque segment en réutilisant
`get_room_mapping` (via `attachRoomNames`). Sur le QV35A : 7 segments nommés
(Cuisine, Chambre principale, Salle d'eau, Dressing, Salle à manger, WC, Salon)
et 1 segment non nommé (`named: false`). Les ids pixels et ceux de
`get_room_mapping` partagent le même espace.

### Rendu PNG + widget Gladys (milestone 3)

[`src/roborock/mapRender.js`](../src/roborock/mapRender.js) encode un PNG
(sans dépendance native, via `node:zlib`) : sol colorié par pièce, murs, trajet,
zones interdites, murs virtuels, dock et robot.

- `client.getMapImage(duid)` → chaîne `image/png;base64,...` bornée à 150 KB
  (la limite caméra de Gladys ; l'échelle est réduite si besoin).
- L'intégration publie un **device caméra** `ext:<selector>:camera:<duid>`
  (« <nom> - Carte ») ; `index.js` répond à `onGetImage` en rendant la carte à
  la demande. Côté Gladys : ajouter une box **Caméra** sur le tableau de bord
  pointant sur ce device.

Prévisualiser le rendu hors Gladys :

```bash
node scripts/mapDiag.js render               # live depuis le robot
node scripts/mapDiag.js render --file .mapdiag/<x>.rrmap.bin --scale 3
```
