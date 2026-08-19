import React from 'react';
import logo from './assets/Logo-OnDark.svg';

// App-level toolbar logo, injected into the generic MenuBar via the menu registry
// (see App.jsx) so no YmerFlow branding is hardcoded inside flexout/.
export default function BrandLogo() {
  return (
    <a href="/" className="navbar-brand d-flex align-items-center py-0 me-3">
      <img src={logo} alt="YmerFlow" style={{ height: '28px', width: 'auto' }} />
    </a>
  );
}
