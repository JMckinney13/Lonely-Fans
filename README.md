# Lonely Fans

Static frontend (HTML pages + `auth.js` + `styles.css`) served by Render static site
`Lonely-Fans-1`, and an Express/Postgres API in `backend/` (Render web service
`Lonely-Fans`). Pushing to `main` deploys both.

## Asset versioning (cache busting)

Every page loads its scripts and stylesheet with a content-hash query, e.g.
`auth.js?v=3ad7d4a1`. **Before committing any change to a `.js` or `.css` file, run:**

```bash
./scripts/bump-version.sh
git add -A
```

The script re-hashes each top-level `*.js` / `*.css` file and rewrites the
`?v=` tag in every `*.html` page (new asset references get a tag too). It is
idempotent, so it's safe to run before every commit.

HTML pages themselves are served with `Cache-Control: no-cache` (a Render
static-site header rule for `/*`), so a deploy is picked up on the next page
load, and the versioned asset URLs make the browser and CDN fetch the new files.

## Local development

Open the site on `localhost` and `auth.js` talks to a local backend at
`http://localhost:3001/api`:

```bash
cd backend && DATABASE_URL=postgres://user:pass@localhost:5432/lonelyfans PGSSL=false npm start
python3 -m http.server 8080 --bind 127.0.0.1   # from the repo root
```

The camera on the live page needs a secure context: `http://localhost` works,
other plain-HTTP hosts don't.
