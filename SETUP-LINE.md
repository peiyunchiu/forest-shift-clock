# 用 LINE 打卡 — 設定步驟

照著做大約 30 分鐘。**所有鑰匙都是你自己貼進去的，不用給任何人。**

做完之後：在 LINE 按「上班」→ 機器人回「✅ Chloe 上班 16:02」→ 紀錄進 GitHub → 網站看得到，三個人同一本帳。

---

## A. 讓 `punch in/out` 會講話（約 8 分鐘）

LINE 官方帳號預設只會回罐頭訊息，要能記時間得先開 Messaging API。

1. 開 [LINE Official Account Manager](https://manager.line.biz) → 點 **punch in/out**
2. 右上角 **設定** → 左邊選 **Messaging API** → 按 **啟用 Messaging API**
   - 會問你要哪個 Provider（就是「擁有者」的意思），沒有就建一個，名字打「靜謐森林屋」
3. 啟用完，同一頁的左邊選 **回應設定**，調成：
   - **聊天** → 關閉（不然客服模式會擋掉機器人）
   - **自動回應訊息** → 關閉
   - **Webhook** → 開啟
4. 開 [LINE Developers Console](https://developers.line.biz/console/) → 進剛剛那個 channel → 上面選 **Messaging API** 分頁
5. 拉到最下面 **Channel access token (long-lived)** → 按 **Issue** → 複製那串
   👉 這是 **鑰匙 1（LINE_TOKEN）**，先貼在記事本

---

## B. 拿一把 GitHub 鑰匙（約 5 分鐘）

機器人要能把打卡寫進 repo。

1. 開 [GitHub Tokens 頁面](https://github.com/settings/personal-access-tokens/new)（會要你登入）
2. 填：
   - **Token name**：`forest-shift-clock 打卡機器人`
   - **Expiration**：選 **No expiration**（或一年，到期要重發）
   - **Repository access** → 選 **Only select repositories** → 勾 **forest-shift-clock**
   - **Permissions** → **Repository permissions** → 找到 **Contents** → 改成 **Read and write**
3. 按 **Generate token** → 複製
   👉 這是 **鑰匙 2（GH_TOKEN）**。**只會顯示這一次**，關掉就看不到了

---

## C. 建機器人的大腦（約 10 分鐘）

1. 開 [script.google.com](https://script.google.com) → 左上 **新增專案** → 專案改名「森林屋打卡機器人」
2. 把[這個檔案的全部內容](https://github.com/peiyunchiu/forest-shift-clock/blob/main/apps-script/Code.gs)複製，**整個貼掉** `Code.gs` 裡原本的東西 → 存檔（Ctrl/Cmd + S）
3. 左邊齒輪 **專案設定** → 拉到最下面 **指令碼屬性** → **新增指令碼屬性**，一項一項加：

   | 屬性 | 值 |
   |---|---|
   | `LINE_TOKEN` | 鑰匙 1（A 步驟複製的那串） |
   | `GH_TOKEN` | 鑰匙 2（B 步驟複製的那串） |
   | `GH_REPO` | `peiyunchiu/forest-shift-clock` |
   | `GH_PATH` | `data/records.json` |
   | `WEB_KEY` | 自己想一組通關密語，例如 `forest0821`（等一下網站要填同一組） |
   | `SITE_URL` | `https://peiyunchiu.github.io/forest-shift-clock/` |

   全部填完按 **儲存指令碼屬性**

4. 回編輯器，上方函式選單選 **checkSetup** → 按 **執行**
   - 第一次會跳授權：**審查權限 → 選你的 Google 帳號 → 進階 → 前往「森林屋打卡機器人」→ 允許**
   - 下方紀錄應該全部 ✅。有 ❌ 就照上面的表回去補
5. 函式選單改選 **setupRichMenu** → **執行** → 看到「圖文選單建好了 ✅」就成功
6. 右上 **部署 → 新增部署** → 齒輪選 **網頁應用程式** →
   - **執行身分**：我自己
   - **誰可以存取**：**所有人** ← 這個一定要選對，不然 LINE 送不進來
   - 按 **部署** → 複製那串 **網頁應用程式網址**（`.../exec` 結尾）
   👉 這是 **後端網址**

---

## D. 把 LINE 接上大腦（約 2 分鐘）

1. 回 [LINE Developers Console](https://developers.line.biz/console/) → Messaging API 分頁
2. **Webhook URL** → 貼上剛剛的後端網址 → **Update** → 按 **Verify**，看到 Success 就對了
3. 下面的 **Use webhook** 打開

---

## E. 網站接上同一本帳（約 1 分鐘）

1. 開 <https://peiyunchiu.github.io/forest-shift-clock/> → **設定** 分頁
2. **LINE ／ 雲端同步**：
   - 後端網址：貼 C-6 那串
   - 通關密語：填 `WEB_KEY` 那組
3. 按 **連線並同步** → 標題列出現 ☁️ 就成功

---

## F. 三個人加好友、認人（約 3 分鐘）

1. LINE OA Manager → **主頁 → 加入好友的管道** → 拿 QR code 或網址，三個人都加
2. 每個人第一次傳訊息時，機器人會問「你是誰」→ 點自己的名字（或直接打「我是 Kobe」）
3. 綁好後按下面的選單就能打卡

---

## 選單上的按鈕

| 按鈕 | 做什麼 |
|---|---|
| **上班** | 記下現在時間當上班時間 |
| **下班** | 記下班時間，順便回報今天做了幾小時、加班還是不足 |
| **折備品** | ＋1 小時進帳戶。同一天按兩次就是 2 小時；也可以打「折備品 2」直接指定 |
| **今日** | 三個人今天各自的狀況 |
| **時數** | 我的折抵帳戶：累積、已抵、還可以抵幾小時 |
| **網站** | 開排班表／統計／補登（抵休、改時間這些在網站做） |

打字也行，不一定要按選單：上班、下班、折備品、今日、時數。

---

## 幾件要知道的事

- **這個後端網址等於一把鑰匙**，別貼到公開的地方。Google Apps Script 收不到 LINE 的驗證標頭，所以網址外流的話別人就能偽造打卡。
- **打卡紀錄是公開的**（你選的）。`data/records.json` 在公開 repo 裡，任何人拿到網址都看得到誰幾點上下班。之後想改成私密再跟我說。
- **照片不會上雲端**。LINE 打卡本來就沒照片；網頁拍的照片只留在拍照的那台裝置。
- **改了程式碼要重新部署**才會生效：部署 → **管理部署** → 鉛筆 → 版本選 **新版本** → 部署。網址不會變。
- 機器人壞掉時，網站本身照常能用（會顯示 ⚠️），修好後未同步的紀錄會自動補上去。
