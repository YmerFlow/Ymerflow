import React, { createContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { setAuthToken } from './datamodel/api';

export const AuthContext = createContext();

// Expose the context object via window so module-federation plugins can call
// useContext(window.__ymerflow_AuthContext) with the shared React singleton.
if (typeof window !== 'undefined') {
  window.__ymerflow_AuthContext = AuthContext;
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);  // { username, balance }
  const [token, setToken] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  // Becomes true exactly once, after the mount hydration effect has decided the
  // logged-in-or-out question. Distinguishes "localStorage not checked yet" from
  // "checked, genuinely logged out" so plugin loading never runs against the
  // transient pre-hydration anonymous render.
  const [authReady, setAuthReady] = useState(false);

  // One-shot signal: true only after an explicit login()/signup() in THIS tab,
  // never after a localStorage session-restore. Held in a ref so consuming it
  // doesn't re-render the app tree. Plugins (e.g. the billing contract nudge)
  // read it once, after they have lazily loaded, to distinguish "just signed in"
  // from "reopened an existing session" — a distinction that no longer depends
  // on a hook firing before the plugin bundle is even loaded.
  const justAuthenticatedRef = useRef(false);

  // Load token from localStorage on mount
  useEffect(() => {
    const storedToken = localStorage.getItem('auth_token');
    const storedUser = localStorage.getItem('auth_user');
    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
      setIsAuthenticated(true);
      // Set token in API client
      setAuthToken(storedToken);
    }
    setAuthReady(true);
  }, []);

  const login = useCallback((userData, authToken) => {
    setUser(userData);
    setToken(authToken);
    setIsAuthenticated(true);
    justAuthenticatedRef.current = true;
    localStorage.setItem('auth_token', authToken);
    localStorage.setItem('auth_user', JSON.stringify(userData));
    // Set token in API client
    setAuthToken(authToken);
  }, []);

  // Read-and-clear the one-shot just-authenticated signal. Returns true at most
  // once per login() — subsequent calls (and page refreshes) return false.
  const consumeJustAuthenticated = useCallback(() => {
    const value = justAuthenticatedRef.current;
    justAuthenticatedRef.current = false;
    return value;
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    setIsAuthenticated(false);
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    // Clear token from API client
    setAuthToken(null);
  }, []);

  const updateUser = useCallback((updatedUser) => {
    setUser(updatedUser);
    localStorage.setItem('auth_user', JSON.stringify(updatedUser));
  }, []);

  const contextValue = useMemo(
    () => ({
      user,
      token,
      isAuthenticated,
      authReady,
      login,
      logout,
      updateUser,
      consumeJustAuthenticated
    }),
    [user, token, isAuthenticated, authReady, login, logout, updateUser, consumeJustAuthenticated]
  );

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};
