import React, { useContext } from 'react';
import { LayoutProvider, LayoutContext } from './LayoutContext';
import Pane from './components/Pane';
import { useIsMobile } from '../hooks/useIsMobile';

export function MainLayout() {
  const { layout, updateLayout } = useContext(LayoutContext);
  const isMobile = useIsMobile();

  // root-level parentUpdate simply replaces the root layout
  const rootParentUpdate = (action, id, newNode) => {
    if (action === 'replace') updateLayout(newNode);
    if (action === 'remove') updateLayout({ type: 'pane', id: 'root', content: { widget: 'ClockWidget' } });
  };

  // display: contents keeps the wrapper out of the layout; it only scopes the flex view styles.
  return (
    <div className={layout.flexView && !isMobile ? 'flex-view' : undefined} style={{ display: 'contents' }}>
      <Pane parentUpdate={rootParentUpdate} {...layout} />
    </div>
  );
}
