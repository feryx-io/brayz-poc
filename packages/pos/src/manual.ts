import {
  PosCapabilityError,
  type PosCapabilities,
  type PosConnection,
  type PosMenuItem,
  type PosOrder,
  type PosOrderResult,
  type PosProvider,
  type PosProviderName,
} from './index.js';

/**
 * The no-POS path: most independent restaurants run the ticket off the printer
 * and the order-confirmation SMS. This adapter exists so that "no POS" is a
 * provider like any other rather than a null check scattered through the order
 * flow — the sync record is written either way, so the Orders screen shows the
 * same "ticket raised" state whether or not a POS is connected.
 */
export class ManualTicketProvider implements PosProvider {
  readonly name: PosProviderName = 'manual';
  readonly capabilities: PosCapabilities = {
    createOrder: true,
    updateOrderStatus: true,
    getMenu: false,
    syncMenu: false,
  };

  async createOrder(_conn: PosConnection, order: PosOrder): Promise<PosOrderResult> {
    // The Brayz code the guest was told on the call is the ticket number.
    return { externalOrderId: `manual:${order.orderCode}` };
  }

  async updateOrderStatus(): Promise<void> {
    // Nothing downstream to tell; Brayz's own status is the record.
  }

  async getMenu(): Promise<PosMenuItem[]> {
    throw new PosCapabilityError(this.name, 'getMenu');
  }

  async syncMenu(): Promise<void> {
    throw new PosCapabilityError(this.name, 'syncMenu');
  }
}
