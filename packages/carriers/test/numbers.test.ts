import { describe, expect, it } from 'vitest';
import {
  CarrierNotConfiguredError,
  TwilioNumberProvisioner,
  getTwilioClient,
  type TwilioLike,
} from '../src/numbers.js';

// A fake Twilio client capturing the args the provisioner sends.
function fakeClient(): { client: TwilioLike; calls: { search?: unknown; create?: unknown } } {
  const calls: { search?: unknown; create?: unknown } = {};
  const client: TwilioLike = {
    availablePhoneNumbers: () => ({
      local: {
        list: async (opts) => {
          calls.search = opts;
          return [
            { phoneNumber: '+15185550142', friendlyName: '(518) 555-0142', locality: 'Albany', region: 'NY', postalCode: '12207' },
          ];
        },
      },
    }),
    incomingPhoneNumbers: {
      create: async (opts) => {
        calls.create = opts;
        return { sid: 'PN123', phoneNumber: opts.phoneNumber };
      },
    },
  };
  return { client, calls };
}

describe('TwilioNumberProvisioner', () => {
  it('maps a search query to the Twilio SDK and normalizes results', async () => {
    const { client, calls } = fakeClient();
    const p = new TwilioNumberProvisioner({ client });
    const results = await p.searchAvailable({ areaCode: '518', region: 'NY', limit: 5 });

    expect(calls.search).toMatchObject({ areaCode: 518, inRegion: 'NY', voiceEnabled: true, limit: 5 });
    expect(results).toEqual([
      { e164Number: '+15185550142', friendlyName: '(518) 555-0142', locality: 'Albany', region: 'NY', postalCode: '12207' },
    ]);
  });

  it('provisions by purchasing and attaching to the configured trunk', async () => {
    const { client, calls } = fakeClient();
    const p = new TwilioNumberProvisioner({ client, trunkSid: 'TKtrunk' });
    const result = await p.provision('+15185550142');

    expect(calls.create).toEqual({ phoneNumber: '+15185550142', trunkSid: 'TKtrunk' });
    expect(result).toEqual({ e164Number: '+15185550142', providerNumberId: 'PN123' });
  });

  it('getTwilioClient throws when credentials are missing', () => {
    expect(() => getTwilioClient({})).toThrow(CarrierNotConfiguredError);
  });
});
