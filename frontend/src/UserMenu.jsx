import React, { useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from './AuthContext';
import { setAuthToken } from './datamodel/api';
import { useRegisterMenu, useRegisterMenuComponent } from './flexout/MenuContext';
import { hooks } from './plugins/hooks';

// Renders any items contributed by plugins via the user_menu_extra_items hook.
// Plugins (e.g. billing) register their components through that hook.
function UserMenuExtras() {
  return <>{hooks.run_jsx.user_menu_extra_items()}</>;
}

// Registered unconditionally (Rules of Hooks) via useRegisterMenuComponent; renders
// nothing for non-admins so the item never appears in their menu.
function AdminMenuItem() {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();

  if (!user?.is_admin) return null;

  return (
    <button className="dropdown-item" onClick={() => navigate('/admin')}>
      Admin
    </button>
  );
}

// Main component that registers menu items
export default function UserMenu() {
  const { user, logout } = useContext(AuthContext);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    setAuthToken(null);
  };

  const handleAccountClick = () => {
    navigate('/account');
  };


  var menuName = user?.username;

  useRegisterMenuComponent([menuName], null, 0);

  useRegisterMenuComponent([menuName, 'Balance'], UserMenuExtras, -1);
  useRegisterMenu([menuName, 'Account'], handleAccountClick, 1);
  useRegisterMenuComponent([menuName, 'Admin'], AdminMenuItem, 2);
  useRegisterMenu([menuName, 'Log Out'], handleLogout, 3);

  return null;
}
