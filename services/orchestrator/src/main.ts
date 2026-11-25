import pino from 'pino';
import { loadConfig } from '@brayz/config';
import { AnthropicLlmProvider, DeepgramSttProvider, DeepgramTtsProvider } from '@brayz/ai';
import { createMediaServer, type ConversationFactory } from './mediaServer.js';
import { ConversationEngine } from './conversation.js';
import {
  createApiToolExecutor,
  createDeliveryChecker,
  createGuestLoader,
  createSavedAddressConfirmer,
  createMenuLoader,
  createMenuGapReporter,
  createOrderCanceller,
  createOrderTextConsent,
  createOrderChanger,
  createOrderConfirmer,
  createOrderPlacer,
  createRecentOrderLoader,
  createScheduler,
  createProfileLoader,
  createUpsellLoader,
  createPersonaLoader,
  createPersonaSwitcher,
  createTransferTargetLoader,
  createVoiceLoader,
} from './tools.js';
import { HttpCallPersistence } from './persistence.js';

/**
 * Orchestrator entrypoint. Wires the HTTP-backed call persistence and starts the
 * media WebSocket server. Business logic stays out of the voice layer; this owns
 * the conversation + call lifecycle, not restaurant config.
 */
const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL });

const persistence = new HttpCallPersistence(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);

// The AI bot only turns on when its providers are configured; otherwise the
// media plane still runs (call lifecycle + persistence) without a conversation.
let conversationFactory: ConversationFactory | undefined;
if (cfg.ANTHROPIC_API_KEY && cfg.DEEPGRAM_API_KEY) {
  const stt = new DeepgramSttProvider({ apiKey: cfg.DEEPGRAM_API_KEY });
  const tts = new DeepgramTtsProvider({ apiKey: cfg.DEEPGRAM_API_KEY });
  const llm = new AnthropicLlmProvider({
    apiKey: cfg.ANTHROPIC_API_KEY,
    model: cfg.ANTHROPIC_MODEL,
    thinking: cfg.ANTHROPIC_THINKING,
    effort: cfg.ANTHROPIC_EFFORT,
  });
  const toolExecutor = createApiToolExecutor(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const loadTransferTargets = createTransferTargetLoader(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const loadMenu = createMenuLoader(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const loadGuest = createGuestLoader(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const placeOrder = createOrderPlacer(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const reportMenuGap = createMenuGapReporter(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const loadVoice = createVoiceLoader(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const loadProfile = createProfileLoader(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const loadUpsells = createUpsellLoader(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const loadPersonas = createPersonaLoader(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const switchPersona = createPersonaSwitcher(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const checkDelivery = createDeliveryChecker(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const confirmSavedAddress = createSavedAddressConfirmer(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const scheduleOrder = createScheduler(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const loadRecentOrder = createRecentOrderLoader(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const confirmRecentOrder = createOrderConfirmer(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const changeOrder = createOrderChanger(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const cancelOrder = createOrderCanceller(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  const recordOrderTextConsent = createOrderTextConsent(cfg.API_INTERNAL_URL, cfg.BRAYZ_NODE_SHARED_SECRET, log);
  conversationFactory = ({ context, io, log: callLog }) =>
    new ConversationEngine({
      providers: { stt, llm, tts },
      context,
      io,
      log: callLog,
      toolExecutor,
      loadTransferTargets,
      loadMenu,
      loadGuest,
      loadVoice,
      loadProfile,
      loadUpsells,
      loadPersonas,
      switchPersona,
      placeOrder,
      scheduleOrder,
      loadRecentOrder,
      confirmRecentOrder,
      changeOrder,
      cancelOrder,
      recordOrderTextConsent,
      checkDelivery,
      confirmSavedAddress,
      reportMenuGap,
      // Persist the conversation as it happens (through the API — rule #5).
      // Deepgram emits interim segments too; only finals are a transcript turn.
      onTranscript: (segment, speaker) => {
        if (!segment.isFinal || !segment.text.trim()) return;
        void persistence.appendTranscript(context.callId, [
          {
            speaker,
            text: segment.text.trim(),
            startedAtMs: segment.startedAtMs,
            endedAtMs: segment.endedAtMs,
            confidence: segment.confidence,
          },
        ]);
      },
    });
  log.info(
    {
      model: cfg.ANTHROPIC_MODEL,
      thinking: cfg.ANTHROPIC_THINKING ?? 'model default',
      effort: cfg.ANTHROPIC_EFFORT ?? 'model default',
    },
    'Conversation engine enabled (Deepgram STT/TTS + Claude)',
  );
} else {
  log.warn('Conversation engine disabled — set ANTHROPIC_API_KEY + DEEPGRAM_API_KEY to enable the bot');
}

// No fallback node id: each SiphonAI node names itself on its media URL
// (`?node=`), and a connection that does not is better left unattributed than
// filed under a made-up one.
const media = createMediaServer({
  log,
  persistence,
  conversationFactory,
  // Same secret the Orchestrator uses to call the API, so SiphonAI's
  // `[bridge].ws_auth_header` and the node's API auth are one value to rotate.
  authToken: cfg.BRAYZ_NODE_SHARED_SECRET,
});

void media.listen(cfg.ORCHESTRATOR_PORT).then((port) => {
  log.info({ port, api: cfg.API_INTERNAL_URL }, 'Orchestrator listening (media: /v1/media)');
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'Shutting down orchestrator');
  await media.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
