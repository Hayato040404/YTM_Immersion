# YTM_Immersion

**YouTube Music の Web 版の再生UIをApple Music風の歌詞プレイヤーに変える拡張機能です。**

---

## 📱 Web 版 (iPhone 対応)

このリポジトリには、拡張機能の体験をそのままブラウザ単体で届ける **Web 版 (`web/`)** があります。GitHub Pages に置くだけで iPhone から使えます。

### できること

- **MP3 / 音声ファイル** と **YouTube リンク・曲名検索** の両方で再生
- 歌詞はすべて **SimpMusic Lyrics** (`api-lyrics.simpmusic.org`) から取得。単語同期(richSync)を持つ曲は Apple Music と同じ塗りアニメーションで流れます
- 曲名検索・YouTube リンクは videoId で曲を一意に特定。MP3 は曲名(+長さ)で SimpMusic を検索して最も近い曲の歌詞を借ります
- **お気に入り**・**履歴** つき。ワンタップで再再生
- UI は拡張の **PIP ウィンドウと同じ構成**をスマホ全画面にしたもの
- デスクトップ Chrome/Edge ではタブを離れたとき **Document PiP の小窓**で再生を続ける (拡張の PIP と同じ窓)
- MP3 はタブを離れても鳴り続け、ロック画面・コントロールセンター (Media Session) に曲情報と操作ボタンが出ます

### GitHub Pages への置き方

1. このリポジトリを fork または push する
2. GitHub の **Settings → Pages → Source: Deploy from a branch** で公開
3. `https://<ユーザー名>.github.io/<リポジトリ名>/web/` を開く

### iPhone での使い方

1. Safari で上の URL を開く
2. **共有 → ホーム画面に追加**。ステータスバーも含めて全画面のアプリのように立ち上がります (PWA)
3. 曲名で検索するか、YouTube リンクを貼るか、MP3 を読み込む
4. ハートを押すとお気に入りに追加。MP3 は端末内 (IndexedDB) に複製されるので、次に開いたときもそのまま再生できます

### バックグラウンド再生について

| 曲の種類 | タブを離れたとき / 他アプリを開いたとき |
| --- | --- |
| MP3 | そのまま鳴り続けます。ロック画面からも操作できます |
| YouTube | **PiP (動画の小窓)** が表示されて鳴り続けます。対応していない環境 (iOS Safari など) では OS の制限で止まります |

iOS ではブラウザが YouTube のバックグラウンド音声をシステム側で止めるため、YouTube リンクの完全なバックグラウンド再生は技術的にできません。iPhone で長時間聴く場合は MP3 を読み込ませるのが確実です。

### Web 版の構成

```
web/
├── index.html          エントリ (ホーム=検索/お気に入り/履歴 + プレイヤー)
├── manifest.json       PWA (ホーム画面に追加して全画面アプリ化)
├── icon.svg
├── css/app.css         PIP と同じ UI + 歌詞 CSS (拡張 style.css から移植)
└── js/
    ├── main.js         アプリ本体
    ├── player.js       MP3/YouTube 統一プレイヤー + Media Session
    ├── lyrics-engine.js Apple Music 風の文字同期エンジン (拡張から移植)
    ├── simpmusic.js    SimpMusic 歌詞取得 + LRC パーサ (拡張から移植)
    └── store.js        お気に入り/履歴/歌詞キャッシュ/MP3 複製
```

歌詞のアニメーションは `src/js/module/lyrics-ui.js` の核心部 (塗りの先端を 1 本の --sweep で流す方式・Web Animations による持ち上がり・臨界減衰のばねスクロール) を `lyrics-engine.js` にそのまま移植してあります。見え方の根拠や調整の話は下の「歌詞の表示」の節を参照してください。

### Web 版のテスト

```bash
node --test tests/web-port.test.mjs
```

LRC パーサ・語の組み立て・フレーズまとめ・曲候補の採点・CSS/JS の骨格が拡張と一致しているかを見ます。

---

## 特徴

* **リアルタイム歌詞同期:** LRCHubとの連携により、曲に合わせて歌詞が滑らかに追従します。
* **ガラスモーフィズムUI:** プレイヤーバーやナビゲーションバーを半透明で浮遊感のあるガラスデザインに統一。
* **操作性:** ImmersionモードOFFで、キューの確認や検索が可能です。
* **歌詞の翻訳:** Deepl APIを所得して、歌詞の翻訳ができるようになります。
* **LRC歌詞表示:** LRCファイルを読み込んで、歌詞がない曲も歌詞が出るようになります。


## プライバシー

個人を特定できる情報の収集は行っていません。通信先と送信内容、ログイン状態の扱いについては [Privacy.md](Privacy.md) に記載しています。

歌詞データの著作権は各権利者に帰属します。本拡張機能は歌詞データを保有・配信するものではなく、取得した内容を表示するのみです。
