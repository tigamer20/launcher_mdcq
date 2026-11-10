# All the Mod · Saison 3 — Kit graphique et personnalisation du modpack

## 1. Où mettre chaque image

### CurseForge (`curseforge/`)
| Fichier | Où |
|---|---|
| `logo-curseforge-400.png` | Logo du projet (carré, 400×400 minimum) |
| `logo-curseforge-1024.png` | Même logo en haute résolution, si CurseForge en demande un plus grand |
| `banniere-description-1200x400.png` | En haut de la description du projet |
| `section-*-1200x120.png` | Titres de sections dans la description (À propos, Fonctionnalités, Installation, Rejoindre, Discord, Changements) |

Dans l'éditeur de description CurseForge : **Insérer une image**, puis téléverse le fichier. Voir le modèle de description en section 4.

### YouTube (`youtube/`)
| Fichier | Où |
|---|---|
| `banniere-chaine-2560x1440.png` | **Personnaliser la chaîne → Branding → Image de bannière**. Le texte reste dans la zone centrale visible partout. |
| `photo-profil-800.png` | **Branding → Photo** |
| `filigrane-150.png` | **Branding → Filigrane de la vidéo** (transparent) |
| `miniature-episode-1280x720.png`, `miniature-bande-annonce-1280x720.png` | Miniatures prêtes à l'emploi |
| `miniature-fond-vide-1280x720.png` | Fond vide pour faire tes propres miniatures (Canva, Photopea…) |
| `ecran-de-fin-1920x1080.png` | Fin de vidéo : place les éléments d'écran de fin de YouTube sur les cadres pointillés (vidéo à gauche, bouton S'abonner sur le logo) |

### Discord (`discord/`)
| Fichier | Où |
|---|---|
| `icone-serveur-512.png` | **Paramètres du serveur → Profil du serveur → Icône** |
| `banniere-serveur-960x540.png` | **Profil du serveur → Bannière** (niveau de boost 2) |
| `fond-invitation-1920x1080.png` | **Fond d'écran d'invitation** (niveau de boost 1) |
| `avatar-bot-512.png` | Avatar des bots et des webhooks (ex. : annonces de mises à jour) |
| `en-tete-*-1100x300.png` | Première image des salons #bienvenue, #règles, #annonces, #mises-à-jour, #maintenance, #launcher |
| `emojis/*.png` | **Paramètres du serveur → Emoji → Téléverser** (le nom du fichier sans `-128` = nom de l'emoji : `:atm_logo:`, `:atm_s3:`…) |
| `icones-roles/*.png` | **Rôles → icône du rôle** (niveau de boost 2) : admin, modérateur, joueur, VIP |

### Dans le jeu (`jeu/`)
| Fichier | Où |
|---|---|
| `logo-menu-principal-1024x256.png` | Logo du menu principal (voir 2.3) |
| `server-icon.png` | Icône dans la liste des serveurs Minecraft (voir 2.5) |
| `icone-instance-256.png` | Image du profil dans l'app CurseForge (voir 2.2) |
| `pack.png` | Icône d'un resource pack, si le modpack en a un |

### Couleurs et police
- Violet : `#8B5CF6` (principal), `#6D28D9`, `#3B0764` (foncé)
- Or : `#FBBF24` (principal), `#F59E0B`, `#FDE68A` (clair)
- Fond : `#0F1117`
- Couleur des messages embed Discord : `#8B5CF6` (en décimal pour les webhooks : `9133302`)
- Police des titres : **Inter Display Black**, en majuscules (gratuite sur Google Fonts). Texte : **Inter**.

---

## 2. Personnaliser ton modpack dupliqué (à partir d'All the Mods 10)

Fais tout ça dans **l'instance client** sur le Mac. C'est aussi le dossier `MODPACK_DIR` de l'agent, d'où le modpack est publié pour les joueurs.

### 2.1 Dupliquer le modpack
1. Dans l'app **CurseForge**, va dans **Mes modpacks** et ouvre le menu **⋮** du profil *All the Mods 10*.
2. Si l'option **Dupliquer** n'existe pas, utilise **Exporter le profil**, puis **Créer un profil personnalisé → Importer** avec le fichier exporté.
3. Vérifie que la copie démarre bien avant de la modifier.

### 2.2 Nom et image du profil
1. Ouvre le menu **⋮** de la copie et choisis **Modifier le profil** (« Profile options »).
2. **Nom :** `All the Mod · Saison 3`
3. **Image :** `jeu/icone-instance-256.png`
4. Dans **⋮ → Ouvrir le dossier**, note le chemin du dossier, puis mets-le dans `MODPACK_DIR` (dans `start-agent.command`) et redémarre l'agent.

### 2.3 Logo du menu principal
All the Mods personnalise son menu principal avec un mod de menu, souvent **FancyMenu**.
1. **Si le dossier `config/fancymenu/` existe :**
   1. Copie `logo-menu-principal-1024x256.png` dans `config/fancymenu/assets/`.
   2. Lance le jeu. Sur l'écran titre, ouvre l'éditeur FancyMenu (bouton **Customization** en haut de l'écran, ou **Ctrl+Alt+C**) puis **Modifier la disposition actuelle**.
   3. Clique sur l'image du logo d'All the Mods, choisis **Image → Choisir**, puis sélectionne ton logo. Ajuste la taille et enregistre.
2. **Sinon :** cherche le logo actuel (étape 2.4) et remplace l'image par la tienne, avec **le même nom de fichier**.

### 2.4 Remplacer les textes « All the Mods » (titre de la fenêtre, menus, messages)
Cherche tous les fichiers qui contiennent le nom d'origine. Dans le Terminal, depuis le dossier de l'instance :
```bash
cd "chemin/vers/l'instance"
grep -ril "all the mods" config defaultconfigs kubejs
```
Ou, dans le Finder : recherche `All the Mods` dans le dossier, avec le critère **Contenu**.

Ouvre chaque fichier trouvé avec TextEdit (**Format → Convertir au format texte**) et remplace le nom par `All the Mod · Saison 3`. Sert surtout pour :
- le **titre de la fenêtre** du jeu (un mod de titre de fenêtre, dans `config/`) ;
- les **textes du menu**, si le pack en a dans `config/` ;
- les **messages** de `kubejs/` (message de bienvenue, etc.).

Ne change pas les noms de **mods** ou d'**objets**, seulement les textes affichés.

### 2.5 Les quêtes (FTB Quests)
1. Connecte-toi au serveur en tant qu'opérateur.
2. Ouvre le livre de quêtes et active le mode édition (`/ftbquests editing_mode`, ou le crayon dans le livre).
3. Modifie le chapitre d'accueil : titre, texte, image.

Les quêtes sont enregistrées dans `config/ftbquests/quests/`. Copie ce dossier du **serveur** vers l'instance client pour que tout le monde ait la même version.

### 2.6 Le serveur
Dans le dossier du **serveur** (onglet **Fichiers du serveur** du site admin, ou sur le Mac) :
1. Mets `jeu/server-icon.png` à la racine du serveur. Le fichier doit s'appeler exactement `server-icon.png`.
2. Dans `server.properties`, change la description affichée dans la liste des serveurs :
   ```properties
   motd=§6§lAll the Mod §r§5· Saison 3 §7— Serveur québécois
   ```
   (`§6` = or, `§5` = violet, `§l` = gras)
3. Redémarre le serveur.

### 2.7 Tester, puis publier
1. Lance la copie dans CurseForge : menu, logo, titre, quêtes. Rejoins le serveur.
2. Sur le site admin, onglet **Modpack** : nouvelle version (ex. `1.0.1`), NeoForge de l'instance, puis **Publier depuis le Mac**.
3. Les joueurs reçoivent seulement les fichiers modifiés au prochain clic sur **JOUER**.

---

## 3. À savoir avant de publier ailleurs
- **CurseForge :** All the Mods 10 appartient à l'équipe ATM, et beaucoup de mods ont leur propre licence. Avant de **téléverser ta version modifiée sur CurseForge** comme un nouveau modpack, vérifie la licence d'ATM10 et, au besoin, demande la permission à l'équipe ATM (leur Discord). Le launcher, lui, n'a pas besoin de CurseForge.
- **Le nom** « All the Mod » est très proche d'« All the Mods ». Écris toujours *« basé sur All the Mods 10 par l'équipe ATM »* dans tes descriptions, pour que ce soit clair que ce n'est pas le pack officiel.
- **Les images** de ce kit sont originales : aucun logo officiel ni texture de Minecraft. Tu peux les modifier librement.

---

## 4. Modèle de description CurseForge
```
[image : banniere-description-1200x400.png]

[image : section-a-propos-1200x120.png]
ATM (All the Mod), c'est la saison 3 de notre serveur québécois : un modpack basé sur
All the Mods 10 (par l'équipe ATM), avec nos propres quêtes, réglages et ajouts.

[image : section-fonctionnalites-1200x120.png]
- Plus de 400 mods : technologie, magie, exploration
- Quêtes en français
- Économie et claims sur le serveur

[image : section-installation-1200x120.png]
Télécharge le launcher ATM (ATM-Setup.exe) : il installe NeoForge, Minecraft et le modpack en un clic.

[image : section-rejoindre-1200x120.png]
Adresse : washday-book.gl.joinmc.link

[image : section-discord-1200x120.png]
Rejoins-nous sur Discord : <ton lien d'invitation>
```
