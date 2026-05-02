import type { PaymentEvent, AnalyticsPlugin } from './types.js';

export class ConsoleAnalytics implements AnalyticsPlugin {
  emit(event: PaymentEvent): void {
    const { timestamp, ...rest } = event;
    console.log('[n-payment]', JSON.stringify({ ...rest, time: new Date(timestamp).toISOString() }));
  }
}

export class AnalyticsEmitter {
  private plugins: AnalyticsPlugin[];

  constructor(plugins?: AnalyticsPlugin[]) {
    this.plugins = plugins?.length ? plugins : [new ConsoleAnalytics()];
  }

  emit(event: PaymentEvent): void {
    for (const plugin of this.plugins) {
      try {
        plugin.emit(event);
      } catch {
        // Never let analytics crash the payment flow
      }
    }
  }
}
