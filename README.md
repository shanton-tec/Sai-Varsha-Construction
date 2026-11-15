# Sai Varsha Construction

Responsive React + Vite construction company website with a 2D/3D house design studio, project gallery, calculator, customer enquiries, and customer/admin dashboards. The API is an Express service backed by Supabase PostgreSQL.

## Supabase and API setup

1. Create a Supabase project. In **Project Settings → Database**, copy the PostgreSQL connection string. Use a session-mode pooler connection if direct database connectivity is unavailable. The database password belongs only in the backend environment; do not expose it as a `VITE_` variable.
2. Copy `.env.example` to `.env` and set:
   - `DATABASE_URL` to the connection string for the Supabase database (include `?sslmode=require`).
   - `JWT_SECRET` to a new random value of at least 32 characters. For example, run `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` and paste the output.
   - `CORS_ORIGINS` to the exact browser origins that host the frontend, comma-separated. The sample allows the local Vite dev server.
   - Keep `DATABASE_SSL=true` for Supabase. If Node reports `SELF_SIGNED_CERT_IN_CHAIN`, download the database root certificate from **Project Settings → Database → SSL Configuration**, save it locally as `supabase-root.crt`, and set `DATABASE_SSL_CA=./supabase-root.crt`. The backend will verify the database server against this CA. Never commit `.env` or the downloaded certificate.
3. In the Supabase **SQL Editor**, run [`supabase/schema.sql`](./supabase/schema.sql). It creates the `construction` schema and its `users`, `enquiries`, and `projects` tables. The separate schema avoids colliding with Supabase-managed or older public tables.
4. Start both services with `npm run dev:full`. The frontend is at `http://localhost:5173`, the API is at `http://localhost:4000`, and `GET http://localhost:4000/api/health` checks the database connection. Alternatively, start the frontend with `npm run dev` and the API with `npm run api`.
5. Create a regular customer account from **Client login → Create a customer account**. Its numeric customer ID is generated automatically and shown on the customer dashboard. To grant administrator access to a trusted account, use the SQL Editor:

   ```sql
   update construction.users
   set role = 'admin'
   where email = 'admin@example.com';
   ```

   Then sign in using **Client login → Admin**. The signed-in admin name opens a protected admin profile page. Admin login uses the same credentials as the promoted account; there is no default or hard-coded admin password.
6. Admins can create projects using the admin dashboard or `POST /api/projects`, assigning an existing customer's email. Customers see only their own projects after signing in.

## API

All request and response bodies are JSON. Authenticated endpoints require `Authorization: Bearer <token>`.

| Method | Endpoint | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | API and database health |
| `POST` | `/api/auth/register` | Public | Create a customer account (`name`, `email`, `password`) |
| `POST` | `/api/auth/login` | Public | Authenticate (`email`, `password`); returns a JWT |
| `GET` | `/api/auth/me` | Signed-in user | Return the current user |
| `POST` | `/api/enquiries` | Public or signed-in user | Submit an enquiry |
| `GET` | `/api/enquiries` | Admin | List enquiries; optional `?status=new` filter |
| `PATCH` | `/api/enquiries/:id` | Admin | Change status to `new`, `contacted`, `in_progress`, or `closed` |
| `GET` | `/api/projects` | Signed-in user | Admins see all projects; customers see their own |
| `POST` | `/api/projects` | Admin | Create a project |
| `PATCH` | `/api/projects/:id` | Admin | Update project fields |
| `GET` | `/api/admin/summary` | Admin | Customer, enquiry, and project counts |

Project records contain `project_name`, `customer_email`, `location`, `status`, `progress`, `estimated_cost`, and `next_milestone`. Passwords are hashed with bcrypt. JWTs expire according to `JWT_EXPIRES_IN` (default `12h`); admin privileges are checked against the database for every protected request.

The API uses Helmet, an explicit CORS allowlist, JSON body limits, input validation, parameterized SQL, and rate limits for API, login/registration, and enquiry routes. The database URL and JWT secret are server-only credentials. The frontend stores the short-lived bearer token in browser local storage; use HTTPS in production and keep all frontend content protected against script injection.

## Deploy a demo with Netlify

Netlify hosts the Vite frontend; it does not run this Express server as a regular web service. Deploy the API separately (for example, as a web service on Render) and use the existing Supabase PostgreSQL database.

1. Push the project to a private or public GitHub repository, then in Netlify choose **Add new site → Import an existing project** and connect that repository. The included `netlify.toml` configures `npm run build`, publishes `dist`, selects Node.js 22, and routes React app URLs such as `/builder` back through the SPA.
2. On your API host, create a Node web service from the same repository. Use `npm ci` as the build command and `npm run api` as the start command. Configure `DATABASE_URL` (Supabase connection string with `sslmode=require`), `DATABASE_SSL=true`, a new `JWT_SECRET` of at least 32 characters, `NODE_ENV=production`, `TRUST_PROXY=true`, and `CORS_ORIGINS` set to the exact Netlify site origin, such as `https://your-demo.netlify.app`. Do not put database credentials or the JWT secret in Netlify.
3. Wait for the API service to start, then verify `https://your-api-host/api/health` returns `{"ok":true,"database":"connected"}`.
4. In Netlify **Site configuration → Environment variables**, set `VITE_API_URL` to the API origin only, such as `https://your-api-host` (no `/api` suffix). Trigger a fresh deploy so Vite builds the frontend with this setting.
5. Share the Netlify site URL. Test `/builder`, customer registration/login, and the API health URL. If using a different Netlify deploy URL, add that exact origin to the API's `CORS_ORIGINS` and restart/redeploy the API. Redeploy the frontend after changing `VITE_API_URL`.

## Scripts

```bash
npm install
npm run dev:full  # frontend + API, watch mode (Node.js 20.19+)
npm run build
npm test
npm run test:api
```

For production, run `npm run api` with production environment variables and host the Vite build behind a web server or CDN that proxies `/api` to the Node service. Set `CORS_ORIGINS` to the production frontend origin.

## 3D design studio

The builder has a Parking / garage room preset that places a vehicle when the drawn room is large enough. The vehicle is a visual aid and is excluded from the construction cost estimate. Exterior mode includes façade finishes, roof options, textured landscaping, trees, driveway, and an optional parking bay and car. Furniture preview images are rendered locally from the same procedural models used in the scene.

## Important

The 3D studio is a concept visualization tool, not a substitute for professional architectural, structural, or statutory drawings. Review database backups, account administration, secrets, HTTPS, and deployment networking before commercial launch.
