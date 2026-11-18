# Notes de version

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
