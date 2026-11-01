import { describe, expect, it } from 'vitest';
import { createReadoutStore } from './plotReadoutStore';

describe('createReadoutStore', () => {
  it('delivers published readouts to every subscriber', () => {
    const store = createReadoutStore();
    const a = [];
    const b = [];
    store.subscribe(r => a.push(r));
    store.subscribe(r => b.push(r));

    store.publish({ coords: 'x: 1' });
    store.publish({ pick: 'pt 3' });

    expect(a).toEqual([{ coords: 'x: 1' }, { pick: 'pt 3' }]);
    expect(b).toEqual([{ coords: 'x: 1' }, { pick: 'pt 3' }]);
  });

  it('stops delivering after unsubscribe', () => {
    const store = createReadoutStore();
    const seen = [];
    const unsub = store.subscribe(r => seen.push(r));

    store.publish({ coords: 'a' });
    unsub();
    store.publish({ coords: 'b' });

    expect(seen).toEqual([{ coords: 'a' }]);
  });

  it('does not throw when publishing with no subscribers', () => {
    const store = createReadoutStore();
    expect(() => store.publish({ coords: 'x' })).not.toThrow();
  });
});
