import type { EventBus, EventHandler, EventMap, EventName, Unsubscribe } from './types';

type AnyHandler = (payload: never) => void;

/**
 * Typed synchronous event bus. Handlers run in subscription order. A throwing handler is caught and
 * handed to `onError` so it can never break the emitter or the remaining handlers.
 */
export function createEventBus(onError?: (name: string, error: unknown) => void): EventBus {
  const table = new Map<EventName, AnyHandler[]>();
  /** Nesting depth of emit() per event name: lists are copied on write while being iterated. */
  const emitting = new Map<EventName, number>();

  const listFor = (name: EventName, forWrite: boolean): AnyHandler[] => {
    let list = table.get(name);
    if (!list) {
      list = [];
      table.set(name, list);
    } else if (forWrite && (emitting.get(name) ?? 0) > 0) {
      list = list.slice();
      table.set(name, list);
    }
    return list;
  };

  const off = <K extends EventName>(name: K, handler: EventHandler<K>): void => {
    const current = table.get(name);
    if (!current) return;
    const i = current.indexOf(handler as AnyHandler);
    if (i < 0) return;
    listFor(name, true).splice(i, 1);
  };

  const on = <K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe => {
    listFor(name, true).push(handler as AnyHandler);
    return () => off(name, handler);
  };

  const once = <K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe => {
    const wrapper: EventHandler<K> = (payload) => {
      off(name, wrapper);
      handler(payload);
    };
    return on(name, wrapper);
  };

  const emit = <K extends EventName>(name: K, payload: EventMap[K]): void => {
    const list = table.get(name);
    if (!list || list.length === 0) return;
    emitting.set(name, (emitting.get(name) ?? 0) + 1);
    try {
      for (let i = 0; i < list.length; i++) {
        try {
          (list[i] as (p: EventMap[K]) => void)(payload);
        } catch (error) {
          if (onError) onError(name, error);
          else console.error(`[events] handler for "${name}" threw`, error);
        }
      }
    } finally {
      emitting.set(name, (emitting.get(name) ?? 1) - 1);
    }
  };

  return { on, once, off, emit };
}
