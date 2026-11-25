import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TwilioSmsSender,
  normalizeTwilioInboundSms,
  normalizeTwilioSmsStatus,
  validTwilioSignature,
} from '../src/notifications.js';
import { CarrierNotConfiguredError, type TwilioLike } from '../src/numbers.js';

// A fake Twilio client capturing what the sender asks it to send.
function fakeClient(): { client: TwilioLike; sent: unknown[] } {
  const sent: unknown[] = [];
  const client: TwilioLike = {
    availablePhoneNumbers: () => ({ local: { list: async () => [] } }),
    incomingPhoneNumbers: { create: async (o) => ({ sid: 'PN1', phoneNumber: o.phoneNumber }) },
    messages: {
      create: async (opts) => {
        sent.push(opts);
        return { sid: 'SM1' };
      },
    },
  };
  return { client, sent };
}

describe('TwilioSmsSender', () => {
  it("sends from the message's own number — a restaurant's line — over the default", async () => {
    const { client, sent } = fakeClient();
    const sender = new TwilioSmsSender({ client, from: '+15185550000' });
    await sender.sendSms({ to: '+15185551234', from: '+15185550104', body: 'hi' });
    expect(sent[0]).toEqual({ to: '+15185551234', from: '+15185550104', body: 'hi' });
  });

  it('falls back to the configured default when the message names no sender', async () => {
    const { client, sent } = fakeClient();
    const sender = new TwilioSmsSender({ client, from: '+15185550000' });
    await sender.sendSms({ to: '+15185551234', body: 'hi' });
    expect(sent[0]).toEqual({ to: '+15185551234', from: '+15185550000', body: 'hi' });
  });

  it('prefers a messaging service, which owns sender selection and compliance', async () => {
    const { client, sent } = fakeClient();
    const sender = new TwilioSmsSender({ client, messagingServiceSid: 'MG1' });
    await sender.sendSms({ to: '+15185551234', from: '+15185550104', body: 'hi' });
    expect(sent[0]).toEqual({ to: '+15185551234', messagingServiceSid: 'MG1', body: 'hi' });
  });

  it('refuses to send with no sender at all', async () => {
    const { client, sent } = fakeClient();
    const sender = new TwilioSmsSender({ client });
    await expect(sender.sendSms({ to: '+15185551234', body: 'hi' })).rejects.toBeInstanceOf(CarrierNotConfiguredError);
    expect(sent).toHaveLength(0);
  });
});

describe('SMS delivery reports', () => {
  it('asks the provider to report delivery when given a callback', async () => {
    const { client, sent } = fakeClient();
    const sender = new TwilioSmsSender({ client, messagingServiceSid: 'MG1' });
    await sender.sendSms({ to: '+15185551234', body: 'hi', statusCallback: 'https://api.example.com/v1/carriers/twilio/sms-status' });
    expect(sent[0]).toMatchObject({ statusCallback: 'https://api.example.com/v1/carriers/twilio/sms-status' });
  });

  it("reads Twilio's statuses into Brayz's", async () => {
    expect(normalizeTwilioSmsStatus({ MessageSid: 'SM1', MessageStatus: 'delivered' })).toEqual({
      providerMessageId: 'SM1',
      status: 'delivered',
      errorCode: null,
    });
    expect(normalizeTwilioSmsStatus({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30034' })).toMatchObject({
      status: 'undelivered',
      errorCode: '30034',
    });
    expect(normalizeTwilioSmsStatus({ MessageSid: 'SM1', MessageStatus: 'sending' })?.status).toBe('queued');
    expect(normalizeTwilioSmsStatus({ MessageSid: 'SM1', MessageStatus: 'receiving' })).toBeNull();
    expect(normalizeTwilioSmsStatus({ MessageStatus: 'delivered' })).toBeNull();
  });

  it("checks Twilio's signature over the URL and the sorted fields", () => {
    const url = 'https://api.example.com/v1/carriers/twilio/sms-status';
    const params = { MessageStatus: 'delivered', MessageSid: 'SM1', AccountSid: 'AC1' };
    const data = `${url}AccountSidAC1MessageSidSM1MessageStatusdelivered`;
    const good = createHmac('sha1', 'token').update(data).digest('base64');
    expect(validTwilioSignature('token', url, params, good)).toBe(true);
    expect(validTwilioSignature('other', url, params, good)).toBe(false);
    expect(validTwilioSignature('token', url, { ...params, MessageStatus: 'failed' }, good)).toBe(false);
    expect(validTwilioSignature('token', `${url}?x=1`, params, good)).toBe(false);
    expect(validTwilioSignature('token', url, params, undefined)).toBe(false);
  });
});

describe('Inbound texts', () => {
  it("reads a reply and Twilio's own opt-out verdict", () => {
    expect(
      normalizeTwilioInboundSms({ MessageSid: 'SM9', From: '+15185557701', To: '+15185550104', Body: 'YES', OptOutType: 'START' }),
    ).toEqual({ providerMessageId: 'SM9', from: '+15185557701', to: '+15185550104', text: 'YES', providerKeyword: 'opt_in' });
    expect(normalizeTwilioInboundSms({ MessageSid: 'SM9', From: '+1', To: '+2', Body: 'stop', OptOutType: 'STOP' })?.providerKeyword).toBe('opt_out');
    expect(normalizeTwilioInboundSms({ MessageSid: 'SM9', From: '+1', To: '+2', Body: 'hello' })?.providerKeyword).toBeNull();
    expect(normalizeTwilioInboundSms({ From: '+1', To: '+2', Body: 'YES' })).toBeNull();
  });
});
