import React from "react";
import { useMenu } from "./MenuContext";

function sortMenuEntries(entries) {
  return entries.sort((a, b) => {
    const [labelA, nodeA] = a;
    const [labelB, nodeB] = b;
    const posA = nodeA.position ?? 1;
    const posB = nodeB.position ?? 1;

    const signA = posA >= 0 ? 1 : -1;
    const signB = posB >= 0 ? 1 : -1;

    // If different signs, positive comes first
    if (signA !== signB) {
      return signA - signB;
    }

    // Same sign, sort by position
    if (posA !== posB) {
      return posA - posB;
    }

    // Same position, sort alphabetically
    return labelA.localeCompare(labelB);
  });
}

function renderMenuItems(tree, depth = 0) {
  const sortedEntries = sortMenuEntries(Object.entries(tree));

  return sortedEntries.map(([label, node]) => {
    const hasChildren = Object.keys(node.__children).length > 0;

    // If this node has a component, render it
    if (node.component) {
      const Component = node.component;
      return (
        <li key={label}>
          <Component />
        </li>
      );
    }

    if (!hasChildren) {
      return (
        <li key={label}>
          <button className={`dropdown-item${node.active ? ' active' : ''}`} onClick={node.action}>
            {label}
          </button>
        </li>
      );
    }

    return (
      <li className="dropdown-submenu" key={label}>
        <button className="dropdown-item dropdown-toggle">
          {label}
        </button>
        <ul className="dropdown-menu">
          {renderMenuItems(node.__children, depth + 1)}
        </ul>
      </li>
    );
  });
}

export default function MenuBar({}) {
  const { menuTree } = useMenu();

  const sortedEntries = sortMenuEntries(Object.entries(menuTree));
  const leftItems = sortedEntries.filter(([_, node]) => (node.position ?? 1) >= 0);
  const rightItems = sortedEntries.filter(([_, node]) => (node.position ?? 1) < 0);

  const renderTopLevelItem = ([label, node]) => {
    // If this top-level node has a component, render it directly
    if (node.component) {
      const Component = node.component;
      return (
        <li className="nav-item" key={label}>
          <Component />
        </li>
      );
    }

    // Otherwise render as a dropdown menu
    return (
      <li className="nav-item dropdown" key={label}>
        <button
          className="nav-link dropdown-toggle"
          data-bs-toggle="dropdown"
        >
          {label}
        </button>
        <ul className="dropdown-menu">
          {renderMenuItems(node.__children)}
        </ul>
      </li>
    );
  };

  return (
    <nav className="bg-dark navbar navbar-expand-lg navbar-dark">
      <ul className="navbar-nav me-auto mb-2 mb-lg-0 align-items-center">
        {leftItems.map(renderTopLevelItem)}
      </ul>
      <ul className="navbar-nav mb-2 mb-lg-0 align-items-center">
        {rightItems.map(renderTopLevelItem)}
      </ul>
    </nav>
  );
}
