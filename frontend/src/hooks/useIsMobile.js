import { useState, useEffect } from 'react';

export const MOBILE_MEDIA_QUERY = '(max-width: 575.98px)';  // Bootstrap `sm` upper bound

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_MEDIA_QUERY).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    setIsMobile(mq.matches);           // resync in case it changed before listener attached
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}
