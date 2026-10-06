# vlc-chat-pwa-spike

[vlc-chat-pwa](https://github.com/5cd8/vlc-chat-pwa)（Issue #1）の **Phase 0 スパイク**。計画書 8節の S1・S2 を iPhone 実機で確かめるための、使い捨ての検証ページ。**本実装には持ち込まない。**

- `index.html`・`spike.js`：検証ページ（ビルド不要。Mediabunny 1.61.3 は jsDelivr から読むので、iPhone がオンラインであること）
- `.github/workflows/pages.yml`：`main` への push で GitHub Pages に公開（`index.html`・`spike.js` だけを公開する）
- `tools/gen-fixtures.sh`：テスト用の合成MKVを作る（要 ffmpeg。使い方はスクリプト冒頭）。出力先は `fixtures/`（コミットしない）

## 公開前にユーザーが行うこと（設定変更）
リポジトリの Settings → Pages → Source を「GitHub Actions」にする。（`main` から公開するので、環境のブランチ許可の変更は要らない。）

## iPhone での確認手順
ページを開き、上から順に確認する。結果は「ログをコピー」でメモアプリ等に貼り、Claude に渡す。

1. **S1-a ファイル選択（U1）**：①〜⑥のボタンで、動画・`.mkv`・`.json`・`.sqlite` を選ぶ。選べるか、複数選べるか、表の size・type・先頭16B が元ファイルと同じか。動画は**「ファイル」アプリから選んだ場合**と**写真ライブラリから選んだ場合**の両方を試す。
2. **S1-b ネイティブ再生（U2・U9）**：MP4/MOV/WebM を選んで「ネイティブ再生」。1時間以上の連続再生と何度ものシークで、タブが落ちない（ページの読み込み回数が増えない）か。VP9+Opus・AV1+Opus の WebM も試す。長いGOPのMP4（`fixtures/` の20Mbps・GOP 60秒のMKVを `ffmpeg -i x.mkv -c copy x.mp4` で変換したもの）も。
3. **S2（U3〜U7・U10・U11）**：
   - 「isTypeSupported 一覧」を押して結果を控える（U3）。
   - 「トラックとGOPを調べる」で、コーデック文字列・メタデータの再生時間（U6）・GOP を見る。
   - 「MSEで読み込む」→ video の再生ボタン。倍速（U7）、シーク、`fixtures/` の5本（GOP 5〜60秒）で、Quota（U11）・停止・タブ再読み込みが起きる条件を探す。
   - 診断欄の「最大フラグメント」「Quota」「ローテーション」と、ログの `QuotaExceededError`・`致命的` を見る。
4. 落ちた・再読み込みされた場合は、ページを開き直すと先頭の「前回の最終状態」に直前の状況が出る。

## 計画書との対応
手順3（直列キュー）：`OpQueue`／手順4（流量制御）：`waitForRoom`／手順5（後方削除）：`evict`／手順6〜7（世代切替・シーク）：`handleSeeking`／手順2のローテーション：`pump` 内。

## デスクトップでの動作確認（済）
Chrome（`MediaSource`）で、MKV の読み込み、60秒ぶんの供給（`Output` のローテーション5回で継ぎ目は途切れない）、後方削除、バッファ外へのシークの復帰を確認した。iPhone の WebKit での挙動は未確認。
