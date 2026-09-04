import { QueryClient } from '@tanstack/react-query';

// Single shared in-memory query cache. Exported as a module singleton so both
// App.jsx (which provides it) and AuthContext.jsx (which clears it on a
// login/logout user change) operate on the same instance.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
