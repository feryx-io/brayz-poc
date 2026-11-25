# Enabling Firebase Auth on `brayz-dev`

The app ships with two auth modes. Local dev + tests default to `dev` (header-based, no
external dependency). The **deployed `brayz-dev` cloud env runs `firebase` mode**: users
self-register (email/password or Google), sign in, and configure their restaurant.

- API verifies `Authorization: Bearer <ID token>` against Google's public certs
  (`services/api/src/auth/firebase.ts`) — **no service-account secret needed** to verify —
  and provisions the user + enforces tenant membership (`services/api/src/plugins/auth.ts`).
- Web sign-up/login lives in `apps/web/lib/auth.tsx` (`registerFirebase`, `loginFirebase`,
  `loginGoogle`); the display name is synced into our DB via `PATCH /v1/me`.

## 1. Enable Identity Platform + Firebase on the project

`identitytoolkit.googleapis.com` is enabled by Terraform (project-services module). To add
Firebase Auth and the sign-in providers (console is simplest), in **your** terminal/browser:

```bash
gcloud auth login
gcloud config set project brayz-dev
```

Firebase console (https://console.firebase.google.com → **Add project → pick `brayz-dev`**):
- **Build → Authentication → Sign-in method**: enable **Email/Password** and **Google**.
- **Authentication → Settings → Authorized domains**: add the Cloud Run **web** host
  (e.g. `brayz-dev-web-….a.run.app`) so Google sign-in popups are allowed there.

## 2. Get the web config (public, not secret)

Firebase console → **Project settings → Your apps → Web app** (register one if needed) →
SDK setup. You need three values: `apiKey`, `authDomain` (`brayz-dev.firebaseapp.com`),
`projectId` (`brayz-dev`).

## 3. Apply Terraform + deploy

`api_auth_mode = "firebase"` is set in `infra/terraform/envs/dev/terraform.tfvars`, so the
API service gets `AUTH_MODE=firebase` + `FIREBASE_PROJECT_ID` automatically:

```bash
terraform -chdir=infra/terraform/envs/dev apply
```

The **web config is baked into the image at build time**. The deploy script sources
`infra/scripts/env/<project>.env` (committed — these are public values that ship in the
browser bundle), so for `brayz-dev` a plain deploy already builds the web in firebase mode:

```bash
PROJECT=brayz-dev REGION=us-east4 ./infra/scripts/deploy-cloud-run.sh
```

For a new project, register a web app and write its config to that file (no console needed):

```bash
TOK=$(gcloud auth print-access-token)
curl -s -X POST -H "Authorization: Bearer $TOK" -H "x-goog-user-project: <project>" \
  -H "content-type: application/json" -d '{"displayName":"Brayz portal"}' \
  https://firebase.googleapis.com/v1beta1/projects/<project>/webApps        # → operation; poll for appId
curl -s -H "Authorization: Bearer $TOK" -H "x-goog-user-project: <project>" \
  https://firebase.googleapis.com/v1beta1/projects/<project>/webApps/<appId>/config   # apiKey, authDomain, projectId
```

Environment variables set explicitly still win over the file, and the script fails fast if
`WEB_AUTH_MODE=firebase` has no `FIREBASE_API_KEY` from either source.

## 4. Prove the flow

**First sign-in after switching from dev mode: use "Continue with Google".** The API links
a Firebase identity to a pre-existing user row (one created under dev mode) by email only
when the provider has *verified* that email — Google sign-in does, a fresh email/password
sign-up does not. An email/password sign-up with an email that already exists gets a
unique-email error instead of the existing tenant.

At the web URL: **Create an account** (email + password, or **Continue with Google**) →
land in onboarding → create a restaurant → **Account** shows your name, **Settings** lets
you configure it. Sign out, sign back in — your data persists. The API rejects any request
without a valid Bearer ID token whose audience is `brayz-dev`, and accepts a tenant header
only if the user is a member.

## Notes

- The `AuthVerifier` abstraction (`services/api/src/auth/firebase.ts`) means swapping
  providers (e.g. Clerk) is one new verifier, not route changes.
- `dev` mode (header auth + `/v1/auth/dev/register`) still works locally and in tests;
  it is **not** used by the deployed env.
- No password-reset / email-verification UI yet — add later via Firebase if wanted.
- For automated/headless backends later, grant the runtime SA the minimal Identity
  Platform role; token *verification* still needs no credential.
