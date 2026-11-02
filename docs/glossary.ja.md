# 用語集（日本語と英語の対訳）

画面の文言を訳すときの訳語の基準。辞書は `src/i18n/ja.json`（日本語）と `src/i18n/en.json`（英語、基準の言語）。
JSON の中身（キーと値）は訳さない。

| 日本語 | English | 使い方 |
|---|---|---|
| 表 | table | 表の表示。上流の `modeTable`（英語は小文字の `table`） |
| ツリー | tree | ツリーの表示 |
| テキスト | text | テキストの表示 |
| 表示 | view / mode | 上の 3 つの切り替え。「モード」とは書かない |
| 文書 | document | 開いている JSON 全体 |
| 行 | row | 表の 1 行 |
| 列 | column | 表の 1 列 |
| セル | cell | 表の 1 マス |
| キー | key | オブジェクトのキー |
| 値 | value | |
| 配列 | array | |
| オブジェクト | object | |
| 項目 | item | 配列の要素、`New item` の訳は「新しい項目」 |
| 件 | items | 個数の単位 |
| パス | path | 値の場所 |
| 修復 | repair | 不正な JSON を直すこと |
| 整形 | format | インデントと改行を入れる |
| 圧縮 | compact | 空白と改行を取り除く |
| 並べ替え | sort | |
| 絞り込み | filter | |
| 変換 | transform | 絞り込み、並べ替え、抽出をまとめた操作 |
| 抽出 | extract | |
| 検索 | search / find | |
| 置換 | replace | |
| 切り取り | cut | |
| コピー | copy | |
| 貼り付け | paste | |
| すべて選択 | select all | |
| 元に戻す | undo | |
| やり直す | redo | |
| 適用 | apply | ダイアログの確定 |
| 未保存 | unsaved | 保存していない変更 |
| 保存 | save | |
| 名前を付けて保存 | save as | |
| 対象 | target | 表にする配列の場所（「表の対象」） |
| 文字コード | character encoding | UTF-8 など |
| 履歴 | history | 最近開いたファイル |
| 言語 | language | オプションの項目 |
| ダーク、ライト | dark、light | 配色 |
| 診断 | diagnostics | CodeMirror の用語 |

## 辞書に載せない文字列（除外表）

理由つきの一覧は `tests/unit/i18nExclusions.ts`。検査 `tests/unit/i18nCoverage.test.ts` が通る間は、一覧にない直書きは無い。
