import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Centralized, Zod-validated configuration for all Brayz services.
 *
 * RULE (CLAUDE.md): never read `process.env` anywhere else. Add new vars here so
 * every service shares one validated, typed source of truth. In GCP, values are
 * injected from Secret Manager; locally they come from `.env`.
 */

const Booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/**
 * An optional secret that may arrive blank.
 *
 * Secret Manager has no "absent" — a Cloud Run service referencing a secret
 * with no version refuses to start, so every optional secret gets a placeholder
 * empty version at deploy time. An empty string must therefore read as "not
 * configured" rather than failing validation and taking the whole service down
 * over a feature nobody switched on.
 */
const optionalSecret = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Postgres — system of record. Required everywhere that touches durable state.
  DATABASE_URL: z.string().url().or(z.string().startsWith('postgres')),

  // Redis — ephemeral hot state only.
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // GCP
  GCP_PROJECT_ID: z.string().default('brayz-dev'),
  PUBSUB_TOPIC_CALL_EVENTS: z.string().default('call-events'),

  // Auth. `dev` uses request headers (local/testing); `firebase` verifies a
  // Firebase/Identity Platform ID token via firebase-admin.
  AUTH_MODE: z.enum(['dev', 'firebase']).default('dev'),
  // Project whose tokens we accept; defaults to GCP_PROJECT_ID when unset.
  FIREBASE_PROJECT_ID: z.string().optional(),
  // Bootstrap for the Brayz staff admin portal: comma-separated emails that are
  // granted the `admin` platform role the first time they sign in. Needed
  // because the first admin cannot be promoted through a UI that only an admin
  // can open. After that the DB column is the source of truth — removing an
  // email here does NOT revoke access, which is deliberate: revocation is an
  // explicit act, not a config edit nobody notices.
  PLATFORM_ADMIN_EMAILS: z.string().optional(),

  // Twilio — first carrier, behind CarrierProvider. Optional so services boot
  // without live telephony in local dev.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  // Elastic SIP Trunk to attach newly-provisioned numbers to, so inbound calls
  // route to SiphonAI → Orchestrator. Without it, purchased numbers won't reach Brayz.
  TWILIO_TRUNK_SID: z.string().optional(),
  // Outbound SMS (order-confirmation texts). A Messaging Service SID is preferred;
  // otherwise a single E.164 sender number. Either one enables SMS notifications.
  TWILIO_SMS_FROM: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),

  // AI providers — optional locally; required where the relevant adapter is used.
  OPENAI_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // LLM model for the conversation brain. Sonnet 5, not Haiku: the menu a
  // restaurant actually has is full of traps a smaller model walks into. On
  // Saratoga's menu — a Hot Subs item named "Sausage" whose description reads
  // "Choose cheese + sauce" — Haiku 4.5 answered "one large sausage pizza" by
  // asking which cheese the caller wanted ON HIS PIZZA, on two real calls and
  // in every offline replay; Sonnet 5 takes the build-your-own pizza and puts
  // sausage on it, on the same prompt, every time. It costs about two seconds
  // more on a call's first reply and twice the tokens; a wrong order costs more
  // than that. See test/conversation-live.test.ts in the orchestrator.
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  // How hard that model thinks before it answers, and how deep when it does.
  // On a phone call these are latency settings before they are quality ones.
  // Measured against Saratoga's real 111-item menu, Sonnet 5 takes 3.2-4.0 s to
  // its first token with thinking on and ~1.0 s with it off, and every turn pays
  // that once per model round trip — twice on a turn that touches an order tool.
  // On the call of 2026-09-02 that was ~4 s of silence after the caller's first
  // question.
  //
  // Off by default, which is a change from the model's own default (Sonnet 5
  // runs adaptive thinking at effort high unless told otherwise — a default
  // nobody here chose). It is only safe to turn off because the one thing in
  // this conversation that needed the thinking pass — working out that "a
  // sausage pizza" is the build-your-own pizza and not the Hot Subs item called
  // "Sausage" — moved into the tool layer in #59. Before that it scored 4/4 with
  // thinking on and 2/4 with it off; after, 8/8 either way. The full case set
  // (required choices, whole option names, off-menu refusals, two items in one
  // breath, and no tool call or XML tag leaking into speech) scores 48/48 with
  // thinking off.
  //
  // Set ANTHROPIC_THINKING=adaptive to put it back, and re-run that case set
  // before trusting a lower setting on a menu that is not this one.
  ANTHROPIC_THINKING: z.enum(['adaptive', 'disabled']).default('disabled'),
  // Depth when thinking is on. Unset means the model's own default (high on
  // Sonnet 5); it does nothing while thinking is disabled.
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  // Model for menu extraction (vision + structured output). Sonnet is the default:
  // a full menu with per-item ingredients is a lot of output tokens, and Opus's
  // slow throughput made imports take minutes. Override for max accuracy if needed.
  MENU_EXTRACTION_MODEL: z.string().default('claude-sonnet-4-6'),

  // Siphon-AI <-> Brayz signed-request shared secret.
  BRAYZ_NODE_SHARED_SECRET: z.string().min(8).default('dev-only-change-me'),
  // Stripe (billing, plan §12.5). Absent keys mean billing is simply off: the
  // dashboard says so and no route pretends a subscription exists.
  STRIPE_SECRET_KEY: optionalSecret(z.string()),
  STRIPE_WEBHOOK_SECRET: optionalSecret(z.string()),
  // Price ids per plan. Stripe holds the price of record; these only say which
  // price belongs to which tier.
  STRIPE_PRICE_STARTER: optionalSecret(z.string()),
  STRIPE_PRICE_GROWTH: optionalSecret(z.string()),
  STRIPE_PRICE_PRO: optionalSecret(z.string()),
  // Whether plan tiers actually gate features. Off by default: every location
  // predates billing, and denying by default would switch off working
  // restaurants the moment this ships.
  BILLING_ENFORCED: Booleanish.default('false'),

  // Object storage holding call recordings, as SiphonAI's `[recording.storage]`
  // uploads them. S3-compatible: GCS interop, S3, R2, MinIO. Without these the
  // dashboard shows that a recording exists but cannot play it.
  RECORDING_S3_ENDPOINT: optionalSecret(z.string().url()),
  // Empty-tolerant: Terraform passes a plain env var that may be blank.
  RECORDING_S3_REGION: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('auto')),
  RECORDING_S3_ACCESS_KEY: optionalSecret(z.string()),
  RECORDING_S3_SECRET_KEY: optionalSecret(z.string()),
  // How long a playback URL stays valid. Short: it is handed to a browser, and
  // a recording is a privacy artefact, not a public asset.
  RECORDING_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  // The platform ceiling on recording retention: the bucket's own lifecycle
  // rule deletes anything older, whatever a location asks for. A location's
  // `recordingRetentionDays` may only be shorter than this. Empty-tolerant
  // like the region, because Terraform passes it as a plain env var.
  RECORDING_MAX_RETENTION_DAYS: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().min(1).max(3650).default(90),
  ),
  // How many expired recordings one sweep run deletes per location before
  // stopping. The scheduler runs it again soon enough; a bound keeps one run
  // from holding a request open across thousands of deletes.
  RECORDING_SWEEP_BATCH: z.coerce.number().int().min(1).max(5000).default(200),

  // Who may invoke internal scheduled jobs (the retention sweep) with a Google
  // OIDC identity token: the Cloud Scheduler service account's email, and the
  // audience the token was minted for. Both unset means only the node secret
  // is accepted, which is the local/dev posture.
  SCHEDULER_INVOKER_EMAIL: optionalSecret(z.string().email()),
  SCHEDULER_OIDC_AUDIENCE: optionalSecret(z.string().min(1)),

  // HMAC secret SiphonAI signs its lifecycle webhooks with (`[webhooks].secret`).
  // Unset means the webhook endpoint refuses every delivery — an unauthenticated
  // endpoint that stamps recording URLs onto calls is not a safe default.
  SIPHON_WEBHOOK_SECRET: optionalSecret(z.string().min(16)),

  // The API's public origin, as a provider calls it back (Twilio's SMS delivery
  // callback, which it also signs). Unset: taken from the request that sent the
  // text (Cloud Run's host + X-Forwarded-Proto), which is right until a custom
  // domain sits in front.
  API_PUBLIC_URL: optionalSecret(z.string().url()),

  // Internal API base URL (used by the Orchestrator/worker to reach the API).
  API_INTERNAL_URL: z.string().url().default('http://localhost:4000'),

  // SIP domain used to turn a per-location transfer target's phone/extension
  // into a REFER URI (sip:<number>@<domain>). Targets stored as full sip: URIs
  // ignore this. Phone-number targets are unusable for transfer without it.
  BRAYZ_TRANSFER_SIP_DOMAIN: z.string().optional(),

  // Ports
  API_PORT: z.coerce.number().int().positive().default(4000),
  ORCHESTRATOR_PORT: z.coerce.number().int().positive().default(4100),
  WEB_PORT: z.coerce.number().int().positive().default(3000),

  // Misc
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DISABLE_DOTENV: Booleanish.optional(),
});

export type BrayzConfig = z.infer<typeof EnvSchema>;

let cached: BrayzConfig | undefined;

/**
 * Load, validate, and cache configuration. Throws a readable aggregate error if
 * any required variable is missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrayzConfig {
  if (cached) return cached;

  if (env.DISABLE_DOTENV !== 'true' && env.DISABLE_DOTENV !== '1') {
    loadDotenv();
  }

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid Brayz environment configuration:\n${issues}\n\n` +
        'Fix your .env (see .env.example) or the runtime environment.',
    );
  }

  cached = parsed.data;
  return cached;
}

/** Reset the cache — test helper only. */
export function resetConfigCache(): void {
  cached = undefined;
}

export const isProduction = (cfg: BrayzConfig): boolean => cfg.NODE_ENV === 'production';
export const isTest = (cfg: BrayzConfig): boolean => cfg.NODE_ENV === 'test';
