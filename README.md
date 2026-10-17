# Ripple

Ripple 是一個離線優先的協作看板：沒有帳號系統，也不依賴雲端資料庫。每台設備都保存完整的 op 日誌，協作時以版本向量交換增量；服務器只做中繼，不參與衝突判定。

## 本機啟動

需要 Node.js 18 或更新版本，不需要 `npm install`。

```sh
npm test
npm start
```

瀏覽器打開 `http://localhost:8787`。在手機上，用同一個區域網路裡電腦的 IP 取代 `localhost`，例如 `http://192.168.1.20:8787`。要讓手機安裝 PWA，正式部署請使用 HTTPS；localhost 是唯一允許 HTTP 安裝 service worker 的例外。

預設服務器把 op 日誌存在 `.data/`。純靜態／單機使用：

```sh
npm run dev
```

`--static-only` 會停用 WebSocket，但離線本機功能仍可用。

## 架構

- `src/js/crdt/doc.js`：op 集合、LWW register、OR-Set、RGA、快照合併。
- `src/js/crdt/board.js`：列、卡片、標籤、評論、搜索與統計領域層。
- `src/js/sync/engine.js`：雙向版本向量握手、離線隊列、重連與持久化。
- `src/js/sync/crypto.js`：AES-GCM 端到端加密。密鑰留在 URL `#` 片段，本身不會送到服務器。
- `server/hub.js`：零知識房間中繼；按 op id 去重，保存信封與快照，不讀懂載荷。
- `server/ws.js`：零依賴 RFC 6455 WebSocket 編解碼。
- `server/persist.js`：每個房間一份 JSONL 日誌，可恢復及壓縮。

## 同步語義

操作使用混合邏輯時鐘，並按 `(wall, counter, node, seq)` 決定 LWW 勝者。實體刪除是帶墓碑的 LWW 存活狀態；標籤使用 Observed-Remove Set；文本使用 RGA。合併 op 是集合併集，具備交換律、結合律與冪等性。

文本編輯器採碼點粒度。這能保護 UTF-16 代理對，但 Unicode grapheme（例如 ZWJ emoji）會由多個 RGA 元素組成；不同設備在同一組合字內並發編輯時，可能出現字形拆分。衝突不會丟字，但顯示結果依確定性排序而定。

服務器預設每房間最多保存 20,000 條 op，超限時推進地平線。要避免舊客戶端從增量日誌恢復，長期部署需要定期保存客戶端快照；服務器把快照當不透明資料保存，不會替客戶端產生語義快照。服務器重啟後從 JSONL 恢復。

## 加密與威脅模型

房間 ID 是房間名與密鑰的 SHA-256 截斷值；載荷以 AES-GCM 加密。中繼能看見節點 ID、操作序號、HLC 時間戳、操作數量與近似密文長度，這些元資料沒有隱藏。丟失 URL 片段中的密鑰即無法解密。客戶端端到端加密不是對惡意瀏覽器程式碼的防護：若部署者控制靜態 JS，仍能在使用者輸入時讀取資料。

## 測試

```sh
npm test       # node:test：單元、屬性、fuzz、整合及真實 HTTP/WebSocket
npm run check  # 靜態審計 + 全套測試
npm run fuzz   # 更長的隨機副本交錯測試
npm run bench  # 可重現效能基準
```

基準不設跨機器的絕對門檻；結果用來比較同一設備、同一版本的回歸。
