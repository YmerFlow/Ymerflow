import { describe, expect, it, vi } from 'vitest';
import { createReadoutStore } from './readoutStore';

describe('createReadoutStore', () => {
  it('gives a new subscriber the current readout', () => {
    const store = createReadoutStore();
    store.publish({ coords: 'xdist_m: 1200.0' });
    const listener = vi.fn();
    store.subscribe(listener);
    expect(listener).toHaveBeenCalledWith({ coords: 'xdist_m: 1200.0', pick: '' });
  });

  it('merges coords and pick updates and tells every subscriber', () => {
    const store = createReadoutStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.publish({ coords: 'x' });
    store.publish({ pick: 'pt 3' });
    expect(a).toHaveBeenLastCalledWith({ coords: 'x', pick: 'pt 3' });
    expect(b).toHaveBeenLastCalledWith({ coords: 'x', pick: 'pt 3' });
  });

  it('stops calling a listener after it unsubscribes', () => {
    const store = createReadoutStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.publish({ coords: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
