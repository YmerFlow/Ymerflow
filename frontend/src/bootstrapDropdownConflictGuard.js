// react-bootstrap's <Dropdown> renders `dropdown-toggle`/`dropdown-menu` CSS classes (for
// Bootstrap's styling) but never sets the `data-bs-toggle="dropdown"` attribute that vanilla
// Bootstrap JS (imported right after this file, for the flexout MenuBar's native
// data-bs-toggle dropdowns) needs to resolve a toggle element for its own keyboard handling.
//
// When focus is inside a react-bootstrap dropdown menu and Escape/ArrowUp/ArrowDown is
// pressed, vanilla Bootstrap's document-level, capture-phase keydown listener
// (bootstrap/js/src/dropdown.js dataApiKeydownHandler) tries to look up that nonexistent
// toggle and crashes with "Cannot read properties of undefined (reading 'parentNode')".
// Capture-phase listeners on the same node run in registration order, so registering this
// listener before the bootstrap.bundle import below lets it intercept those keys first, for
// any element explicitly opted in via the data-rb-guard attribute (our own <Dropdown>
// components) — native flexout dropdowns are left untouched.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  if (event.target.closest && event.target.closest('[data-rb-guard]')) {
    // stopPropagation() alone doesn't help here: vanilla Bootstrap's listener is registered
    // on this same `document` node (same phase), and stopPropagation() only blocks an event
    // from reaching *other* nodes, not other listeners already registered on this one.
    // stopImmediatePropagation() is what skips those.
    event.stopImmediatePropagation();
  }
}, true);
