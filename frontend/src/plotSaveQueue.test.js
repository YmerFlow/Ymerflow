import { describe, expect, it } from 'vitest';
import { createSaveQueue } from './plotSaveQueue';

// A saver that records its calls and writes when `changed` says so.
function saver(log, name, changed = () => true) {
  return () => { log.push(name); return changed(); };
}

describe('createSaveQueue', () => {
  it('writes one plot at a time, the next only once the previous reports back', () => {
    const q = createSaveQueue();
    const log = [];
    q.add('a', saver(log, 'a'));
    q.add('b', saver(log, 'b'));

    q.saveAll();
    expect(log).toEqual(['a']);
    q.saved('b');              // not the plot being waited for
    expect(log).toEqual(['a']);
    q.saved('a');
    expect(log).toEqual(['a', 'b']);
  });

  it('goes straight on past plots with nothing to write', () => {
    const q = createSaveQueue();
    const log = [];
    q.add('a', saver(log, 'a', () => false));
    q.add('b', saver(log, 'b', () => false));
    q.add('c', saver(log, 'c'));

    q.saveAll();
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('adds to a queue in flight instead of restarting it', () => {
    const q = createSaveQueue();
    const log = [];
    q.add('a', saver(log, 'a'));
    q.add('b', saver(log, 'b'));

    q.saveAll();               // a writes, b waits
    q.saveAll();               // a again goes to the back; nothing writes yet
    expect(log).toEqual(['a']);
    q.saved('a');
    expect(log).toEqual(['a', 'b']);
    q.saved('b');
    expect(log).toEqual(['a', 'b', 'a']);
  });

  it('carries on when the plot being waited for is removed', () => {
    const q = createSaveQueue();
    const log = [];
    q.add('a', saver(log, 'a'));
    q.add('b', saver(log, 'b'));
    q.add('c', saver(log, 'c'));

    q.saveAll();
    q.remove('b');             // queued, never asked
    q.remove('a');             // being waited for
    expect(log).toEqual(['a', 'c']);
  });
});
