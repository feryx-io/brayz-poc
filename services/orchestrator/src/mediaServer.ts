import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'pino';
import { NODE_ID_PATTERN } from '@brayz/shared';
import { InboundEvent, StartMessage, type CallState, type OutboundControl } from './protocol.js';
import type { CallPersistence } from './persistence.js';
import type { CallIo, Conversation, ConversationContext } from './conversation.js';

/** Builds the AI conversation for a call. Omit to run the media plane without a bot. */
export type ConversationFactory = (args: {
  context: ConversationContext;
  io: CallIo;
  log: Logger;
}) => Conversation;

export interface MediaServerOptions {
  log: Logger;
  persistence: CallPersistence;
  /**
   * Which SiphonAI node a call came from, when the connection itself does not
   * say. Each node dials `…/v1/media?node=<id>` (Terraform renders it into the
   * node's `[bridge].ws_url`), so this is the last resort after that and the
   * forwarded client address. Omit it and such a call is left unattributed.
   */
  nodeId?: string;
  conversationFactory?: ConversationFactory;
  /**
   * Shared secret SiphonAI must present as `Authorization: Bearer <token>`
   * (its `[bridge].ws_auth_header`). Omit to accept any connection — only for
   * tests and a local bridge on loopback. The deployed Orchestrator is
   * invokable by allUsers, so anything reachable is reachable by everyone.
   */
  authToken?: string;
}

export interface MediaServerHandle {
  server: Server;
  wss: WebSocketServer;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Orchestrator media server — the WebSocket *server* SiphonAI's bridge connects
 * to (siphon-ai docs/PROTOCOL.md, v1). Per call: one WS connection. We parse the
 * `start` handshake, persist the call via the API (rule #5), stream caller PCM to
 * the conversation engine, and translate SiphonAI's events (speech_started →
 * barge-in, stop/error → end) and our controls (clear/transfer with call_id).
 */
export function createMediaServer(opts: MediaServerOptions): MediaServerHandle {
  const { log, persistence, nodeId, conversationFactory } = opts;
  const expectedAuth = opts.authToken?.trim() ? `Bearer ${opts.authToken.trim()}` : undefined;
  if (!expectedAuth) {
    log.warn('Media server is UNAUTHENTICATED — any client that reaches /v1/media can start a call');
  }

  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server,
    // Matched against the path alone, so a node's `?node=` does not stop it.
    path: '/v1/media',
    // SiphonAI offers `siphon-ai.v1`; echo it (it proceeds even if we don't).
    handleProtocols: (protocols) => (protocols.has('siphon-ai.v1') ? 'siphon-ai.v1' : false),
    // Rejected during the HTTP upgrade, before a WebSocket exists: an
    // unauthenticated caller never reaches the `start` handshake, so it can
    // never create a call record or spend a token on the model.
    verifyClient: expectedAuth
      ? ({ req }, done) => {
          if (matchesSecret(req.headers.authorization, expectedAuth)) return done(true);
          log.warn(
            { ip: req.socket.remoteAddress, hasHeader: Boolean(req.headers.authorization) },
            'Rejected media connection: bad or missing Authorization',
          );
          done(false, 401, 'Unauthorized');
        }
      : undefined,
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const session = new MediaSession(ws, log, persistence, nodeIdFor(req) ?? nodeId, conversationFactory);
    // Process a session's messages strictly in order — an event must never be
    // handled before the `start` handshake (and its persistence) completes.
    ws.on('message', (data: Buffer, isBinary: boolean) => session.enqueueMessage(data, isBinary));
    ws.on('close', () => session.enqueueClose());
    ws.on('error', (err) => log.warn({ err }, 'media socket error'));
  });

  return {
    server,
    wss,
    listen: (port: number) =>
      new Promise<number>((resolve) => {
        server.listen(port, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

/**
 * Which SiphonAI node opened this media connection.
 *
 * SiphonAI's `start` message does not say, so each node names itself on the
 * URL it dials (`?node=<id>`, rendered from its `[node].id` by Terraform).
 * Failing that, the address it connected from — the first X-Forwarded-For hop
 * on Cloud Run, which is the node's static IP. Anything that is not a plain id
 * is ignored rather than stored: it is shown in the staff portal and grouped on.
 */
export function nodeIdFor(req: IncomingMessage): string | undefined {
  const named = new URL(req.url ?? '/', 'http://media.invalid').searchParams.get('node')?.trim();
  if (named && NODE_ID_PATTERN.test(named)) return named;
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const byAddress = first ? `ip:${first}` : undefined;
  return byAddress && NODE_ID_PATTERN.test(byAddress) ? byAddress : undefined;
}

class MediaSession {
  private state: CallState = 'initializing';
  /** SiphonAI's internal call id — echoed on every server→daemon message. */
  private siphonCallId = 'unknown';
  /** Our durable call row id (UUID) — used for persistence + tool API calls. */
  private dbCallId: string | null = null;
  private frames = 0;
  private mediaStarted = false;
  private ended = false;
  private chain: Promise<unknown> = Promise.resolve();
  private conversation: Conversation | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly log: Logger,
    private readonly persistence: CallPersistence,
    private readonly nodeId: string | undefined,
    private readonly conversationFactory?: ConversationFactory,
  ) {}

  /** Append work to the per-session serial queue. */
  enqueueMessage(data: Buffer, isBinary: boolean): void {
    this.chain = this.chain
      .then(() => this.onMessage(data, isBinary))
      .catch((err) => this.log.warn({ err }, 'message handler error'));
  }

  enqueueClose(): void {
    this.chain = this.chain.then(() => this.onClose()).catch(() => {});
  }

  /** Stamp the connection's call_id and send a control to SiphonAI (§4). */
  private send(control: OutboundControl): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ ...control, call_id: this.siphonCallId }));
    }
  }

  private async onMessage(data: Buffer, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.frames += 1;
      if (this.conversation) {
        this.conversation.pushAudio(data);
        return;
      }
      if (this.frames % 250 === 0) this.log.debug({ callId: this.siphonCallId, frames: this.frames }, 'audio frames');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.log.warn('non-JSON text frame ignored');
      return;
    }

    const start = StartMessage.safeParse(parsed);
    if (start.success && start.data.type === 'start') {
      await this.onStart(start.data);
      return;
    }

    const event = InboundEvent.safeParse(parsed);
    if (event.success) {
      await this.onEvent(event.data);
      return;
    }

    this.log.warn({ callId: this.siphonCallId }, 'unrecognized media frame');
  }

  private async onStart(msg: StartMessage): Promise<void> {
    this.siphonCallId = msg.call_id;
    this.state = 'loading_context';
    this.log.info(
      {
        siphonCallId: this.siphonCallId,
        nodeId: this.nodeId,
        from: msg.from,
        to: msg.to,
        direction: msg.direction,
      },
      'media session started',
    );

    // Resolve the tenant/location-scoped call by the dialed number. SiphonAI's
    // call_id is not a UUID, so we let the DB mint the row id and keep siphon's
    // id only for correlation (providerCallId).
    let service: { inService: boolean; reason?: string | null; forwardTo?: string | null } | undefined;
    if (msg.to) {
      const call = await this.persistence.ensureCall({
        fromNumber: msg.from || undefined,
        toNumber: msg.to,
        nodeId: this.nodeId,
        providerCallId: msg.sip?.call_id ?? this.siphonCallId,
      });
      if (call) {
        this.dbCallId = call.id;
        await this.persistence.postEvent(call.id, 'call.answered');
        service = call.service;
      }
    }

    // Out of service — the account's free trial lapsed with nothing paid for —
    // so the AI does not take the call. Ring it through to the restaurant when
    // there is somewhere to send it; otherwise the engine says one line and
    // hangs up. No STT and no model either way.
    const outOfService = service?.inService === false;
    if (outOfService) {
      this.log.info(
        { siphonCallId: this.siphonCallId, reason: service?.reason, forwarding: Boolean(service?.forwardTo) },
        'call out of service',
      );
      if (service?.forwardTo) {
        this.send({ type: 'transfer', target: service.forwardTo });
        this.state = 'transferring';
        return;
      }
      if (!this.conversationFactory) {
        this.send({ type: 'hangup', cause: 'normal' });
        this.state = 'completed';
        return;
      }
    }

    if (this.conversationFactory) {
      const io: CallIo = {
        sendAudio: (frame) => {
          if (this.ws.readyState === this.ws.OPEN) this.ws.send(frame, { binary: true });
        },
        send: (control) => this.send(control),
      };
      this.conversation = this.conversationFactory({
        context: {
          callId: this.dbCallId ?? this.siphonCallId,
          sampleRate: msg.audio.sample_rate,
          ...(outOfService ? { outOfService: true } : {}),
        },
        io,
        log: this.log,
      });
      // Don't await: greeting/TTS runs concurrently so inbound audio and events
      // keep flowing through the serial message queue.
      void this.conversation
        .start()
        .catch((err) => this.log.error({ err, callId: this.siphonCallId }, 'conversation start failed'));
    }
    this.state = 'greeting';
  }

  private async onEvent(event: InboundEvent): Promise<void> {
    // Defensive: ignore events for a different call (protocol §5.3).
    if (event.call_id && this.siphonCallId !== 'unknown' && event.call_id !== this.siphonCallId) {
      this.log.warn({ got: event.call_id, expected: this.siphonCallId }, 'event call_id mismatch');
      return;
    }

    switch (event.type) {
      case 'speech_started':
        // Caller barge-in: cancel the turn + flush playout, and mark media live.
        if (this.conversation) await this.conversation.bargeIn();
        else this.send({ type: 'clear' });
        this.state = 'listening';
        if (!this.mediaStarted && this.dbCallId) {
          this.mediaStarted = true;
          await this.persistence.postEvent(this.dbCallId, 'call.media_started');
        }
        break;
      case 'speech_stopped':
        // Releases the conversation's hold on an utterance it is still
        // gathering — the caller has finished this breath. What was said still
        // comes from STT; this only says when they stopped.
        this.conversation?.speechStopped();
        break;
      case 'stop':
      case 'error':
        // An out-of-service forward that failed (transfer_failed) leaves the
        // caller on a live line with no one on it — SiphonAI keeps the call up.
        if (event.type === 'error' && this.state === 'transferring') this.send({ type: 'hangup', cause: 'normal' });
        await this.endCall();
        break;
      // Recording lifecycle (protocol §3.11). The file itself lives on the
      // SiphonAI node and reaches us later as a `recording_uploaded` webhook —
      // these events are what let the dashboard say whether a recording exists
      // at all, and why it doesn't when it doesn't.
      case 'recording_started':
      case 'recording_stopped':
      case 'recording_failed':
        await this.onRecordingEvent(event);
        break;
      // Events we don't act on yet (still useful later): dtmf, hold, resume,
      // mark, silence_detected, dead_air_detected, rtp_stats.
      // Ignored rather than rejected (protocol §5.4).
      default:
        this.log.debug({ type: event.type, callId: this.siphonCallId }, 'media event ignored');
    }
  }

  private async onRecordingEvent(event: InboundEvent): Promise<void> {
    const status = event.type.replace('recording_', ''); // started | stopped | failed
    const recordingId = typeof event.recording_id === 'string' ? event.recording_id : undefined;
    if (event.type === 'recording_failed') {
      // Best-effort by design (protocol §3.11) — never touches the call itself.
      this.log.warn(
        { callId: this.siphonCallId, reason: event.reason },
        'siphon reported a recording failure',
      );
    }
    if (!this.dbCallId) return;
    await this.persistence.setRecording(this.dbCallId, { recordingId, recordingStatus: status });
  }

  private async endCall(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.state = 'completed';
    // Summarize before stopping the engine: `stop()` closes the STT stream and
    // aborts the in-flight turn, but the message history it summarizes from is
    // already complete, and doing it here keeps the whole thing off the call.
    const summary = this.conversation
      ? await this.conversation.summarize().catch((err) => {
          this.log.warn({ err, callId: this.siphonCallId }, 'summarize failed');
          return null;
        })
      : null;
    if (this.conversation) await this.conversation.stop().catch(() => {});
    if (this.dbCallId) await this.persistence.completeCall(this.dbCallId, { summary });
  }

  private async onClose(): Promise<void> {
    this.log.info({ callId: this.siphonCallId, frames: this.frames, state: this.state }, 'media session closed');
    await this.endCall();
  }
}

/**
 * Constant-time bearer comparison. A length mismatch returns early — that leaks
 * only the token's length, which timingSafeEqual cannot compare across sizes
 * anyway, and the secret is generated rather than chosen.
 */
function matchesSecret(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
