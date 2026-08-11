import { t, translateMessage } from "@/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { getNextPendingQueueItem, getQueue, subscribeQueue, updateQueueItem, type QueueExecutionResult, type QueueItem, type QueueItemType, type QueueTrackStatus } from "@/lib/queue";
import type { TrackMetadata } from "@/types/api";
interface QueueDownloadHandlers {
    handleDownloadTrack: (id: string, trackName?: string, artistName?: string, albumName?: string, spotifyId?: string, playlistName?: string, durationMs?: number, position?: number, albumArtist?: string, releaseDate?: string, coverUrl?: string, spotifyTrackNumber?: number, spotifyDiscNumber?: number, spotifyTotalTracks?: number, spotifyTotalDiscs?: number, copyright?: string, publisher?: string, queueItemId?: string) => Promise<QueueTrackStatus | undefined>;
    handleDownloadAll: (tracks: TrackMetadata[], folderName?: string, isAlbum?: boolean, batchSource?: "playlist" | "album" | "discography" | "collection", queueItemId?: string) => Promise<QueueExecutionResult | undefined>;
    handleStopDownload: () => void;
}
function batchSourceFor(item: QueueItem): "playlist" | "album" | "discography" | "collection" {
    if (item.type === "album")
        return "album";
    if (item.type === "playlist")
        return "playlist";
    if (item.type === "artist")
        return "discography";
    return "collection";
}
export function useQueue(download: QueueDownloadHandlers) {
    const [items, setItems] = useState<QueueItem[]>(() => getQueue());
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingType, setProcessingType] = useState<QueueItemType | null>(null);
    const shouldStopRef = useRef(false);
    const isProcessingRef = useRef(false);
    const processingTypeRef = useRef<QueueItemType | null>(null);
    useEffect(() => subscribeQueue(setItems), []);
    const runItem = useCallback(async (item: QueueItem) => {
        let result: QueueExecutionResult;
        if (item.type === "track") {
            const track = item.tracks[0];
            if (!track?.spotify_id) {
                throw new Error(t("translation.download.noIdFoundTrack"));
            }
            const status = await download.handleDownloadTrack(track.spotify_id, track.name, track.artists, track.album_name, track.spotify_id, item.folderName, track.duration_ms, item.position, track.album_artist, track.release_date, track.images, track.track_number, track.disc_number, track.total_tracks, track.total_discs, track.copyright, track.publisher, item.id);
            result = { trackResults: status ? { [track.spotify_id]: status } : {}, successCount: status === "done" ? 1 : 0, skippedCount: status === "skipped" ? 1 : 0, failedCount: status === "failed" ? 1 : 0, cancelled: status === undefined };
        }
        else {
            result = await download.handleDownloadAll(item.tracks, item.folderName, item.isAlbum, batchSourceFor(item), item.id) || { trackResults: {}, successCount: 0, skippedCount: 0, failedCount: 0, cancelled: true };
        }
        updateQueueItem(item.id, { trackResults: result.trackResults });
        if (result.cancelled)
            return "pending" as const;
        if (result.failedCount > 0 && result.successCount + result.skippedCount > 0)
            return "partial" as const;
        if (result.failedCount > 0) {
            throw new Error(item.type === "track"
                ? t("translation.download.downloadFailed")
                : t("translation.queue.value1TracksFailed", { value1: result.failedCount.toLocaleString() }));
        }
        if (result.skippedCount > 0 && result.successCount === 0)
            return "skipped" as const;
        return "done" as const;
    }, [download]);
    const start = useCallback(async (type?: QueueItemType) => {
        if (isProcessingRef.current) {
            return;
        }
        if (!getNextPendingQueueItem(type)) {
            toast.info(t("translation.queue.nothingQueued"));
            return;
        }
        isProcessingRef.current = true;
        shouldStopRef.current = false;
        processingTypeRef.current = type ?? null;
        setProcessingType(type ?? null);
        setIsProcessing(true);
        try {
            for (let item = getNextPendingQueueItem(type); item; item = getNextPendingQueueItem(type)) {
                if (shouldStopRef.current) {
                    break;
                }
                updateQueueItem(item.id, { status: "running", error: "" });
                try {
                    const status = await runItem(item);
                    updateQueueItem(item.id, { status: shouldStopRef.current ? "pending" : status });
                }
                catch (err) {
                    const message = translateMessage(err instanceof Error ? err.message : String(err));
                    updateQueueItem(item.id, { status: "failed", error: message });
                }
            }
        }
        finally {
            isProcessingRef.current = false;
            processingTypeRef.current = null;
            setIsProcessing(false);
            setProcessingType(null);
            if (shouldStopRef.current) {
                shouldStopRef.current = false;
            }
        }
    }, [runItem]);
    const stop = useCallback((type?: QueueItemType) => {
        if (!isProcessingRef.current)
            return;
        if (type !== undefined && processingTypeRef.current !== type)
            return;
        shouldStopRef.current = true;
        download.handleStopDownload();
    }, [download]);
    return { items, isProcessing, processingType, start, stop };
}
