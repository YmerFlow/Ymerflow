import React, { createContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { setAuthToken, getUserAccount } from './datamodel/api';
import { queryClient } from './datamodel/queryClient';

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
    // Drop any prior user's cached queries; mounted observers refetch under the
    // new token so the new user never sees the previous user's data.
    queryClient.clear();
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
    // Drop any pre-login destination stash so it can't cross into the next user's session
    // in this tab. (Restore already consumes pendingPath on the first authenticated render;
    // this is belt-and-suspenders and also covers the project-invite token.)
    sessionStorage.removeItem('pendingPath');
    sessionStorage.removeItem('pendingInviteToken');
    // Drop the departing user's cached queries so a logged-out (or next) user
    // never sees them; observers refetch under the absent/new token.
    queryClient.clear();
  }, []);

  const updateUser = useCallback((updatedUser) => {
    setUser(updatedUser);
    localStorage.setItem('auth_user', JSON.stringify(updatedUser));
  }, []);

  // Re-read the current user from the server and fold it into the cached copy.
  //
  // The user object is cached in localStorage at login and restored on every
  // page load, but the backend reads the User row fresh on every request — so
  // anything granted server-side after login (is_admin, plan/contract state,
  // preferences changed elsewhere) stayed invisible here until logout/login,
  // and nothing told the user to do that. See Ymerflow#84.
  //
  // Merge rather than replace: login may have stored fields /auth/account does
  // not return, and those should survive a refresh.
  const refreshUser = useCallback(async () => {
    if (!localStorage.getItem('auth_token')) return;
    try {
      const fresh = await getUserAccount();
      setUser((prev) => {
        const merged = { ...(prev || {}), ...fresh };
        localStorage.setItem('auth_user', JSON.stringify(merged));
        return merged;
      });
    } catch (err) {
      // A 401 means the stored token is no longer valid: the cached user is a
      // ghost, so log out rather than keep showing it. Any other failure
      // (network, 5xx) leaves the cached copy in place — stale beats blank.
      if (err?.response?.status === 401) logout();
    }
  }, [logout]);

  // Refresh once whenever a session becomes active - both a localStorage
  // restore on page load and an explicit login - and again each time the
  // window regains focus, which is when a grant made in another tab or by an
  // admin is most likely to have happened.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    refreshUser();
    const onFocus = () => { refreshUser(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isAuthenticated, refreshUser]);

  const contextValue = useMemo(
    () => ({
      user,
      token,
      isAuthenticated,
      authReady,
      login,
      logout,
      updateUser,
      refreshUser,
      consumeJustAuthenticated
    }),
    [user, token, isAuthenticated, authReady, login, logout, updateUser, refreshUser, consumeJustAuthenticated]
  );

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};
