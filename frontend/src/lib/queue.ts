import type { TrackMetadata } from "@/types/api";
export type QueueItemType = "track" | "album" | "playlist" | "artist";
export type QueueItemStatus = "pending" | "running" | "done" | "partial" | "skipped" | "failed";
export type QueueTrackStatus = "done" | "failed" | "skipped";
export interface QueueItem {
    id: string;
    key: string;
    type: QueueItemType;
    name: string;
    artist: string;
    info: string;
    image: string;
    folderName?: string;
    isAlbum?: boolean;
    position?: number;
    durationMs?: number;
    trackCount: number;
    tracks: TrackMetadata[];
    status: QueueItemStatus;
    error?: string;
    trackResults?: Record<string, QueueTrackStatus>;
    addedAt: number;
}
export interface AddCollectionInput {
    type: Exclude<QueueItemType, "track">;
    name: string;
    artist: string;
    info: string;
    image: string;
    folderName?: string;
    isAlbum?: boolean;
    tracks: TrackMetadata[];
}
export interface AddTracksOptions {
    folderName?: string;
    startPosition?: number;
}
export interface AddResult {
    added: number;
    skipped: number;
}
export interface QueueExecutionResult {
    trackResults: Record<string, QueueTrackStatus>;
    successCount: number;
    skippedCount: number;
    failedCount: number;
    cancelled?: boolean;
}
const STORAGE_KEY = "spotiflac_download_queue";
const listeners = new Set<(items: QueueItem[]) => void>();
let cache: QueueItem[] | null = null;
let persistenceDisabled = false;
function isPersistableTrackCount(items: QueueItem[]): boolean {
    return items.reduce((sum, item) => sum + item.trackCount, 0) <= 5000;
}
function parseQueue(raw: string | null): QueueItem[] {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((item): item is QueueItem => Boolean(item && typeof item.id === "string" && Array.isArray(item.tracks)));
    }
    catch (err) {
        console.error("Failed to parse download queue:", err);
        return [];
    }
}
function read(): QueueItem[] {
    if (cache)
        return cache;
    cache = parseQueue(localStorage.getItem(STORAGE_KEY)).map((item) => (item.status === "running" ? { ...item, status: "pending" as QueueItemStatus } : item));
    return cache;
}
function write(items: QueueItem[]): void {
    cache = items;
    if (!persistenceDisabled) {
        try {
            if (isPersistableTrackCount(items)) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
            }
            else {
                localStorage.removeItem(STORAGE_KEY);
                persistenceDisabled = true;
            }
        }
        catch (err) {
            console.error("Failed to persist download queue:", err);
            persistenceDisabled = true;
        }
    }
    for (const listener of listeners) {
        listener(items);
    }
}
export function isQueuePersistenceDisabled(): boolean {
    return persistenceDisabled;
}
export function getQueue(): QueueItem[] {
    return read();
}
export function subscribeQueue(listener: (items: QueueItem[]) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
function getTrackKey(track: TrackMetadata): string {
    return `track:${track.spotify_id || track.external_urls || `${track.name}-${track.artists}-${track.album_name}`}`;
}
function getCollectionKey(input: AddCollectionInput): string {
    return `${input.type}:${input.folderName || input.name}`;
}
function createId(): string {
    return crypto.randomUUID();
}
function mergeByKey(items: QueueItem[], incoming: QueueItem): {
    items: QueueItem[];
    added: boolean;
} {
    const existingIndex = items.findIndex((item) => item.key === incoming.key);
    if (existingIndex === -1) {
        return { items: [...items, incoming], added: true };
    }
    const existing = items[existingIndex];
    if (existing.status === "pending" || existing.status === "running") {
        return { items, added: false };
    }
    const next = [...items];
    next[existingIndex] = { ...incoming, id: existing.id };
    return { items: next, added: true };
}
function beginRunningItem(incoming: QueueItem): string {
    const items = read();
    const existingIndex = items.findIndex((item) => item.key === incoming.key);
    if (existingIndex === -1) {
        write([...items, incoming]);
        return incoming.id;
    }
    const next = [...items];
    const id = next[existingIndex].id;
    next[existingIndex] = { ...incoming, id };
    write(next);
    return id;
}
export function beginDirectTrackQueueItem(track: TrackMetadata, options: AddTracksOptions = {}): string {
    return beginRunningItem({
        id: createId(), key: getTrackKey(track), type: "track", name: track.name,
        artist: track.artists, info: track.album_name || "", image: track.images || "",
        folderName: options.folderName, position: options.startPosition || track.track_number,
        durationMs: track.duration_ms, trackCount: 1, tracks: [track], status: "running", addedAt: Date.now(),
    });
}
export function beginDirectCollectionQueueItem(input: AddCollectionInput): string {
    const tracks = input.tracks.filter((track) => track.spotify_id);
    return beginRunningItem({
        id: createId(), key: getCollectionKey(input), type: input.type, name: input.name,
        artist: input.artist, info: input.info, image: input.image, folderName: input.folderName,
        isAlbum: input.isAlbum, durationMs: tracks.reduce((sum, track) => sum + (track.duration_ms || 0), 0),
        trackCount: tracks.length, tracks, status: "running", addedAt: Date.now(),
    });
}
export function finishDirectQueueItem(id: string, result: QueueExecutionResult): void {
    let status: QueueItemStatus;
    if (result.cancelled)
        status = "pending";
    else if (result.failedCount > 0 && result.successCount + result.skippedCount > 0)
        status = "partial";
    else if (result.failedCount > 0)
        status = "failed";
    else if (result.skippedCount > 0 && result.successCount === 0)
        status = "skipped";
    else
        status = "done";
    updateQueueItem(id, { status, trackResults: result.trackResults });
}
export function addTracksToQueue(tracks: TrackMetadata[], options: AddTracksOptions = {}): AddResult {
    const queueable = tracks.filter((track) => track.spotify_id);
    if (queueable.length === 0) {
        return { added: 0, skipped: 0 };
    }
    let items = read();
    let added = 0;
    queueable.forEach((track, index) => {
        const item: QueueItem = {
            id: createId(),
            key: getTrackKey(track),
            type: "track",
            name: track.name,
            artist: track.artists,
            info: track.album_name || "",
            image: track.images || "",
            folderName: options.folderName,
            position: options.startPosition ? options.startPosition + index : track.track_number,
            durationMs: track.duration_ms,
            trackCount: 1,
            tracks: [track],
            status: "pending",
            addedAt: Date.now(),
        };
        const result = mergeByKey(items, item);
        items = result.items;
        if (result.added) {
            added += 1;
        }
    });
    write(items);
    return { added, skipped: queueable.length - added };
}
export function addCollectionToQueue(input: AddCollectionInput): AddResult {
    const queueable = input.tracks.filter((track) => track.spotify_id);
    if (queueable.length === 0) {
        return { added: 0, skipped: 0 };
    }
    const item: QueueItem = {
        id: createId(),
        key: getCollectionKey(input),
        type: input.type,
        name: input.name,
        artist: input.artist,
        info: input.info,
        image: input.image,
        folderName: input.folderName,
        isAlbum: input.isAlbum,
        durationMs: queueable.reduce((sum, track) => sum + (track.duration_ms || 0), 0),
        trackCount: queueable.length,
        tracks: queueable,
        status: "pending",
        addedAt: Date.now(),
    };
    const result = mergeByKey(read(), item);
    if (result.added) {
        write(result.items);
        return { added: 1, skipped: 0 };
    }
    return { added: 0, skipped: 1 };
}
export function updateQueueItem(id: string, patch: Partial<Pick<QueueItem, "status" | "error" | "trackResults">>): void {
    const items = read();
    const index = items.findIndex((item) => item.id === id);
    if (index === -1)
        return;
    const next = [...items];
    next[index] = { ...next[index], ...patch };
    write(next);
}
export function removeQueueItem(id: string): void {
    const items = read();
    if (!items.some((item) => item.id === id))
        return;
    write(items.filter((item) => item.id !== id));
}
export function removeTrackFromQueueItem(itemId: string, trackIndex: number): void {
    const items = read();
    const index = items.findIndex((item) => item.id === itemId);
    if (index === -1)
        return;
    const item = items[index];
    if (trackIndex < 0 || trackIndex >= item.tracks.length)
        return;
    const remaining = item.tracks.filter((_, position) => position !== trackIndex);
    if (remaining.length === 0) {
        write(items.filter((candidate) => candidate.id !== itemId));
        return;
    }
    const next = [...items];
    next[index] = {
        ...item,
        tracks: remaining,
        trackCount: remaining.length,
        durationMs: remaining.reduce((sum, track) => sum + (track.duration_ms || 0), 0),
    };
    write(next);
}
export function retryQueueItem(id: string): void {
    updateQueueItem(id, { status: "pending", error: "", trackResults: {} });
}
export function clearQueue(type?: QueueItemType): void {
    const items = read();
    const next = type ? items.filter((item) => item.type !== type) : [];
    if (next.length === items.length && items.length > 0 && type) {
        return;
    }
    write(next);
}
export function clearFinishedQueueItems(type?: QueueItemType): void {
    const items = read();
    const next = items.filter((item) => {
        const isFinished = item.status === "done" || item.status === "partial" || item.status === "skipped" || item.status === "failed";
        const matchesType = !type || item.type === type;
        return !(isFinished && matchesType);
    });
    if (next.length === items.length)
        return;
    write(next);
}
export function getNextPendingQueueItem(type?: QueueItemType): QueueItem | undefined {
    return read().find((item) => item.status === "pending" && (!type || item.type === type));
}
export function countPendingQueueItems(type?: QueueItemType): number {
    return read().filter((item) => item.status === "pending" && (!type || item.type === type)).length;
}
