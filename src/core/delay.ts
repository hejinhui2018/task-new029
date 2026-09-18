import type { Bus, Scheduler } from './types';

/**
 * 出站/入站消息包装器，用于现场验收：
 *  - delayMs：模拟网络抖动，延迟转发（休眠时随调度器一起冻结投递）；
 *  - duplicate：每条消息额外重发一份，验证接收端按命令 ID 幂等去重。
 *
 * 它本身仍是一个 Bus，核心逻辑无感知，生产与测试都可以注入。
 */
export class DelayedBus implements Bus {
  private handlers = new Set<(message: unknown) => void>();
  private outboundDelay = 0;
  private inboundDelay = 0;
  private duplicateEnabled = false;
  private unsubscribe: () => void;

  constructor(
    private inner: Bus,
    private scheduler: Scheduler,
  ) {
    this.unsubscribe = inner.on((message) => {
      this.scheduleInbound(message);
    });
  }

  setDelay(ms: number): void {
    this.outboundDelay = Math.max(0, ms);
    this.inboundDelay = Math.max(0, ms);
  }

  getDelay(): number {
    return this.outboundDelay;
  }

  setDuplicate(enabled: boolean): void {
    this.duplicateEnabled = enabled;
  }

  isDuplicateEnabled(): boolean {
    return this.duplicateEnabled;
  }

  post(message: unknown): void {
    this.scheduleOutbound(message, 0);
    if (this.duplicateEnabled) {
      // 副本略微错开，模拟真实重传。
      this.scheduleOutbound(message, 1);
    }
  }

  on(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.unsubscribe();
    this.handlers.clear();
  }

  private scheduleOutbound(message: unknown, extra: number): void {
    if (this.outboundDelay + extra === 0) {
      this.inner.post(message);
      return;
    }
    this.scheduler.setTimeout(() => {
      this.inner.post(message);
    }, this.outboundDelay + extra);
  }

  private scheduleInbound(message: unknown): void {
    if (this.inboundDelay === 0) {
      this.dispatch(message);
      return;
    }
    this.scheduler.setTimeout(() => {
      this.dispatch(message);
    }, this.inboundDelay);
  }

  private dispatch(message: unknown): void {
    this.handlers.forEach((handler) => handler(message));
  }
}
