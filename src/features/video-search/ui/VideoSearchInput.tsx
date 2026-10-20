import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Search, X } from 'lucide-react'
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { SearchHistoryEntry } from '../api/searchHistory'
import {
  clearSearchHistoryApi,
  getSearchHistoryApi,
  recordSearchApi,
  removeSearchHistoryApi,
} from '../api/searchHistory'
import { searchSuggestApi } from '../api/searchSuggest'
import type { TrendingKeyword } from '../api/searchTrending'
import { searchTrendingApi } from '../api/searchTrending'

const SUGGEST_DEBOUNCE_MS = 300
const TRENDING_CACHE_MS = 5 * 60_000

type DropdownItem =
  | { kind: 'history'; keyword: string }
  | { kind: 'trending'; keyword: string; label: string }
  | { kind: 'suggest'; keyword: string }

export function VideoSearchInput({
  onSearch,
  loading,
  keyword,
}: {
  onSearch: (keyword: string) => void
  loading: boolean
  keyword?: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [history, setHistory] = useState<SearchHistoryEntry[]>([])
  const [trending, setTrending] = useState<TrendingKeyword[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const latestRound = useRef(0)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const suppressNextSuggest = useRef(false)
  const suggestTimer = useRef<number | undefined>(undefined)
  const trendingCache = useRef<{ at: number; data: TrendingKeyword[] } | null>(null)

  const hasDraft = draft.trim().length > 0

  const items = useMemo<DropdownItem[]>(() => {
    if (hasDraft) {
      return suggestions.map((keyword) => ({
        kind: 'suggest' as const,
        keyword,
      }))
    }
    return [
      ...history.map(({ keyword }) => ({ kind: 'history' as const, keyword })),
      ...trending.map(({ keyword, showName }) => ({
        kind: 'trending' as const,
        keyword,
        label: showName,
      })),
    ]
  }, [hasDraft, suggestions, history, trending])

  const dropdownOpen = open && items.length > 0

  const requestSuggest = useCallback((keyword: string) => {
    const round = ++latestRound.current
    void searchSuggestApi(keyword)
      .then((values) => {
        if (round !== latestRound.current) return
        setSuggestions(values)
        setActiveIndex(-1)
        setOpen(values.length > 0)
      })
      .catch(() => {
        if (round === latestRound.current) setOpen(false)
      })
  }, [])

  const loadPanels = useCallback(() => {
    const round = ++latestRound.current
    setOpen(true)
    void getSearchHistoryApi()
      .then((entries) => {
        if (round === latestRound.current) setHistory(entries)
      })
      .catch(() => {})
    const cached = trendingCache.current
    if (cached && Date.now() - cached.at < TRENDING_CACHE_MS) {
      setTrending(cached.data)
      return
    }
    void searchTrendingApi()
      .then((keywords) => {
        if (round !== latestRound.current) return
        trendingCache.current = { at: Date.now(), data: keywords }
        setTrending(keywords)
      })
      .catch(() => {})
  }, [])

  const removeHistoryItem = useCallback((keyword: string) => {
    latestRound.current++
    void removeSearchHistoryApi(keyword)
      .then((entries) => {
        setHistory(entries)
        setActiveIndex(-1)
      })
      .catch(() => {})
  }, [])

  const prevDraft = useRef(draft)

  useEffect(() => {
    const draftChanged = prevDraft.current !== draft
    prevDraft.current = draft
    if (draftChanged) latestRound.current++
    if (suppressNextSuggest.current) {
      suppressNextSuggest.current = false
      return
    }
    if (!hasDraft) {
      setSuggestions([])
      setActiveIndex(-1)
      if (draftChanged && document.activeElement === inputRef.current) {
        loadPanels()
      } else {
        setOpen(history.length > 0 || trending.length > 0)
      }
      return
    }
    suggestTimer.current = window.setTimeout(
      () => requestSuggest(draft.trim()),
      SUGGEST_DEBOUNCE_MS,
    )
    return () => clearTimeout(suggestTimer.current)
  }, [draft, hasDraft, history, trending, requestSuggest, loadPanels])

  useEffect(() => {
    if (keyword === undefined) return
    if (inputRef.current?.value === keyword) return
    suppressNextSuggest.current = true
    setDraft(keyword)
  }, [keyword])

  const submit = (keyword: string) => {
    clearTimeout(suggestTimer.current)
    latestRound.current++
    setOpen(false)
    inputRef.current?.blur()

    const trimmed = keyword.trim()

    // CHUYỂN HƯỚNG LINK SPACE SANG TRANG FETCH
    if (trimmed.includes('space.bilibili.com')) {
      navigate({ pathname: '/video', search: `?url=${encodeURIComponent(trimmed)}` })
      return
    }

    // CHUYỂN HƯỚNG LINK VIDEO SANG TRANG FETCH
    if (trimmed.includes('bilibili.com/video/') || trimmed.includes('b23.tv/')) {
      navigate({ pathname: '/video', search: `?url=${encodeURIComponent(trimmed)}` })
      return
    }

    // NẾU LÀ TỪ KHÓA THÌ TÌM KIẾM BÌNH THƯỜNG
    void recordSearchApi(keyword).catch(() => {})
    onSearch(keyword)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (!dropdownOpen) return
    const active = activeIndex >= 0 ? items[activeIndex] : undefined
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i <= 0 ? items.length - 1 : i - 1))
    } else if (e.key === 'Enter' && active) {
      e.preventDefault()
      commitPick(active.keyword)
    } else if (
      (e.key === 'Delete' || (e.key === 'Backspace' && draft.length === 0)) &&
      active?.kind === 'history'
    ) {
      e.preventDefault()
      removeHistoryItem(active.keyword)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const commitPick = (value: string) => {
    if (value !== draft) suppressNextSuggest.current = true
    setDraft(value)
    submit(value)
  }

  const handleFocus = () => {
    if (hasDraft) {
      requestSuggest(draft.trim())
    } else {
      loadPanels()
    }
  }

  return (
    <div className="relative w-full" onBlur={() => setOpen(false)}>
      <form
        className="flex w-full gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit(draft)
        }}
      >
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          placeholder={t('videoSearch.placeholder')}
          aria-label={t('videoSearch.placeholder')}
          role="combobox"
          aria-expanded={dropdownOpen}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined
          }
          autoComplete="off"
        />
        <Button type="submit" disabled={loading || !draft.trim()}>
          <Search />
          {t('videoSearch.searchButton')}
        </Button>
      </form>

      {dropdownOpen && (
        <ul
          id={listId}
          role="listbox"
          aria-label={
            hasDraft
              ? t('videoSearch.suggestions')
              : t('videoSearch.searchHistory')
          }
          className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border shadow-md"
        >
          {items.map((item, i) => {
            const prevKind = items[i - 1]?.kind
            return (
              <Fragment key={`${item.kind}:${item.keyword}`}>
                {item.kind === 'history' && prevKind !== 'history' && (
                  <li
                    role="presentation"
                    className="text-muted-foreground flex items-center justify-between px-3 pt-2 pb-1 text-xs font-medium"
                  >
                    <span>{t('videoSearch.searchHistory')}</span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        latestRound.current++
                        void clearSearchHistoryApi()
                          .then(() => {
                            setHistory([])
                            setActiveIndex(-1)
                          })
                          .catch(() => {})
                      }}
                      className="hover:text-foreground cursor-pointer"
                    >
                      {t('videoSearch.clearHistory')}
                    </button>
                  </li>
                )}
                {item.kind === 'trending' && prevKind !== 'trending' && (
                  <li
                    role="presentation"
                    className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium"
                  >
                    {t('videoSearch.trending')}
                  </li>
                )}
                <li
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitPick(item.keyword)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'cursor-pointer px-3 py-1.5 text-sm',
                    i === activeIndex && 'bg-accent',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {item.kind === 'trending' ? item.label : item.keyword}
                    </span>
                    {item.kind === 'history' && (
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation()
                          removeHistoryItem(item.keyword)
                        }}
                      >
                        <X className="size-3.5" />
                      </span>
                    )}
                  </span>
                </li>
              </Fragment>
            )
          })}
        </ul>
      )}
    </div>
  )
}
