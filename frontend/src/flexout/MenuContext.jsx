import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from "react";

const MenuContext = createContext();

export function useRegisterMenu(path, action, position = 1, active = false) {
  const { registerMenu } = useMenu();
  const ref = useRef(action);
  ref.current = action;

  useEffect(() => {
    registerMenu(path, () => ref.current(), position, active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

export function useRegisterMenuComponent(path, component, position = 1) {
  const { registerMenuComponent } = useMenu();

  useEffect(() => {
    registerMenuComponent(path, component, position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function useMenu() {
  return useContext(MenuContext);
}

// Expose the menu context object and registration hook via window so
// module-federation plugins can call useContext(window.__ymerflow_MenuContext)
// and window.__ymerflow_useRegisterMenu(...) with the shared React singleton
// (mirrors AuthContext.jsx). This lets a plugin turn a dynamically fetched list
// into menu entries by registering into the shared menu tree.
if (typeof window !== 'undefined') {
  window.__ymerflow_MenuContext = MenuContext;
  window.__ymerflow_useRegisterMenu = useRegisterMenu;
}

function mergeMenu(tree, path, action, position = 1, active = false) {
  // Deep clone the path we're modifying to avoid mutating shared references
  const newTree = { ...tree };
  let node = newTree;
  const nodePath = [];

  path.forEach((label, index) => {
    // Create a new copy of this node to avoid mutation
    if (!node[label]) {
      node[label] = { __children: {}, position };
    } else {
      // Clone existing node to avoid mutation
      node[label] = {
        ...node[label],
        __children: { ...node[label].__children }
      };
    }

    if (index === path.length - 1) {
      // Only set action if provided (allow null to skip)
      if (action !== null) {
        node[label].action = action;
      }
      node[label].position = position;
      node[label].active = active;
    }

    nodePath.push(node[label]);
    node = node[label].__children;
  });

  return newTree;
}

function mergeMenuComponent(tree, path, component, position = 1) {
  // Deep clone the path we're modifying to avoid mutating shared references
  const newTree = { ...tree };
  let node = newTree;

  path.forEach((label, index) => {
    // Create a new copy of this node to avoid mutation
    if (!node[label]) {
      node[label] = { __children: {}, position };
    } else {
      // Clone existing node to avoid mutation
      node[label] = {
        ...node[label],
        __children: { ...node[label].__children }
      };
    }

    if (index === path.length - 1) {
      // Only set component if provided (allow null to skip)
      if (component !== null) {
        node[label].component = component;
      }
      node[label].position = position;
    }

    node = node[label].__children;
  });

  return newTree;
}

export function MenuProvider({ children }) {
  const [menuTree, setMenuTree] = useState({});

  const registerMenu = useCallback((path, action, position = 1, active = false) => {
    setMenuTree(prev => mergeMenu({ ...prev }, path, action, position, active));
  }, []);

  const registerMenuComponent = useCallback((path, component, position = 1) => {
    setMenuTree(prev => mergeMenuComponent({ ...prev }, path, component, position));
  }, []);

  const value = useMemo(
    () => ({ menuTree, registerMenu, registerMenuComponent }),
    [menuTree, registerMenu, registerMenuComponent]
  );

  return (
    <MenuContext.Provider value={value}>
      {children}
    </MenuContext.Provider>
  );
}
