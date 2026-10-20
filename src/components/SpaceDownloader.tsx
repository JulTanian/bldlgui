import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function SpaceDownloader() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [videos, setVideos] = useState<any[]>([]);
  const [error, setError] = useState("");

  const handleFetch = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError("");
    setVideos([]);
    setProgress("Đang kết nối...");

    // Lắng nghe tiến trình từ Rust gửi lên
    const unlisten = await listen("space-fetch-progress", (event: any) => {
      const { page, fetched, total } = event.payload;
      setProgress(`Đang lấy trang ${page}... (Đã lấy ${fetched}${total > 0 ? `/${total}` : ""} video)`);
    });

    try {
      // Gọi hàm Rust
      const result = await invoke<any[]>("fetch_all_space_videos", { midOrUrl: url });
      setVideos(result);
      setProgress(`Hoàn tất! Đã lấy được ${result.length} video.`);
    } catch (err: any) {
      setError(err.toString());
      setProgress("");
    } finally {
      setLoading(false);
      unlisten(); // Hủy lắng nghe
    }
  };

  return (
    <div className="p-4 border rounded-lg shadow-sm bg-background">
      <h2 className="text-lg font-bold mb-2">Tải toàn bộ kênh Bilibili</h2>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          placeholder="Dán link space (vd: https://space.bilibili.com/123456/video)"
          className="flex-1 p-2 border rounded"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={loading}
        />
        <button
          onClick={handleFetch}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
        >
          {loading ? "Đang tải..." : "Lấy danh sách"}
        </button>
      </div>

      {progress && <p className="text-blue-500 mb-2">{progress}</p>}
      {error && <p className="text-red-500 mb-2">Lỗi: {error}</p>}

      {videos.length > 0 && (
        <div className="max-h-60 overflow-y-auto border-t pt-2">
          <p className="font-semibold mb-2">Danh sách video ({videos.length}):</p>
          <ul className="space-y-1">
            {videos.map((v, idx) => (
              <li key={v.bvid} className="text-sm">
                {idx + 1}. {v.title} ({v.bvid})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
