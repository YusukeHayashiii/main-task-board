# 直すとき

mod を直す人向けのメモ。使うだけなら README だけで足りる。

## 直しながら試す

```
claude --plugin-dir <このフォルダ>
```

このフォルダを直接読んで起動する。ファイルを保存すると読み直されるので、入れ直しは要らない。そのセッションの間だけ有効。

## 公開する前に

- `claude plugin validate <このフォルダ>` と `claude plugin test <このフォルダ>` を通す
- 型検査は、Claude Code がこのフォルダに `.claude-plugin/types/` を書いた後に `npx -p typescript@5.6 tsc -p <このフォルダ>` で行う
- `.claude-plugin/plugin.json` の `version` を上げる。`claude plugin update` は版の番号で新旧を比べるので、上げないと、push しても使う人の手元は差し替わらない
