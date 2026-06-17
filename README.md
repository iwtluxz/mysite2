# AML Best

Static frontend for GitHub Pages plus Node/SQLite backend for Render or Railway.

## Backend deploy

1. Deploy this repository as a Node web service.
2. Use `npm install` as build command.
3. Use `npm start` as start command.
4. Set environment variables:
   - `ADMIN_USER`
   - `ADMIN_PASSWORD`
   - `ALLOWED_ORIGINS=https://iwtluxz.github.io`

## Connect frontend to backend

After backend deploy, edit `config.js`:

```js
window.AML_API_BASE = "https://your-backend-url";
```

Without `AML_API_BASE`, GitHub Pages runs in local demo mode and cannot keep a shared admin database.
