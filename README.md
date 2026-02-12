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
OUT_FILE=espresso-results.csv \
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

默认输出 CSV（`espresso-results.csv`），列为：
- `index`
- `address`
- `privateKey`
- `eligible`（`true`/`false`/`unknown`）
- `status`（`ok`/`fail`）
- `error`

## 交易分析（判断是否 Espresso 真实领取）

新增脚本：`src/analyze-tx.mjs`

用途：
- 输入一个 tx hash
- 自动从 Ethereum RPC 拉取 tx + receipt
- 检查是否符合 Espresso claim 典型特征：
  - 链为 Ethereum mainnet
  - 方法选择器为 `0x8612372a`（withdraw）
  - `value` 为 `0.0005 ETH`
  - 事件日志里存在 ESP token 转账

运行：
```bash
TX_HASH=0x... OUT_FILE=tx-analysis.json node src/analyze-tx.mjs
```

可选：
- `ETH_RPC`：自定义 RPC（默认 `https://ethereum-rpc.publicnode.com`）

## 已用接口（前端抓取）

- `GET /auth/nonce?wallet={address}`
- `POST /auth/signin`
- `GET /submission/accounts` (Bearer token)

Base:
`https://portal-api.magna.so/api/v2/bbe62884-b0e3-4328-a20c-0544351402b5`
