'use client';

import { useEffect, useRef } from 'react';

/** Submits the enclosing GET form when any control changes. The form still works without JavaScript. */
export function AutoSubmit() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = ref.current?.closest('form');
    if (!form) return;
    const onChange = (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (t.type === 'text' || t.inputMode === 'numeric') return; // typed fields submit on Enter
      form.requestSubmit();
    };
    form.addEventListener('change', onChange);
    return () => form.removeEventListener('change', onChange);
  }, []);
  return <span ref={ref} hidden />;
}
