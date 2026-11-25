import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadConfig } from '@brayz/config';
import { prisma, Prisma, writeAudit } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { toSipUri } from '../lib/sip.js';
import { computeUsual, locationGuestMemoryMode, resolveOrCreateGuest } from '../lib/guests.js';
import { isVip, locationLoyaltySettings } from '../lib/loyalty.js';
import { requireNode } from '../auth/node.js';
import {
  DEFAULT_WELCOME_BACK_LINES,
  DeliveryAddress,
  RecordMenuGapInput,
  ScheduleOrderInput,
  TakeMessageInput,
  GUEST_ORDER_UPDATES_DISCLOSURE_VERSION,
  guestOrderTextsConfirmationSms,
  guestOrderTextsOffer,
  houseNumber,
  pickLine,
} from '@brayz/shared';
import { upsellsForOrder } from '../lib/upsell.js';
import { buildNotifier, textGuest, textLocation } from '../lib/notifier.js';
import { orderCode } from '../lib/orderMapping.js';
import { checkDeliveryArea, DELIVERY_LOCATION_SELECT } from '../lib/delivery.js';
import { announcesClosed, loadLocationSchedule } from '../lib/locationSchedule.js';
import { decideSchedule } from '../lib/schedule.js';
import { resolveRequestedTime, spokenDate, spokenWhen } from '../lib/hours.js';
import type { GeocodingProvider } from '../lib/geocoding.js';
import type { NotificationSender } from '@brayz/carriers';

export interface ToolRouteOptions {
  /** Texts the restaurant when a message is taken. `null` means none configured; tests inject a fake. */
  notifier?: NotificationSender | null;
  /** Places delivery addresses for the radius check; none means only ZIP rules can be judged. */
  geocoder?: GeocodingProvider | null;
}

/** A caller ID Brayz can text. */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Wrong street numbers allowed per call before the saved address stops being offered. */
const ADDRESS_CONFIRM_ATTEMPTS = 2;

/**
 * Internal tool API for the Orchestrator's AI tools (CLAUDE.md rule #5: the LLM
 * reaches data through stable internal endpoints, never raw tables, and never
 * computes prices or invents menu items). Node-authed and keyed by callId — the
 * API resolves tenant/location from the call record, so the voice plane can't
 * query an arbitrary tenant and the LLM never sees scoping.
 */
export async function toolRoutes(app: FastifyInstance, opts: ToolRouteOptions = {}): Promise<void> {
  const notifier = opts.notifier === undefined ? buildNotifier() : opts.notifier;
  const geocoder = opts.geocoder ?? null;
  async function loadCall(
    callId: string,
  ): Promise<{ tenantId: string; locationId: string; fromNumber: string | null; guestId: string | null }> {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { tenantId: true, locationId: true, fromNumber: true, guestId: true },
    });
    if (!call) throw notFound('Call');
    return call;
  }

  /**
   * Which greeting and welcome-back line this call gets. A recognized caller
   * cycles by how many times they have called this location before, so a
   * regular hears the next line each time; a stranger gets one at random.
   * Templates only — the engine fills {staff_name} and {guest_name}, since it
   * knows who answers and applies the guest-memory gate (rule #6) before it
   * uses a name.
   */
  async function chooseLines(
    locationId: string,
    guestId: string | null,
    lines: { aiGreetings: string[]; welcomeBackLines: string[] },
  ): Promise<{ greeting: string | null; welcomeBack: string }> {
    const who = guestId
      ? { priorCalls: Math.max(0, (await prisma.call.count({ where: { locationId, guestId } })) - 1) }
      : { random: Math.random() };
    const welcome = lines.welcomeBackLines.length ? lines.welcomeBackLines : DEFAULT_WELCOME_BACK_LINES;
    return {
      greeting: pickLine(lines.aiGreetings, who) ?? null,
      welcomeBack: pickLine(welcome, who) ?? DEFAULT_WELCOME_BACK_LINES[0]!,
    };
  }

  // Restaurant profile for the current call's location.
  app.get('/v1/calls/:callId/tools/profile', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { tenantId, locationId, guestId, fromNumber } = await loadCall(callId);
    const loc = await prisma.location.findUnique({
      where: { id: locationId },
      select: {
        name: true,
        timezone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
        mainPhone: true,
        pickupEnabled: true,
        deliveryEnabled: true,
        // What the read-back and the "ready in…" line quote. The fee and the
        // minimum are charged and enforced by the order route (rule #5); the
        // engine only needs them to say them.
        pickupEtaMinutes: true,
        deliveryEtaMinutes: true,
        deliveryFeeCents: true,
        deliveryMinimumCents: true,
        // The owner's opening lines and welcome-back lines; one of each is
        // chosen for this call below.
        aiGreetings: true,
        welcomeBackLines: true,
        // How this location wants each item confirmed as it is added. It rides
        // on the profile because the engine already loads that once per call,
        // before the first turn — a second request would be a round trip spent
        // on a setting that never changes mid-call.
        aiSettings: { select: { orderAckMode: true, offerMessageWhenClosed: true, guestOrderTextsEnabled: true } },
      },
    });
    if (!loc) throw notFound('Location');
    const { aiSettings, aiGreetings, welcomeBackLines, ...rest } = loc;
    const lines = await chooseLines(locationId, guestId, { aiGreetings, welcomeBackLines });
    // Whether the doors are open, said in facts the engine can speak without
    // doing any date arithmetic of its own. A location with no hours saved
    // reports `hoursKnown: false` and is treated as open — we do not know it is
    // shut, and turning a real caller away on a guess is the worse mistake.
    const now = new Date();
    const schedule = await loadLocationSchedule(locationId, now);
    const closed = schedule ? announcesClosed(schedule) : false;
    // Offer the caller a text when their order is ready: only with the setting
    // on and a caller ID to text. Asked on every call that places an order,
    // because the yes covers only the order it was given for.
    const textable = !!aiSettings?.guestOrderTextsEnabled && !!fromNumber && E164.test(fromNumber);
    return {
      ...rest,
      ...lines,
      guestOrderTexts: { offer: textable },
      orderAckMode: aiSettings?.orderAckMode ?? 'fast',
      openNow: schedule?.state.open ?? true,
      hoursKnown: schedule?.state.known ?? false,
      announceClosed: closed,
      // Read at last: saved since Phase 1 and never consulted by anything.
      offerMessageWhenClosed: aiSettings?.offerMessageWhenClosed ?? true,
      hoursToday: schedule?.hoursToday ?? null,
      nextOpen:
        schedule?.state.nextOpen && schedule
          ? { at: schedule.state.nextOpen.toISOString(), spoken: spokenWhen(schedule.state.nextOpen, now, schedule.tz) }
          : null,
      scheduling: {
        enabled: schedule?.policy.enabled ?? false,
        maxDaysAhead: schedule?.policy.maxDaysAhead ?? 0,
        leadMinutes: schedule?.policy.leadMinutes ?? 0,
        // So "the sixteenth" can be passed as a date. Said, not computed: the
        // model is never the one to work out a date (see resolveRequestedTime).
        today: schedule ? spokenDate(now, schedule.tz) : null,
      },
    };
  });

  /**
   * Something a caller asked for that the menu does not sell.
   *
   * Written from the voice plane because that is the only place that knows a
   * request went unmatched — the engine computes it, tells the caller, and
   * until now forgot it. Ten people a week asking for ketchup is a thing the
   * restaurant would want to know, and nobody was counting.
   *
   * Best-effort by design: the Orchestrator does not wait for this, and a
   * failure here must never touch the call.
   */
  app.post('/v1/calls/:callId/tools/menu-gap', async (request, reply) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { tenantId, locationId } = await loadCall(callId);
    const input = parse(RecordMenuGapInput, request.body);
    const term = normalizeGapTerm(input.term);
    if (!term) return reply.status(204).send();
    await prisma.menuGap.create({
      data: {
        tenantId,
        locationId,
        callId,
        kind: input.kind,
        term,
        rawTerm: input.term.trim().slice(0, 120),
        onItem: input.onItem ?? null,
      },
    });
    return reply.status(201).send({ ok: true });
  });

  // Weekly business hours (minutes-from-midnight, local tz).
  app.get('/v1/calls/:callId/tools/hours', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { locationId } = await loadCall(callId);
    const hours = await prisma.locationHours.findMany({
      where: { locationId },
      orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }],
      select: { dayOfWeek: true, opensAt: true, closesAt: true },
    });
    return { hours };
  });

  /**
   * The time a caller asked for ("can I pick it up at six?"). The API decides
   * (rule #5): it knows the restaurant's timezone, its hours, how long the
   * kitchen needs and how far ahead this location will take an order. A
   * refusal always carries the earliest time that would work, so the bot has
   * something to offer rather than a dead end.
   */
  app.post('/v1/calls/:callId/tools/schedule', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { locationId } = await loadCall(callId);
    const input = parse(ScheduleOrderInput, request.body);
    const now = new Date();
    const schedule = await loadLocationSchedule(locationId, now);
    if (!schedule) throw notFound('Location');

    const at = resolveRequestedTime(input, now, schedule.tz);
    const decision = decideSchedule(at, now, schedule.tz, schedule.hours, schedule.holidays, schedule.policy);
    if (decision.ok) {
      return {
        ok: true as const,
        scheduledFor: decision.at.toISOString(),
        spoken: spokenWhen(decision.at, now, schedule.tz),
      };
    }
    const earliest = decision.earliest
      ? { at: decision.earliest.toISOString(), spoken: spokenWhen(decision.earliest, now, schedule.tz) }
      : null;
    const latest = decision.latest
      ? { at: decision.latest.toISOString(), spoken: spokenWhen(decision.latest, now, schedule.tz) }
      : null;
    return { ok: false as const, reason: decision.reason, earliest, latest, hoursToday: schedule.hoursToday };
  });

  /**
   * The caller said yes to a text when their order is ready (rule #6).
   *
   * The engine speaks the offer itself, word for word (guestOrderTextsOffer),
   * and calls this only after the caller has answered it. The record keeps the
   * words that were spoken — regenerated here, never taken from the node — the
   * caller's own reply, the call, and the order. Then one confirmation text:
   * the written copy of what they agreed to, with how to stop.
   */
  app.post('/v1/calls/:callId/tools/order-texts/consent', async (request, reply) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const input = parse(
      z.object({ orderCode: z.string().min(1).max(12), callerWords: z.string().max(500).optional() }),
      request.body,
    );
    const { tenantId, locationId, fromNumber } = await loadCall(callId);
    const settings = await prisma.locationAiSettings.findUnique({
      where: { locationId },
      select: { guestOrderTextsEnabled: true },
    });
    if (!settings?.guestOrderTextsEnabled) {
      throw new HttpError(409, 'This restaurant does not text guests about orders', 'guest_texts_off');
    }
    if (!fromNumber || !E164.test(fromNumber)) {
      throw new HttpError(409, 'There is no caller number to text', 'no_caller_number');
    }
    const order = await prisma.order.findFirst({
      where: { tenantId, locationId, callId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!order || orderCode(order.id) !== input.orderCode.toUpperCase()) {
      throw new HttpError(404, 'No such order on this call', 'order_not_found');
    }
    const loc = await prisma.location.findUnique({ where: { id: locationId }, select: { name: true } });
    const restaurant = loc?.name ?? 'The restaurant';
    const record = await prisma.smsConsentRecord.create({
      data: {
        tenantId,
        locationId,
        phone: fromNumber,
        purpose: 'guest_order_updates',
        action: 'confirmed',
        source: 'voice_call',
        disclosureVersion: GUEST_ORDER_UPDATES_DISCLOSURE_VERSION,
        disclosureText: guestOrderTextsOffer(restaurant),
        replyText: input.callerWords?.slice(0, 500) ?? null,
        callId,
        orderId: order.id,
      },
    });
    await writeAudit({
      tenantId,
      locationId,
      actorId: null,
      action: 'consent.changed',
      targetType: 'sms_consent',
      targetId: record.id,
      metadata: { purpose: 'guest_order_updates', action: 'confirmed', source: 'voice_call', callId, orderId: order.id },
    });
    const texted = await textGuest(request.log, notifier, {
      tenantId,
      locationId,
      phone: fromNumber,
      orderId: order.id,
      dedupeKey: `guest-texts-confirm:${order.id}`,
      body: guestOrderTextsConfirmationSms(restaurant, orderCode(order.id)),
      request,
    });
    return reply.status(201).send({ consented: true, confirmationSent: texted });
  });

  // Menu item search (available items only). Ranked, not truncated
  // alphabetically: a location with 111 items and a `take` of 25 ordered by name
  // silently dropped everything past the letter B, so asking for "Sgt Peppers"
  // matched it and then discarded it behind "BBQ Chicken Pizza" — and the bot,
  // told nothing came back, said the item was not on the menu. Empty query
  // returns the whole menu, which is what the engine loads to resolve the names
  // the caller says into real items.
  app.get('/v1/calls/:callId/tools/menu', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const q = ((request.query as { q?: string }).q ?? '').trim();
    const { locationId } = await loadCall(callId);

    // A restaurant menu is small enough to rank in memory, and doing it here
    // rather than in SQL buys the token weighting below.
    const rows = await prisma.menuItem.findMany({
      where: { available: true, category: { menu: { locationId, active: true } } },
      // The printed menu's order, so the section a caller hears matches the one
      // on the wall: sections in their configured order, items by name within.
      orderBy: [{ category: { sortOrder: 'asc' } }, { category: { name: 'asc' } }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        priceCents: true,
        ingredients: true,
        // Which section of the menu this item sits in. Without it a "Sausage"
        // under Hot Subs and a pizza are the same undifferentiated line to the
        // bot: on a real call (2026-08-31) "one sausage pizza" matched the sub
        // and the caller was asked to choose its cheese and sauce.
        category: { select: { name: true } },
        // The choices the caller has to make for this item, and what each one
        // costs. Without these the bot could take an order for a pizza without
        // ever asking which crust, and the ticket reached the kitchen with the
        // answer buried in free text.
        modifierGroups: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            selectionType: true,
            required: true,
            minSelections: true,
            maxSelections: true,
            allowsHalves: true,
            halfPricing: true,
            modifiers: {
              where: { available: true },
              orderBy: { name: 'asc' },
              select: { id: true, name: true, priceCents: true },
            },
          },
        },
      },
    });
    const all = rows.map(({ category, ...item }) => ({ ...item, category: category.name }));

    const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    if (!tokens.length) return { items: all };

    // Weight each token by how rare it is on THIS menu. Without that, "pizza" in
    // "Sargent Pepper pizza" counts as much as "pepper" while matching half the
    // menu, and the one item the caller actually named ranks no higher than
    // every other pizza.
    const hits = (t: string) =>
      all.filter((i) => `${i.name} ${i.description ?? ''}`.toLowerCase().includes(t)).length;
    const weights = new Map(tokens.map((t) => [t, 1 / (1 + hits(t))]));

    const scored = all
      .map((item) => {
        const name = item.name.toLowerCase();
        const desc = (item.description ?? '').toLowerCase();
        let score = 0;
        for (const t of tokens) {
          const w = weights.get(t) ?? 0;
          // A name match is what the caller said; a description match is a hint.
          if (name.includes(t)) score += 3 * w;
          else if (desc.includes(t)) score += w;
        }
        if (name === q.toLowerCase()) score += 10;
        else if (name.startsWith(q.toLowerCase())) score += 5;
        return { item, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

    // Nothing matched at all → the whole menu, so the bot offers real
    // alternatives instead of claiming the item does not exist.
    return { items: scored.length ? scored.slice(0, 25).map((s) => s.item) : all };
  });

  // Transfer destinations for the call's location, each resolved to a REFER URI.
  // The LLM picks one by `key` based on caller intent.
  app.get('/v1/calls/:callId/tools/transfer-targets', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { locationId } = await loadCall(callId);
    const domain = loadConfig().BRAYZ_TRANSFER_SIP_DOMAIN;
    const rows = await prisma.locationTransferTarget.findMany({
      where: { locationId, enabled: true },
      orderBy: { sortOrder: 'asc' },
      select: { key: true, label: true, description: true, destination: true },
    });
    const targets = rows
      .map((t) => ({ key: t.key, label: t.label, description: t.description, sipUri: toSipUri(t.destination, domain) }))
      .filter((t): t is { key: string; label: string; description: string | null; sipUri: string } => t.sipUri != null);
    return { targets };
  });

  /**
   * A message the caller leaves for the restaurant. Saved first, as its own
   * row the Messages screen works from, then the restaurant is texted —
   * best-effort, recorded on the row as notifiedAt so the screen can say
   * whether anyone was told. The callback number defaults to the number the
   * caller is on: the bot is told not to make them read it out.
   */
  app.post('/v1/calls/:callId/tools/message', async (request, reply) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const input = parse(TakeMessageInput, request.body);
    const { tenantId, locationId, fromNumber } = await loadCall(callId);
    const callbackNumber = input.callbackNumber?.trim() || fromNumber || null;
    const message = await prisma.callMessage.create({
      data: {
        tenantId,
        locationId,
        callId,
        callerName: input.callerName?.trim() || null,
        callbackNumber,
        body: input.message.trim(),
      },
    });
    // On the call's own timeline too, so the Calls screen shows it with the call.
    await prisma.callEvent.create({
      data: {
        callId,
        eventType: 'call.message',
        payload: { messageId: message.id, callerName: message.callerName, callbackNumber, body: message.body } as Prisma.InputJsonValue,
      },
    });
    const loc = await prisma.location.findUnique({ where: { id: locationId }, select: { name: true } });
    const sent = await textLocation(request.log, notifier, {
      tenantId,
      locationId,
      dedupeKey: `message:${message.id}`,
      body: buildMessageSms({ restaurantName: loc?.name, callerName: message.callerName, callbackNumber, body: message.body }),
      request,
    });
    if (sent) await prisma.callMessage.update({ where: { id: message.id }, data: { notifiedAt: new Date() } });
    return reply.status(201).send({ id: message.id, callbackNumber, notified: sent });
  });

  /**
   * Add-ons worth offering for what is in the order so far. The Orchestrator
   * sends the current draft; the API matches it against the live menu's upsell
   * tags and prices the result (rule #5).
   */
  app.post('/v1/calls/:callId/tools/upsell', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { lines } = parse(
      z.object({
        lines: z
          .array(z.object({ menuItemId: z.string().uuid().optional(), name: z.string().min(1) }))
          .max(50),
      }),
      request.body,
    );
    const call = await loadCall(callId);
    return { suggestions: await upsellsForOrder(call.locationId, lines) };
  });

  // ---- Guest memory (rule #6: gates enforced here, in code) ----

  // Is this a recognized returning caller, and how much may the bot personalize?
  // Returns isReturning:false (no name leaked) when memory is off or the guest opted out.
  app.get('/v1/calls/:callId/tools/guest', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { locationId: true, guestId: true },
    });
    if (!call) throw notFound('Call');
    const mode = await locationGuestMemoryMode(call.locationId);
    if (!call.guestId || mode === 'off') return { isReturning: false, mode };
    const guest = await prisma.guest.findUnique({
      where: { id: call.guestId },
      select: { displayName: true, memoryEnabled: true, deliveryAddress: true },
    });
    if (!guest || !guest.memoryEnabled) return { isReturning: false, mode };
    const saved = DeliveryAddress.safeParse(guest.deliveryAddress);
    // Full mode trusts the caller-id match with the address, as it already does
    // with the name and "the usual". Confirm mode is told only that there is
    // one: the address itself waits for the caller to give its street number
    // (/tools/guest/address/confirm) — rule #6.
    const addressFields = {
      hasSavedAddress: saved.success,
      savedAddress: mode === 'full' && saved.success ? saved.data : null,
    };
    // VIP status rides along so the engine can thank VIP regulars in the greeting.
    const [settings, account] = await Promise.all([
      locationLoyaltySettings(call.locationId),
      prisma.loyaltyAccount.findUnique({
        where: { guestId: call.guestId },
        select: { lifetimeSpendCents: true },
      }),
    ]);
    const vip = settings.enabled && isVip(account?.lifetimeSpendCents ?? 0, settings);
    return { isReturning: true, displayName: guest.displayName, mode, vip, ...addressFields };
  });

  // Saved preferences + "the usual" + recent orders. Withheld (403) when memory is
  // off or the guest opted out; in 'confirm' mode the prompt gates this behind the
  // caller confirming who they are.
  app.get('/v1/calls/:callId/tools/guest/details', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { guestId: true, locationId: true },
    });
    if (!call) throw notFound('Call');
    const mode = await locationGuestMemoryMode(call.locationId);
    if (!call.guestId || mode === 'off') {
      throw new HttpError(403, 'Guest memory is not available', 'guest_memory_unavailable');
    }
    const guest = await prisma.guest.findUnique({
      where: { id: call.guestId },
      select: { displayName: true, notes: true, memoryEnabled: true },
    });
    if (!guest || !guest.memoryEnabled) {
      throw new HttpError(403, 'Guest memory is not available', 'guest_memory_unavailable');
    }
    const orders = await prisma.order.findMany({
      where: { guestId: call.guestId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { createdAt: true, items: { select: { name: true, quantity: true } } },
    });
    return {
      displayName: guest.displayName,
      notes: guest.notes,
      usual: computeUsual(orders),
      recentOrders: orders.map((o) => ({
        when: o.createdAt,
        items: o.items.map((i) => `${i.quantity} ${i.name}`),
      })),
    };
  });

  // Save something the bot learned (the caller's name and/or a preference note).
  // Creates the guest by caller-id if needed; no-ops (saved:false) when off/opted out.
  app.post('/v1/calls/:callId/tools/guest/memory', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { name, note, birthdayMonth, birthdayDay } = parse(
      z.object({
        name: z.string().max(120).optional(),
        note: z.string().max(2000).optional(),
        birthdayMonth: z.number().int().min(1).max(12).optional(),
        birthdayDay: z.number().int().min(1).max(31).optional(),
      }),
      request.body,
    );
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { tenantId: true, locationId: true, guestId: true, fromNumber: true },
    });
    if (!call) throw notFound('Call');
    const mode = await locationGuestMemoryMode(call.locationId);
    if (mode === 'off') return { saved: false, reason: 'memory_off' };
    if (!name?.trim() && !note?.trim() && !birthdayMonth) return { saved: false, reason: 'empty' };

    let guestId = call.guestId ?? undefined;
    if (!guestId) {
      if (!call.fromNumber) return { saved: false, reason: 'no_caller_id' };
      guestId = await resolveOrCreateGuest(call.tenantId, call.locationId, call.fromNumber, name?.trim());
      await prisma.call.update({ where: { id: callId }, data: { guestId } }).catch(() => {});
    }

    const guest = await prisma.guest.findUnique({
      where: { id: guestId },
      select: { notes: true, displayName: true, memoryEnabled: true },
    });
    if (!guest || !guest.memoryEnabled) return { saved: false, reason: 'opted_out' };

    const nextNotes = note?.trim()
      ? `${guest.notes ? `${guest.notes}\n` : ''}${note.trim()}`
      : guest.notes;
    await prisma.guest.update({
      where: { id: guestId },
      data: {
        displayName: name?.trim() ? name.trim() : undefined,
        notes: nextNotes ?? undefined,
        birthdayMonth: birthdayMonth ?? undefined,
        birthdayDay: birthdayDay ?? undefined,
      },
    });
    await writeAudit({
      tenantId: call.tenantId,
      locationId: call.locationId,
      action: 'guest.memory.updated',
      targetType: 'guest',
      targetId: guestId,
      metadata: {
        via: 'voice',
        setName: !!name?.trim(),
        addedNote: !!note?.trim(),
        setBirthday: !!birthdayMonth,
      },
    });
    return { saved: true };
  });

  // Is this address inside the delivery area, and what would delivery cost?
  // Asked while the caller is still on the line, so the bot can say so before
  // the read-back instead of the order being refused after it. The order route
  // asks the same question again when the order is placed (rule #5).
  app.post('/v1/calls/:callId/tools/delivery/check', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { address } = parse(z.object({ address: DeliveryAddress }), request.body);
    const { locationId } = await loadCall(callId);
    const loc = await prisma.location.findUnique({
      where: { id: locationId },
      select: {
        ...DELIVERY_LOCATION_SELECT,
        deliveryEnabled: true,
        deliveryFeeCents: true,
        deliveryMinimumCents: true,
        deliveryEtaMinutes: true,
      },
    });
    if (!loc) throw notFound('Location');
    const quote = {
      feeCents: loc.deliveryFeeCents,
      minimumCents: loc.deliveryMinimumCents,
      etaMinutes: loc.deliveryEtaMinutes,
      radiusMiles: loc.deliveryRadiusMiles,
    };
    if (!loc.deliveryEnabled) {
      return { deliverable: false, check: 'delivery_off', distanceMiles: null, postalCode: null, ...quote };
    }
    const area = await checkDeliveryArea(loc, address, geocoder);
    // Logged because an area decision that looks wrong afterwards can otherwise
    // only be investigated by running the call again (2026-09-11).
    request.log.info(
      {
        callId,
        locationId,
        check: area.check,
        deliverable: area.deliverable,
        distanceMiles: area.distanceMiles,
        zip: area.zip,
        matchedZip: area.matchedZip,
        matchedAddress: area.matchedAddress,
        zipMismatch: area.zipMismatch,
      },
      'delivery area checked',
    );
    return {
      deliverable: area.deliverable,
      check: area.check,
      distanceMiles: area.distanceMiles,
      postalCode: area.zip,
      ...quote,
    };
  });

  /**
   * Confirm mode's stand-in for reading a saved address out loud: the caller
   * gives the street number of their usual delivery address, and only a match
   * gets the address back (rule #6 — a caller-id match alone is not enough to
   * say where someone lives). Two wrong numbers and it is not offered again on
   * this call. Each miss is a call event, so the count is the call's, not one
   * API instance's.
   */
  app.post('/v1/calls/:callId/tools/guest/address/confirm', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { streetNumber } = parse(
      z.object({ streetNumber: z.string().trim().min(1).max(40) }),
      request.body,
    );
    const call = await loadCall(callId);
    const mode = await locationGuestMemoryMode(call.locationId);
    if (!call.guestId || mode === 'off') {
      throw new HttpError(403, 'Guest memory is not available', 'guest_memory_unavailable');
    }
    const guest = await prisma.guest.findUnique({
      where: { id: call.guestId },
      select: { memoryEnabled: true, deliveryAddress: true },
    });
    if (!guest || !guest.memoryEnabled) {
      throw new HttpError(403, 'Guest memory is not available', 'guest_memory_unavailable');
    }
    const saved = DeliveryAddress.safeParse(guest.deliveryAddress);
    if (!saved.success) return { confirmed: false, reason: 'no_saved_address' };

    const misses = await prisma.callEvent.count({
      where: { callId, eventType: 'guest.address_confirm_failed' },
    });
    if (misses >= ADDRESS_CONFIRM_ATTEMPTS) return { confirmed: false, reason: 'locked', attemptsLeft: 0 };
    const said = houseNumber(streetNumber);
    // "Twelve" rather than "12": nothing to compare yet, and not a wrong answer.
    if (!said) {
      return { confirmed: false, reason: 'unreadable', attemptsLeft: ADDRESS_CONFIRM_ATTEMPTS - misses };
    }
    if (said !== houseNumber(saved.data.line1)) {
      await prisma.callEvent.create({
        data: { callId, eventType: 'guest.address_confirm_failed', payload: {} as Prisma.InputJsonValue },
      });
      return {
        confirmed: false,
        reason: 'mismatch',
        attemptsLeft: Math.max(0, ADDRESS_CONFIRM_ATTEMPTS - misses - 1),
      };
    }
    await writeAudit({
      tenantId: call.tenantId,
      locationId: call.locationId,
      action: 'guest_profile.accessed',
      targetType: 'guest',
      targetId: call.guestId,
      metadata: { via: 'voice', field: 'deliveryAddress', confirmedBy: 'street_number' },
    });
    return { confirmed: true, address: saved.data };
  });
}

/**
 * One key per thing asked for, so ten spellings count as ten asks for the same
 * thing. Lowercased, punctuation dropped, and a leading article removed — "a
 * ketchup" and "Ketchup!" are the same request to a restaurant deciding whether
 * to stock it.
 */
export function normalizeGapTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the|some|extra|side of|order of)\s+/, '')
    .trim()
    .slice(0, 120);
}

/** The text the restaurant gets when a caller leaves a message. Short: it is read on a phone in a kitchen. */
export function buildMessageSms(m: {
  restaurantName?: string | null;
  callerName?: string | null;
  callbackNumber?: string | null;
  body: string;
}): string {
  const who = m.callerName ? m.callerName : 'A caller';
  const reach = m.callbackNumber ? ` (${m.callbackNumber})` : '';
  const text = m.body.length > 240 ? `${m.body.slice(0, 239)}…` : m.body;
  return `${m.restaurantName ? `${m.restaurantName}: ` : ''}Message from ${who}${reach}: ${text} — Brayz`;
}
