import { isUnauthorizedError } from '@/app/lib/invokeErrorHandler'
import { store, useSelector, type RootState } from '@/app/store'
import {
  useLazyFetchBangumiInfoQuery,
  useLazyFetchVideoInfoQuery,
} from '@/features/video/api/videoApi'
import {
  matchesSelectedLan,
  selectedLanPriority,
} from '@/features/video/lib/batchSettings'
import {
  buildVideoFormSchema1,
  buildVideoFormSchema2,
  TITLE_MAX_LENGTH,
} from '@/features/video/lib/formSchema'
import { shouldSelectPart } from '@/features/video/lib/partSelection'
import { extractContentId } from '@/features/video/lib/utils'
import { stageExpectations } from '@/features/video/model/downloadProgress'
import {
  clearPendingDownload,
  clearResolvedInfo,
  deselectAll,
  initPartInputs,
  setUrl,
  updatePartInputByIndex,
  updatePartSelected,
} from '@/features/video/model/inputSlice'
import { selectDuplicateIndices } from '@/features/video/model/selectors'
import { setVideo } from '@/features/video/model/videoSlice'
import { logger } from '@/shared/lib/logger'
import { mapBackendError } from '@/shared/lib/mapBackendError'
import { enqueueSession, type EnqueuePartSpec } from '@/shared/queue'
import { toast } from '@/shared/ui/toast'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { Input, Video } from '../types'
import { invoke } from '@tauri-apps/api/core' // <-- Thêm import này

/**
 * Extracts the 'p' query parameter from a URL.
 */
function extractPageFromUrl(url: string): number | null {
  try {
    const pParam = new URL(url).searchParams.get('p')
    if (!pParam) return null
    const parsed = parseInt(pParam, 10)
    return !isNaN(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

/**
 * Context value type for VideoInfoProvider.
 */
export type VideoInfoContextValue = {
  progress: RootState['progress']
  video: Video
  input: Input
  onValid1: (url: string, opts?: { silent?: boolean }) => Promise<boolean>
  onValid2: (
    index: number,
    title: string,
    videoQuality: string,
    audioQuality?: string,
    explicit?: { videoQuality?: boolean; audioQuality?: boolean },
  ) => void
  videoId: string | null
  isForm1Valid: boolean
  isForm2ValidAll: boolean
  duplicateIndices: number[]
  selectedCount: number
  isFetching: boolean
  isSilentFetching: boolean
  download: () => Promise<void>
}

const VideoInfoContext = createContext<VideoInfoContextValue | null>(null)

export function useVideoInfo(): VideoInfoContextValue {
  const context = useContext(VideoInfoContext)
  if (!context) {
    throw new Error('useVideoInfo must be used within a VideoInfoProvider')
  }
  return context
}

type VideoInfoProviderProps = {
  children: React.ReactNode
}

export function VideoInfoProvider({ children }: VideoInfoProviderProps) {
  const { t } = useTranslation()
  const progress = useSelector((state) => state.progress)
  const video = useSelector((state) => state.video)
  const input = useSelector((state) => state.input)
  const [triggerFetch, { isFetching: isFetchingVideo }] =
    useLazyFetchVideoInfoQuery()
  const [triggerFetchBangumi, { isFetching: isFetchingBangumi }] =
    useLazyFetchBangumiInfoQuery()
  const isFetching = isFetchingVideo || isFetchingBangumi
  const [isSilentFetching, setIsSilentFetching] = useState(false)
  const silentFetchCountRef = useRef(0)

  const processingPendingRef = useRef<{
    bvid: string
    cid: number | null
    page: number
  } | null>(null)

  const initInputsForVideo = useCallback((v: Video) => {
    const pending = processingPendingRef.current

    const partInputs = v.parts.map((p, index) => ({
      cid: p.cid,
      page: p.page,
      title: p.defaultTitle,
      videoQuality: '',
      audioQuality: '',
      selected: shouldSelectPart(p, index, {
        contentType: v.contentType,
        videoEpId: v.epId,
        pending,
      }),
      duration: p.duration,
      thumbnailUrl: p.thumbnail.url,
      qualitiesLoading: false,
    }))

    store.dispatch(initPartInputs(partInputs))

    if (pending) {
      store.dispatch(clearPendingDownload())
      processingPendingRef.current = null
    }
  }, [])

  /**
   * Validates video/bangumi URL and fetches information (form 1).
   * Đã tích hợp thêm tính năng tải toàn bộ kênh (Space).
   */
  const onValid1 = useCallback(
    async (url: string, opts?: { silent?: boolean }): Promise<boolean> => {
      const silent = opts?.silent ?? false
      const failToast = (description: string | null | undefined) => {
        if (silent || !description) return
        toast.error(t('video.fetch_info'), {
          duration: 5000,
          description,
        })
      }

            // ==========================================
                  // ==========================================
      // TÍCH HỢP TÍNH NĂNG TẢI TOÀN BỘ KÊNH (SPACE)
      // ==========================================
      if (url.includes('space.bilibili.com')) {
        if (silent) return false
        
        store.dispatch(clearPendingDownload())
        
        try {
          toast.info('Đang lấy danh sách video từ kênh...', { duration: 3000 })
          const videos = await invoke<any[]>('fetch_all_space_videos', { midOrUrl: url })
          
          if (videos.length === 0) {
            failToast('Không tìm thấy video nào trong kênh này.')
            return false
          }

          toast.info(`Đã tìm thấy ${videos.length} video. Bắt đầu đưa vào hàng đợi...`, { duration: 5000 })

          for (let i = 0; i < videos.length; i++) {
            const v = videos[i]
            try {
              const videoInfo = await Promise.race([
                invoke<any>('fetch_video_info', { videoId: v.bvid }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
              ]) as any
              
              const part = videoInfo.parts[0]
              const safeTitle = v.title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 100)
              const downloadId = `${v.bvid}-p1-${Date.now()}-${i}`

              // SỬA LỖI TẠI ĐÂY: Bọc trong { options: ... }
              await invoke('download_video', { 
                options: {
                  bvid: v.bvid,
                  cid: part.cid,
                  filename: safeTitle,
                  quality: null, 
                  audioQuality: null,
                  downloadId: downloadId,
                  parentId: null,
                  durationSeconds: v.duration,
                  thumbnailUrl: v.cover,
                  page: 1,
                  subtitle: null,
                  epId: null,
                  outputDir: null,
                }
              })
            } catch (err) {
              logger.warn(`Bỏ qua video ${v.bvid} do lỗi`, err)
            }
            await new Promise(r => setTimeout(r, 1500))
          }
          
          toast.success(`Đã đưa thành công ${videos.length} video vào hàng đợi!`)
          return true
        } catch (err: any) {
          failToast(`Lỗi: ${err.toString()}`)
          return false
        }
      }
      // ==========================================
      // KẾT THÚC TÍCH HỢP
      // ==========================================

      const schema1 = buildVideoFormSchema1(t)
      const result = schema1.safeParse({ url })
      if (!result.success) {
        failToast(result.error.issues[0]?.message)
        store.dispatch(clearPendingDownload())
        return false
      }

      const contentId = extractContentId(url)
      if (!contentId) {
        failToast(t('validation.video.url.invalid'))
        return false
      }

      const pageFromUrl = extractPageFromUrl(url)

      if (
        pageFromUrl &&
        !processingPendingRef.current &&
        contentId.type === 'video'
      ) {
        processingPendingRef.current = {
          bvid: contentId.id,
          cid: null,
          page: pageFromUrl,
        }
      }

      store.dispatch(setUrl(url))
      store.dispatch(deselectAll())

      let fetchResult: { data?: Video; error?: unknown }

      if (silent) {
        silentFetchCountRef.current += 1
        setIsSilentFetching(true)
      }
      try {
        if (contentId.type === 'video') {
          fetchResult = await triggerFetch(contentId.id, true)
        } else {
          const epId = parseInt(contentId.epId, 10)
          fetchResult = await triggerFetchBangumi(epId, true)
        }
      } finally {
        if (silent) {
          silentFetchCountRef.current -= 1
          if (silentFetchCountRef.current === 0) setIsSilentFetching(false)
        }
      }

      if (store.getState().input.url !== url) return false

      if (fetchResult.data) {
        const v = fetchResult.data
        store.dispatch(setVideo(v))
        initInputsForVideo(v)
        return true
      }
      if (fetchResult.error) {
        const raw = String(fetchResult.error)
        const key = mapBackendError(raw)
        const description = key ? t(key) : isUnauthorizedError(raw) ? null : raw
        failToast(description)
        logger.error('Failed to fetch content info', raw)
      }
      return false
    },
    [t, initInputsForVideo, triggerFetch, triggerFetchBangumi],
  )

  const onValid2 = useCallback(
    (
      index: number,
      title: string,
      videoQuality: string,
      audioQuality?: string,
      explicit?: { videoQuality?: boolean; audioQuality?: boolean },
    ) => {
      store.dispatch(
        updatePartInputByIndex({
          index,
          title,
          videoQuality,
          ...(audioQuality !== undefined && { audioQuality }),
          ...(explicit?.videoQuality !== undefined && {
            videoQualityExplicit: explicit.videoQuality,
          }),
          ...(explicit?.audioQuality !== undefined && {
            audioQualityExplicit: explicit.audioQuality,
          }),
        }),
      )
    },
    [],
  )

  const schema1 = buildVideoFormSchema1(t)
  const schema2 = buildVideoFormSchema2(t)
  const isForm1Valid =
    input.url.trim() !== '' && schema1.safeParse({ url: input.url }).success

  const videoId = useMemo(() => {
    const contentId = extractContentId(input.url)
    if (!contentId) return null
    return contentId.type === 'video'
      ? contentId.id
      : `av${video.parts[0]?.aid ?? ''}`
  }, [input.url, video.parts])

  const duplicateIndices = useSelector(selectDuplicateIndices)
  const selectedCount = input.partInputs.filter((pi) => pi.selected).length

  const isForm2ValidAll = useMemo(() => {
    if (!selectedCount) return false
    return input.partInputs
      .filter((pi) => pi.selected)
      .every((pi) => {
        const valid = schema2.safeParse({
          title: pi.title,
          videoQuality: pi.videoQuality,
          audioQuality: pi.audioQuality,
        }).success
        const subtitleOk =
          pi.subtitle?.mode === 'off' ||
          (pi.subtitle?.selectedLans?.length ?? 0) > 0
        return valid && subtitleOk
      })
  }, [selectedCount, input.partInputs, schema2])

  useEffect(() => {
    const pending = input.pendingDownload
    if (!pending) return

    const { bvid, cid, page } = pending
    const processing = processingPendingRef.current

    if (processing?.bvid === bvid && processing.page === page) {
      return
    }

    processingPendingRef.current = { bvid, cid, page }
    onValid1(`https://www.bilibili.com/video/${bvid}?p=${page}`)
  }, [input.pendingDownload, onValid1])

  const download = useCallback(async () => {
    if (!isForm1Valid || !isForm2ValidAll) return
    if (!videoId) return

    const parts: EnqueuePartSpec[] = []

    const batch = input.batchSettings
    input.partInputs.forEach((pi, idx) => {
      if (!pi.selected) return
      const title =
        pi.title
          .trim()
          .slice(0, TITLE_MAX_LENGTH)
          .replace(/[\uD800-\uDBFF.\s]+$/, '') || `P${pi.page}`
      const effVideoQuality =
        pi.videoQualityExplicit || !batch.videoQuality
          ? pi.videoQuality
          : batch.videoQuality
      const effAudioQuality =
        pi.audioQualityExplicit || !batch.audioQuality
          ? pi.audioQuality
          : batch.audioQuality
      const effSubtitle =
        pi.subtitleExplicit || !batch.subtitle ? pi.subtitle : batch.subtitle
      const effSubtitles =
        pi.subtitleExplicit || !batch.subtitle ? pi.subtitles : pi.subtitles
      parts.push({
        partIndex: idx + 1,
        cid: pi.cid,
        title,
        thumbnailUrl: pi.thumbnailUrl ?? null,
        expectedStages: stageExpectations(pi),
        payload: {
          videoId,
          cid: pi.cid,
          filename: title,
          quality: effVideoQuality ? parseInt(effVideoQuality, 10) : null,
          audioQuality: effAudioQuality ? parseInt(effAudioQuality, 10) : null,
          durationSeconds: pi.duration,
          thumbnailUrl: pi.thumbnailUrl ?? null,
          page: pi.page,
          epId: video.parts[idx]?.epId ?? null,
          outputDir: input.outputDirOverride ?? null,
          subtitle: (() => {
            const matched = (effSubtitles ?? [])
              .filter((s) =>
                matchesSelectedLan(effSubtitle.selectedLans, s.lan),
              )
              .sort((a, b) => {
                const pri =
                  selectedLanPriority(effSubtitle.selectedLans, a.lan) -
                  selectedLanPriority(effSubtitle.selectedLans, b.lan)
                if (pri !== 0) return pri
                return Number(a.isAi) - Number(b.isAi)
              })
            if (
              pi.subtitle.mode !== 'off' &&
              matched.length === 0 &&
              (pi.subtitles?.length ?? 0) > 0
            ) {
              logger.warn(
                `subtitle selection matched nothing: fetched=[${pi.subtitles!.map((s) => s.lan).join(',')}] selected=[${pi.subtitle.selectedLans.join(',')}]`,
              )
            }
            const selectedLans =
              matched.length > 0
                ? matched.map((s) => s.lan)
                : effSubtitle.mode !== 'off'
                  ? effSubtitle.selectedLans
                  : []
            return {
              mode: effSubtitle.mode,
              selectedLans,
              subtitles: matched,
            }
          })(),
        },
      })
    })

    if (parts.length === 0) return

    store.dispatch(clearResolvedInfo())
    store.dispatch(enqueueSession({ videoId, videoTitle: video.title, parts }))

    for (const spec of parts) {
      store.dispatch(
        updatePartSelected({ index: spec.partIndex - 1, selected: false }),
      )
    }
  }, [
    isForm1Valid,
    isForm2ValidAll,
    videoId,
    input.partInputs,
    input.batchSettings,
    input.outputDirOverride,
    video,
    t,
  ])

  const value: VideoInfoContextValue = {
    progress,
    video,
    input,
    videoId,
    onValid1,
    onValid2,
    isForm1Valid,
    isForm2ValidAll,
    duplicateIndices,
    selectedCount,
    isFetching,
    isSilentFetching,
    download,
  }

  return (
    <VideoInfoContext.Provider value={value}>
      {children}
    </VideoInfoContext.Provider>
  )
}
