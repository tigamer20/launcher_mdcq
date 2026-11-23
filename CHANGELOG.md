# Notes de version

## v1.4.1-dev (bêta)

### Launcher
- Style spécial hiver : la neige ne dépasse plus des cartes et des boutons, et elle suit leurs coins arrondis.

## v1.4.0-dev (bêta)

### Launcher
- **Style spécial hiver** : ciel de nuit avec aurore boréale, neige qui tombe et s'accumule sur les nouvelles, le titre (en suivant la forme des lettres), le bouton JOUER et le sol.
- **Vraie physique de la neige** : la souris pousse et creuse la neige dans toutes les directions, les flocons rebondissent dessus, la neige glisse et déborde des bords.
- Bouton JOUER en glace qui craque au clic, givre dans les coins, tuques sur les joueurs en ligne.
- **Flocons dorés** : attrapes-en 5 pour débloquer la palette Aurore.
- Dans Paramètres → Style du launcher : style de base ou style spécial hiver, chaque effet activable, et la quantité de neige. La neige s'arrête pendant que le jeu tourne.

## v1.3.4-dev (bêta)

### Launcher
- Paramètres et section développeur plus épurés : les textes qui expliquaient les boutons sont retirés.

## v1.3.3-dev (bêta)

### Launcher
- **Revenir à la version publique** : sur une version bêta, la section développeur (Ctrl+Maj+D) affiche un bouton qui désactive la bêta, redémarre le launcher et réinstalle la dernière version publique.
- Le fond « Fond actuel » s'appelle maintenant **Gradient de couleur**. Quand le carrousel de photos est affiché, les couleurs du launcher sont cachées dans les Paramètres.

## v1.3.2-dev (bêta)

### Launcher
- **Joueurs en ligne** : sous « En ligne · X/Y joueurs », le launcher affiche qui est en jeu, avec sa tête Minecraft. La liste se met à jour toutes les 10 secondes (12 noms maximum, les autres sont comptés en « + N autres »).

## v1.3.1

### Launcher
- Le **carrousel de photos** est maintenant le fond par défaut. Si tu préfères l'ancien fond : Paramètres → Fond du launcher → « Fond actuel ». Ton choix est gardé.

## v1.3.0 · My sweat sweat Minecraft

### Launcher
- **Carrousel de photos** : dans Paramètres → Fond du launcher, choisis entre le fond actuel et un carrousel des photos du serveur. Les photos changent toutes les 9 secondes.
- **Proposer une photo** : envoie une de tes captures d'écran. Elle apparaît dans le carrousel une fois acceptée par un admin.

### Site admin
- Nouvel onglet **Photos** : glisser-déposer des photos, les afficher ou les cacher, changer leur ordre, les supprimer. Les photos proposées par les joueurs arrivent dans « Demandes des joueurs », à approuver ou refuser. Nouvelle permission « Photos du launcher » dans Comptes.

## v1.2.0

### Launcher
- **Live / enregistrement** : quand quelqu'un est en live ou enregistre sur le serveur, le launcher l'affiche avec une bande rouge en haut de la fenêtre (EN DIRECT ou ENREGISTREMENT) et le nom de la personne. Une fenêtre d'avertissement s'ouvre aussi, une seule fois par live, pour rappeler de faire attention à ce qu'on dit et fait en jeu. « Détails » la rouvre.

### Site admin
- Nouvelle carte **Live / enregistrement** dans le tableau de bord : type (live ou enregistrement), nom affiché, message optionnel. Elle a sa propre permission dans l'onglet Comptes. Si la console est configurée, les joueurs déjà en jeu sont aussi prévenus dans le chat.
- **Agent du serveur sans port à ouvrir** : avec `CLOUDFLARE_TUNNEL=1` et `WEBSITE_URL=...` dans `start-agent.bat`, l'agent lance lui-même un tunnel Cloudflare gratuit et envoie sa nouvelle adresse au site à chaque démarrage. Plus besoin de toucher à `AGENT_URL` sur Render.
