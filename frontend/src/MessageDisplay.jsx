import React, { useContext } from 'react';
import { MessageContext } from './MessageContext';
import { hooks } from './plugins/hooks';

export default function MessageDisplay() {
  const { messages, removeMessage } = useContext(MessageContext);
  const banners = hooks.run_jsx.header_banners();

  if ((!messages || messages.length === 0) && banners.length === 0) {
    return null;
  }

  return (
    <div className="message-display-container">
      {banners}
      {messages.map(msg => (
        <div
          key={msg.id}
          className={`alert alert-${msg.level} alert-dismissible mb-2 d-flex align-items-center`}
          role="alert"
        >
          <div className="flex-grow-1">
            {msg.message}
          </div>
          <button
            type="button"
            className="btn-close"
            aria-label="Close"
            onClick={() => removeMessage(msg.id)}
          />
        </div>
      ))}
    </div>
  );
}
