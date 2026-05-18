# Code Snippet Server

Petit serveur HTTP qui extrait une **fonction (ou tout symbole top-level) d'un fichier TS/JS via AST**, pour pouvoir l'embarquer dans une page HTML sans copier-coller en dur. Quand le fichier source bouge, la page reste à jour automatiquement.

Stack : Node + Fastify + [ts-morph](https://github.com/dsherret/ts-morph) + [Shiki](https://shiki.style/).

## Installation

```bash
cd ~/snippet-server
npm install
cp config.example.json config.json
# édite config.json pour pointer vers tes repos
npm run dev
```

Le serveur écoute par défaut sur `http://127.0.0.1:4477`.

## Configuration

`config.json` à la racine. Chaque entrée de `repos` whiteliste un dossier accessible — toute requête doit nommer un de ces repos, et `file` est résolu **relativement** à son `root` (les `../` qui sortent du repo sont refusés).

```json
{
  "port": 4477,
  "host": "127.0.0.1",
  "corsOrigins": ["*"],
  "highlightTheme": "github-light",
  "repos": {
    "my-app": {
      "root": "/absolute/path/to/your/repo",
      "description": "Mon app web"
    }
  }
}
```

Tu peux pointer vers un autre config via `CODE_SNIPPET_CONFIG=/chemin/vers/config.json npm run dev`.

## API

### `GET /snippet`

Extrait un symbole. Params :

| Param | Requis | Description |
|---|---|---|
| `repo` | oui | Clé d'un repo déclaré en config |
| `file` | oui | Chemin relatif au repo (ex. `src/lib/utils.ts`) |
| `symbol` | oui | Nom de la fonction / classe / const exportée |
| `format` | non | `json` (défaut), `text`, ou `html` (Shiki highlighted) |

Exemple :

```bash
curl "http://127.0.0.1:4477/snippet?repo=my-app&file=src/lib/utils.ts&symbol=parseMagnetTitle"
```

Réponse `json` :

```json
{
  "repo": "my-app",
  "file": "src/lib/utils.ts",
  "symbol": "parseMagnetTitle",
  "kind": "FunctionDeclaration",
  "startLine": 31,
  "endLine": 128,
  "code": "export function parseMagnetTitle(...) { ... }"
}
```

### `GET /list`

Liste tous les symboles top-level d'un fichier.

```bash
curl "http://127.0.0.1:4477/list?repo=my-app&file=src/lib/utils.ts"
```

### `GET /symbol-at-line`

Retourne le symbole nommé le plus profond dont le corps englobe une ligne donnée. Utile pour réparer des manifests qui ont stocké un nom de symbol parent (`ProfilesPage`) alors qu'ils décrivent un helper interne (`handleDelete`).

| Param | Requis | Description |
|---|---|---|
| `repo` | oui | Clé d'un repo déclaré en config |
| `file` | oui | Chemin relatif au repo |
| `line` | oui | Numéro de ligne 1-indexé |

Réponse :

```json
{
  "repo": "my-app",
  "file": "src/app/profiles/page.tsx",
  "line": 74,
  "symbol": {
    "name": "handleDelete",
    "kind": "FunctionDeclaration",
    "startLine": 74,
    "endLine": 88
  }
}
```

Codes d'erreur :

- `400` si un param est manquant ou si `line` n'est pas un entier valide.
- `404` si aucun symbole nommé n'englobe cette ligne.

Note technique : l'algorithme descend l'AST ts-morph et garde le symbole nommé le plus profond contenant la ligne. Probe à fin de ligne pour que la déclaration elle-même résolve à son propre symbole.

### `GET /health`

Healthcheck + liste des repos.

### `GET /repos`

Liste les repos configurés avec leur description.

## Symboles supportés

- `function foo() {}` / `export function foo() {}`
- `class Foo {}`
- `interface Foo {}` / `type Foo = …`
- `const foo = …` / `export const foo = …` (incluant arrow functions assignées)
- `enum Foo {}`

Pas supporté en v1 : méthodes de classe nommées (`Foo.bar`), exports re-exportés, expressions inline anonymes.

## Embarquer dans une page HTML

Voir [examples/embed.html](examples/embed.html) pour le pattern complet (récupère JSON, écrit via `textContent` pour le code brut, et insère le HTML Shiki seulement quand on contrôle le serveur). Sers la page avec n'importe quel static server :

```bash
npx serve examples
```

Le pattern minimal :

- Ajouter une `<section>` avec `data-repo`, `data-file`, `data-symbol`, `data-format`.
- En JS, fetch `${API}/snippet?…` et injecter la réponse.
- Pour le mode `format=text` ou `json`, utiliser `textContent` (zéro risque XSS).
- Pour `format=html`, le serveur retourne du HTML Shiki déjà échappé — sûr tant que le serveur reste local et trusté.

## Cache

Cache en mémoire indexé sur `mtime` + `size` du fichier. Si tu modifies le source, la prochaine requête réparse automatiquement. Pas besoin de redémarrer le serveur.

## Sécurité

- Path traversal : tout chemin qui résout en dehors du `root` du repo est rejeté (`403`).
- Filtres : seuls les fichiers `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` sont parsés.
- CORS : configurable via `corsOrigins` (par défaut `*`, à restreindre en prod).
- À écouter sur `127.0.0.1` tant que l'usage est local — si tu l'exposes au réseau, **ajoute un auth token**.

## Roadmap

- v0.2 : auth token (header `X-Snippet-Token`)
- v0.3 : extraction par range de lignes (fallback quand le symbole n'a pas de nom)
- v0.4 : support de méthodes de classe (`ClassName.methodName`)
- v0.5 : autres langages via tree-sitter (Swift, Kotlin, Python)
