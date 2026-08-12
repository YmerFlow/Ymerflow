import React, { createContext, useCallback, useMemo, useState } from 'react';

export const MessageContext = createContext();

// Expose the context object via window so module-federation plugins can call
// useContext(window.__ymerflow_MessageContext) with the shared React singleton.
if (typeof window !== 'undefined') {
  window.__ymerflow_MessageContext = MessageContext;
}

let messageIdCounter = 0;

export const MessageProvider = ({ children }) => {
  const [messages, setMessages] = useState([]);

  const addMessage = useCallback(({ level, message }) => {
    const id = `message-${Date.now()}-${messageIdCounter++}`;
    const newMessage = {
      id,
      level, // 'info' | 'warning' | 'danger'
      message,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, newMessage]);
    return id;
  }, []);

  const removeMessage = useCallback((id) => {
    setMessages(prev => prev.filter(msg => msg.id !== id));
  }, []);

  const contextValue = useMemo(
    () => ({
      messages,
      addMessage,
      removeMessage
    }),
    [messages, addMessage, removeMessage]
  );

  return (
    <MessageContext.Provider value={contextValue}>
      {children}
    </MessageContext.Provider>
  );
};
