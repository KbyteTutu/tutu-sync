/**
 * 极简互斥锁：wg0.conf 的读改写、注册码兑换与 peer 签发必须串行。
 * 服务是单进程单容器，进程内串行化即可，不引入跨进程锁。
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
