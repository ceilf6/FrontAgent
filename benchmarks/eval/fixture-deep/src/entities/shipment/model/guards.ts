import type { Shipment } from './shipment.js';

export const isShipment = (value: unknown): value is Shipment =>
  typeof value === 'object' && value !== null && 'id' in value;
