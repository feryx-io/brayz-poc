import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { loadConfig } from '@brayz/config';
import { errorHandler } from './lib/http.js';
import { registerAuth } from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { authDevRoutes } from './routes/auth-dev.js';
import { tenantRoutes } from './routes/tenants.js';
import { locationRoutes } from './routes/locations.js';
import { settingsRoutes } from './routes/settings.js';
import { menuRoutes } from './routes/menu.js';
import { voiceNodeRoutes } from './routes/voiceNodes.js';
import { callRoutes, type CallRouteOptions } from './routes/calls.js';
import { orderRoutes, type OrderRouteOptions } from './routes/orders.js';
import { guestRoutes } from './routes/guests.js';
import { loyaltyRoutes } from './routes/loyalty.js';
import { insightsRoutes } from './routes/insights.js';
import { carrierRoutes } from './routes/carriers.js';
import { toolRoutes } from './routes/tools.js';
import { transferTargetRoutes } from './routes/transferTargets.js';
import { numberRoutes, type NumberRouteOptions } from './routes/numbers.js';
import { menuImportRoutes, type MenuImportRouteOptions } from './routes/menu-import.js';
import { menuTemplateRoutes } from './routes/menu-templates.js';
import { staffRoutes, type StaffRouteOptions } from './routes/staff.js';
import { posRoutes, type PosRouteOptions } from './routes/pos.js';
import { promotionRoutes } from './routes/promotions.js';
import { supportRoutes } from './routes/support.js';
import { adminRoutes } from './routes/admin.js';
import { billingRoutes, type BillingRouteOptions } from './routes/billing.js';
import { siphonWebhookRoutes, type SiphonWebhookOptions } from './routes/siphonWebhooks.js';
import {
  recordingRetentionRoutes,
  type RecordingRetentionRouteOptions,
} from './routes/recordingRetention.js';
import { assistantRoutes, type AssistantRouteOptions } from './routes/assistant.js';
import { messageRoutes } from './routes/messages.js';
import { textHealthRoutes } from './routes/textHealth.js';
import { smsConsentRoutes } from './routes/smsConsent.js';
import { voiceRoutes, type VoiceRouteOptions } from './routes/voices.js';
import { buildGeocoder, type GeocodingProvider } from './lib/geocoding.js';

/** Injectable dependencies (tests override carrier/provider behavior). */
export interface AppDeps {
  numberProvisioner?: NumberRouteOptions['provisioner'];
  menuExtractor?: MenuImportRouteOptions['extractor'];
  notifier?: OrderRouteOptions['notifier'];
  voiceCloner?: StaffRouteOptions['voiceCloner'];
  tts?: VoiceRouteOptions['tts'];
  posProviders?: PosRouteOptions['posProviders'];
  siphonWebhookSecret?: SiphonWebhookOptions['secret'];
  recordingStorage?: CallRouteOptions['recordingStorage'];
  schedulerOidcVerifier?: RecordingRetentionRouteOptions['oidcVerifier'];
  assistantLlm?: AssistantRouteOptions['llm'];
  billingProvider?: BillingRouteOptions['billingProvider'];
  stripeWebhookSecret?: BillingRouteOptions['stripeWebhookSecret'];
  /** Places delivery addresses for the radius check. `null` turns lookups off (tests). */
  geocoder?: GeocodingProvider | null;
}

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const cfg = loadConfig();

  const app = Fastify({
    logger: {
      level: cfg.LOG_LEVEL,
      transport:
        cfg.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
    // Standard correlation field for log lines (CLAUDE.md observability rule).
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(formbody); // Twilio webhooks post application/x-www-form-urlencoded
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 5 } }); // menu import uploads
  app.setErrorHandler(errorHandler);
  registerAuth(app);

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(authDevRoutes);
  await app.register(tenantRoutes);
  // One geocoder for the app: the location's own position and callers' delivery
  // addresses are placed through the same provider (rule #2).
  const geocoder = deps.geocoder === undefined ? buildGeocoder() : deps.geocoder;
  await app.register(locationRoutes, { geocoder });
  await app.register(settingsRoutes);
  await app.register(menuRoutes);
  await app.register(voiceNodeRoutes);
  await app.register(callRoutes, { recordingStorage: deps.recordingStorage });
  await app.register(recordingRetentionRoutes, {
    recordingStorage: deps.recordingStorage,
    oidcVerifier: deps.schedulerOidcVerifier,
  });
  await app.register(orderRoutes, { notifier: deps.notifier, posProviders: deps.posProviders, geocoder });
  await app.register(guestRoutes);
  await app.register(loyaltyRoutes);
  await app.register(insightsRoutes);
  await app.register(carrierRoutes);
  await app.register(toolRoutes, { notifier: deps.notifier, geocoder });
  await app.register(messageRoutes);
  await app.register(textHealthRoutes);
  await app.register(smsConsentRoutes, { notifier: deps.notifier });
  await app.register(transferTargetRoutes);
  await app.register(numberRoutes, { provisioner: deps.numberProvisioner });
  await app.register(menuImportRoutes, { extractor: deps.menuExtractor });
  await app.register(menuTemplateRoutes);
  await app.register(staffRoutes, { voiceCloner: deps.voiceCloner, tts: deps.tts });
  await app.register(voiceRoutes, { tts: deps.tts });
  await app.register(posRoutes, { posProviders: deps.posProviders });
  await app.register(promotionRoutes);
  await app.register(supportRoutes);
  await app.register(adminRoutes);
  await app.register(assistantRoutes, { llm: deps.assistantLlm });
  // Own plugin: it swaps in a raw-body JSON parser for signature verification.
  await app.register(billingRoutes, {
    billingProvider: deps.billingProvider,
    stripeWebhookSecret: deps.stripeWebhookSecret,
  });
  // Registered as its own plugin: it swaps in a raw-body JSON parser, which
  // must not leak into the rest of the API.
  await app.register(siphonWebhookRoutes, { secret: deps.siphonWebhookSecret });

  return app;
}
