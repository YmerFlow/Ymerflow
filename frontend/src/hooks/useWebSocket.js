import { useEffect, useRef, useCallback } from 'react';

/**
 * Custom hook for WebSocket connections with automatic reconnection and heartbeat
 *
 * @param {string} url - WebSocket URL (e.g., 'ws://localhost:8000/ws/...')
 * @param {Object} options - Configuration options
 * @param {Function} options.onMessage - Callback for incoming messages (receives parsed JSON)
 * @param {Function} options.onOpen - Optional callback when connection opens
 * @param {Function} options.onClose - Optional callback when connection closes
 * @param {Function} options.onError - Optional callback for errors
 * @param {boolean} options.enabled - Whether WebSocket should be active (default: true)
 * @param {number} options.heartbeatInterval - Ping interval in ms (default: 30000)
 * @param {number} options.maxReconnectDelay - Max reconnection delay in ms (default: 30000)
 * @param {string} options.name - Name for logging purposes (default: 'WebSocket')
 *
 * @returns {Object} { send, close, readyState }
 */
export function useWebSocket(url, options = {}) {
  const {
    onMessage,
    onOpen,
    onClose,
    onError,
    enabled = true,
    heartbeatInterval = 30000, // 30 seconds
    maxReconnectDelay = 30000, // 30 seconds max
    name = 'WebSocket'
  } = options;

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const reconnectDelayRef = useRef(1000); // Start with 1 second
  const shouldReconnectRef = useRef(true);
  const urlRef = useRef(url);

  // Update url ref when it changes
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  // Cleanup heartbeat
  const clearHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  // Start heartbeat to keep connection alive
  const startHeartbeat = useCallback(() => {
    clearHeartbeat();
    heartbeatIntervalRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send('ping');
          console.log(`[${name}] Sent heartbeat ping`);
        } catch (error) {
          console.error(`[${name}] Failed to send heartbeat:`, error);
        }
      }
    }, heartbeatInterval);
  }, [clearHeartbeat, heartbeatInterval, name]);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (!enabled || !urlRef.current) {
      console.log(`[${name}] Connection disabled or no URL`);
      return;
    }

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    console.log(`[${name}] Connecting to ${urlRef.current}...`);

    try {
      const ws = new WebSocket(urlRef.current);
      wsRef.current = ws;

      ws.onopen = (event) => {
        console.log(`[${name}] ✓ Connected`);
        // Reset reconnect delay on successful connection
        reconnectDelayRef.current = 1000;
        startHeartbeat();
        onOpen?.(event);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log(`[${name}] 📨 Message received:`, data);
          onMessage?.(data, event);
        } catch (error) {
          console.error(`[${name}] Failed to parse message:`, error, event.data);
        }
      };

      ws.onerror = (error) => {
        console.error(`[${name}] ❌ Error:`, error);
        onError?.(error);
      };

      ws.onclose = (event) => {
        console.log(`[${name}] Connection closed:`, {
          code: event.code,
          reason: event.reason || 'No reason provided',
          wasClean: event.wasClean
        });

        clearHeartbeat();
        onClose?.(event);

        // Attempt reconnection if not manually closed and should reconnect.
        // 1008 (policy violation) means the server rejected auth (e.g. the authenticated logs
        // socket closes 1008 on a missing/invalid token) — don't hammer the endpoint retrying.
        if (shouldReconnectRef.current && event.code !== 1000 && event.code !== 1008) {
          const delay = Math.min(reconnectDelayRef.current, maxReconnectDelay);
          console.log(`[${name}] Reconnecting in ${delay}ms...`);

          reconnectTimeoutRef.current = setTimeout(() => {
            // Exponential backoff
            reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, maxReconnectDelay);
            connect();
          }, delay);
        }
      };
    } catch (error) {
      console.error(`[${name}] Failed to create WebSocket:`, error);
    }
  }, [enabled, name, onMessage, onOpen, onClose, onError, startHeartbeat, clearHeartbeat, maxReconnectDelay]);

  // Send message
  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        wsRef.current.send(message);
        return true;
      } catch (error) {
        console.error(`[${name}] Failed to send message:`, error);
        return false;
      }
    } else {
      console.warn(`[${name}] Cannot send message - connection not open (state: ${wsRef.current?.readyState})`);
      return false;
    }
  }, [name]);

  // Manual close
  const close = useCallback(() => {
    console.log(`[${name}] Manually closing connection`);
    shouldReconnectRef.current = false;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    clearHeartbeat();

    if (wsRef.current) {
      wsRef.current.close(1000, 'Manual close');
      wsRef.current = null;
    }
  }, [name, clearHeartbeat]);

  // Connect when enabled changes or component mounts
  useEffect(() => {
    if (enabled) {
      shouldReconnectRef.current = true;
      connect();
    } else {
      close();
    }

    // Cleanup on unmount
    return () => {
      shouldReconnectRef.current = false;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      clearHeartbeat();

      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounting');
        wsRef.current = null;
      }
    };
  }, [enabled, connect, close, clearHeartbeat]);

  return {
    send,
    close,
    readyState: wsRef.current?.readyState ?? WebSocket.CLOSED
  };
}
