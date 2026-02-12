# espresso-airdrop-checker

从助记词批量派生地址，逐个调用 Espresso(Magna Portal) 的接口检查账号数据。

## ⚠️ 安全提醒

- **不要把助记词发给任何人**（包括我）
- 建议在本地离线/隔离环境运行
- 跑完立即销毁终端历史和 `.env` 文件

## 安装

```bash
cd espresso-airdrop-checker
npm install
```

## 使用

```bash
MNEMONIC="your twelve words ..." \
COUNT=20 \
PLATFORM=EVM \
OUT_FILE=espresso-results.json \
node src/check.mjs
```

## 可选参数

- `COUNT`：派生地址数量（默认 20）
- `SLEEP_MS`：每次请求间隔（默认 250）
- `OUT_FILE`：输出文件名（默认 `espresso-results.json`）
- `SIWE_STATEMENT`：自定义 SIWE statement（默认 `Espresso`）
- `SIGN_MESSAGE_TEMPLATE`：若官方签名文案变更，可强制模板，支持占位符：
  - `{address}`
  - `{nonce}`

示例：
```bash
SIGN_MESSAGE_TEMPLATE="Sign-in for Espresso\nAddress: {address}\nNonce: {nonce}"
```

## 结果说明

输出文件中每项包含：
- `index`
- `address`
- `ok`（是否登录+查询成功）
- `data`（接口返回）或 `error`

## 已用接口（前端抓取）

- `GET /auth/nonce?wallet={address}`
- `POST /auth/signin`
- `GET /submission/accounts` (Bearer token)

Base:
`https://portal-api.magna.so/api/v2/bbe62884-b0e3-4328-a20c-0544351402b5`
