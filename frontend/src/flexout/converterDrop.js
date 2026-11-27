// Generic converter-drop seam for flexout. flexout learns nothing about datasets
// or any specific widget: the app injects an ordered list of converters via the
// LayoutProvider `converters` prop. A converter is `{ accept, convert }` where
// `convert(item, dragType) => node | null`. On a non-'pane' drop onto a converter
// target, flexout tries the converters in order and places the first non-null node;
// all-null → not droppable. The ORIGINAL drop is stashed (keyed by the new node's
// id) and replayed once the produced widget mounts via useSimulatedDrop.
import { useCallback, useContext, useMemo, useEffect, useRef } from 'react';
import { useDrop } from 'react-dnd';
import { v4 as uuidv4 } from 'uuid';
import { LayoutContext } from './LayoutContext';

// Drop target that turns a non-'pane' drag into a layout node via the injected
// converters, stashes the ORIGINAL drop for replay, and places the node.
// `place(node)` is supplied by the caller (Empty → replace self; TabSet → add tab).
export function useConverterDrop(place) {
  const { converters, setSimulatedDrop } = useContext(LayoutContext);

  const accept = useMemo(
    () => [...new Set(converters.flatMap(c => [].concat(c.accept)))],
    [converters]);

  const build = useCallback((item, dragType, offset) => {
    for (const c of converters) {
      if (![].concat(c.accept).includes(dragType)) continue;
      const node = c.convert(item, dragType);
      if (node) return { node, offset };
    }
    return null;
  }, [converters]);

  const [{ isOver }, drop] = useDrop({
    accept: accept.length ? accept : '__none__',
    canDrop: (item, m) => !!build(item, m.getItemType(), null),
    drop: (item, m) => {
      if (m.didDrop()) return;
      const built = build(item, m.getItemType(), m.getClientOffset());
      if (!built) return;
      const id = uuidv4();
      const finalNode = { ...built.node, id };          // flexout owns the id
      setSimulatedDrop(id, { item, dragType: m.getItemType(), offset: built.offset });
      place(finalNode);
      return {};
    },
    collect: (m) => ({ isOver: m.isOver({ shallow: true }) && m.canDrop() }),
  }, [accept, build, place, setSimulatedDrop]);

  return { drop, isOver };
}

// Receiver side: a widget opts in to receive the simulated drop for its node by
// calling this hook. The stored drop (if any) is delivered once on mount.
export function useSimulatedDrop(nodeId, onDrop) {
  const { takeSimulatedDrop } = useContext(LayoutContext);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  useEffect(() => {
    const d = takeSimulatedDrop(nodeId);                // consume-once on mount
    if (d) onDropRef.current(d.item, d.dragType, d.offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);
}
