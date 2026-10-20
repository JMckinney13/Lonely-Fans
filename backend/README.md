# Lonely Fans Backend

## Deploy to Render (free)

1. Push this folder to GitHub (or upload the zip).
2. Go to https://render.com → New → Web Service.
3. Connect your GitHub repo.
4. Settings:
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: Node
5. Add env var: `JWT_SECRET` = any long random string.
6. Deploy. Copy the public URL (e.g. `https://lonely-fans-api.onrender.com`).

Then update the frontend `API_BASE` and redeploy.

## Local run
```bash
cd backend
npm install
npm start
```
API at http://localhost:3001
