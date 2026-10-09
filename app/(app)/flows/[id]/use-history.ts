"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Undo / redo over arbitrary snapshots. `record(before)` is called with the state BEFORE a change;
 * undo/redo return the state to apply (the caller owns the live state, React Flow owns drag positions).
 */
export function useHistory<T>(limit = 100) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [, bump] = useState(0);

  const record = useCallback(
    (before: T) => {
      past.current.push(before);
      if (past.current.length > limit) past.current.shift();
      future.current = [];
      bump((n) => n + 1);
    },
    [limit],
  );
  const undo = useCallback((current: T): T | null => {
    const prev = past.current.pop();
    if (prev === undefined) return null;
    future.current.push(current);
    bump((n) => n + 1);
    return prev;
  }, []);
  const redo = useCallback((current: T): T | null => {
    const next = future.current.pop();
    if (next === undefined) return null;
    past.current.push(current);
    bump((n) => n + 1);
    return next;
  }, []);
  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    bump((n) => n + 1);
  }, []);

  return { record, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
