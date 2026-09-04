"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useToast() {
  const [toast, setToast] = useState<{ message: string; fading: boolean } | null>(null);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (hideRef.current !== null) clearTimeout(hideRef.current);
    if (removeRef.current !== null) clearTimeout(removeRef.current);
  }, []);
  const showToast = useCallback((message: string) => {
    clear();
    setToast({ message, fading: false });
    hideRef.current = setTimeout(() => {
      setToast((current) => current ? { ...current, fading: true } : null);
      removeRef.current = setTimeout(() => setToast(null), 180);
    }, 3_500);
  }, [clear]);
  useEffect(() => clear, [clear]);
  return { toast, showToast };
}
