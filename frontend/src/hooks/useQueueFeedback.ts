import { useCallback, useEffect, useRef, useState } from "react";
const FEEDBACK_MS = 500;
export function useQueueFeedback(durationMs: number = FEEDBACK_MS) {
    const [flashedKeys, setFlashedKeys] = useState<string[]>([]);
    const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    useEffect(() => () => {
        for (const timer of timersRef.current.values()) {
            clearTimeout(timer);
        }
        timersRef.current.clear();
    }, []);
    const flashQueued = useCallback((key: string = "default") => {
        const pending = timersRef.current.get(key);
        if (pending) {
            clearTimeout(pending);
        }
        setFlashedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
        timersRef.current.set(key, setTimeout(() => {
            timersRef.current.delete(key);
            setFlashedKeys((prev) => prev.filter((flashed) => flashed !== key));
        }, durationMs));
    }, [durationMs]);
    const isQueued = useCallback((key: string = "default") => flashedKeys.includes(key), [flashedKeys]);
    return { flashQueued, isQueued };
}
