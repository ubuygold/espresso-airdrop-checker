const ETH_RPC = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com'

const KNOWN = {
  espressoPortalId: 'bbe62884-b0e3-4328-a20c-0544351402b5',
  expectedChainIdHex: '0x1',
  expectedClaimFeeEth: 0.0005,
  expectedEspToken: '0x031De51F3E8016514Bd0963d0B2AB825A591Db9A'.toLowerCase(),
  knownSelectors: {
    '0x8612372a': 'withdraw(uint256,uint32,bytes,bytes32[])'
  }
}

function required(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

function hexToBigInt(hex) {
  return BigInt(hex || '0x0')
}

function formatEth(wei) {
  const base = 10n ** 18n
  const whole = wei / base
  const frac = wei % base
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : `${whole}`
}

function normalizeAddress(addr) {
  return (addr || '').toLowerCase()
}

function getSelector(input) {
  if (!input || input === '0x' || input.length < 10) return null
  return input.slice(0, 10).toLowerCase()
}

function topicToAddress(topic) {
  return `0x${topic.slice(-40)}`.toLowerCase()
}

async function rpc(method, params) {
  const res = await fetch(ETH_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  if (!res.ok) throw new Error(`${method} failed: ${res.status} ${res.statusText}`)
  const json = await res.json()
  if (json.error) throw new Error(`${method} rpc error: ${JSON.stringify(json.error)}`)
  return json.result
}

function analyze({ tx, receipt }) {
  const selector = getSelector(tx.input)
  const method = selector ? (KNOWN.knownSelectors[selector] || 'unknown') : 'unknown'

  const transferSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const tokenTransfers = (receipt.logs || []).filter((l) => (l.topics?.[0] || '').toLowerCase() === transferSig)

  const espTransfers = tokenTransfers
    .filter((l) => normalizeAddress(l.address) === KNOWN.expectedEspToken)
    .map((l) => ({
      token: l.address,
      from: topicToAddress(l.topics[1]),
      to: topicToAddress(l.topics[2]),
      valueRaw: hexToBigInt(l.data).toString(),
      valueEsp: Number(hexToBigInt(l.data)) / 1e18
    }))

  const valueWei = hexToBigInt(tx.value)
  const feeEth = Number(formatEth(valueWei))

  const checks = {
    chainIsEthereumMainnet: tx.chainId?.toLowerCase() === KNOWN.expectedChainIdHex,
    methodLooksLikeWithdraw: selector === '0x8612372a',
    claimFeeMatches00005: Math.abs(feeEth - KNOWN.expectedClaimFeeEth) < 1e-12,
    hasEspTransferLog: espTransfers.length > 0
  }

  const score = Object.values(checks).filter(Boolean).length
  const likelyEspressoClaim = score >= 3

  return {
    txHash: tx.hash,
    from: tx.from,
    to: tx.to,
    chainId: tx.chainId,
    valueEth: formatEth(valueWei),
    gasUsed: Number(hexToBigInt(receipt.gasUsed)),
    selector,
    method,
    checks,
    likelyEspressoClaim,
    espTransfers
  }
}

async function main() {
  const txHash = required('TX_HASH').trim()

  const [tx, receipt] = await Promise.all([
    rpc('eth_getTransactionByHash', [txHash]),
    rpc('eth_getTransactionReceipt', [txHash])
  ])

  if (!tx) throw new Error(`tx not found: ${txHash}`)
  if (!receipt) throw new Error(`receipt not found: ${txHash}`)

  const result = analyze({ tx, receipt })

  const outFile = process.env.OUT_FILE || 'tx-analysis.json'
  const fs = await import('node:fs/promises')
  await fs.writeFile(outFile, JSON.stringify(result, null, 2), 'utf8')

  console.log('=== TX ANALYSIS ===')
  console.log(`tx: ${result.txHash}`)
  console.log(`likelyEspressoClaim: ${result.likelyEspressoClaim}`)
  console.log(`method: ${result.method} (${result.selector})`)
  console.log(`to: ${result.to}`)
  console.log(`valueEth: ${result.valueEth}`)
  console.log(`espTransfers: ${result.espTransfers.length}`)
  console.log(`saved: ${outFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
