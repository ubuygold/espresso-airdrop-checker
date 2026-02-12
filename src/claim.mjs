import { HDNodeWallet, JsonRpcProvider } from 'ethers'

const PORTAL_ID = 'bbe62884-b0e3-4328-a20c-0544351402b5'
const API_BASE = `https://portal-api.magna.so/api/v2/${PORTAL_ID}`

function required(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

function deriveWallets(mnemonic, count, pathPrefix = `m/44'/60'/0'/0`) {
  const wallets = []
  for (let i = 0; i < count; i++) {
    wallets.push(HDNodeWallet.fromPhrase(mnemonic, undefined, `${pathPrefix}/${i}`))
  }
  return wallets
}

function buildSiweMessage({ address, nonce, domain = 'claim.espresso.foundation', uri = 'https://claim.espresso.foundation', chainId = 1, statement = 'Espresso' }) {
  const issuedAt = new Date().toISOString()
  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}`
}

async function getNonce(address) {
  const res = await fetch(`${API_BASE}/auth/nonce?wallet=${address}`)
  if (!res.ok) throw new Error(`nonce failed ${address}: ${res.status} ${res.statusText}`)
  return res.json()
}

function pickMessage(noncePayload, address) {
  if (noncePayload?.message) return noncePayload.message
  const nonce = noncePayload?.nonce ?? noncePayload?.data?.nonce
  if (!nonce) throw new Error(`nonce payload missing nonce/message for ${address}`)
  const customTemplate = process.env.SIGN_MESSAGE_TEMPLATE
  if (customTemplate) return customTemplate.replaceAll('{address}', address).replaceAll('{nonce}', String(nonce))
  return buildSiweMessage({ address, nonce: String(nonce), statement: process.env.SIWE_STATEMENT || 'Espresso' })
}

async function signIn({ address, message, signature }) {
  const res = await fetch(`${API_BASE}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: address, platform: process.env.PLATFORM || 'EVM', message, signature })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`signin failed ${address}: ${res.status} ${res.statusText} ${text}`)
  }
  return res.json()
}

async function getAccounts(accessToken) {
  const res = await fetch(`${API_BASE}/submission/accounts`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`accounts failed: ${res.status} ${res.statusText} ${text}`)
  }
  return res.json()
}

function isHex(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)
}

function looksLikeAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
}

function looksLikeTxData(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(v)
}

function toBigIntValue(v) {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string') {
    if (isHex(v)) return BigInt(v)
    if (/^[0-9]+$/.test(v)) return BigInt(v)
    if (/^[0-9]+(\.[0-9]+)?$/.test(v)) {
      const [w, f = ''] = v.split('.')
      return BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))
    }
  }
  return 0n
}

function extractClaimTx(obj) {
  const candidates = []
  const seen = new Set()

  function pickTo(node) {
    return (
      node.to ||
      node.target ||
      node.contract ||
      node.contractAddress ||
      node.txTo ||
      node.destination ||
      node.spender
    )
  }

  function pickData(node) {
    return (
      node.data ||
      node.calldata ||
      node.callData ||
      node.input ||
      node.txData ||
      node.encodedData ||
      node.payload
    )
  }

  function pickValue(node) {
    return node.value ?? node.txValue ?? node.fee ?? node.nativeValue ?? node.ethValue
  }

  function walk(node, path = '$') {
    if (!node || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    const to = pickTo(node)
    const data = pickData(node)
    const value = pickValue(node)

    if (looksLikeAddress(to) && looksLikeTxData(data)) {
      candidates.push({ to, data, value: toBigIntValue(value), path })
    }

    // some APIs return tx object split across sibling keys
    if (node.tx && typeof node.tx === 'object') {
      const txTo = pickTo(node.tx)
      const txData = pickData(node.tx)
      const txValue = pickValue(node.tx)
      if (looksLikeAddress(txTo) && looksLikeTxData(txData)) {
        candidates.push({ to: txTo, data: txData, value: toBigIntValue(txValue), path: `${path}.tx` })
      }
    }

    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') walk(v, `${path}.${k}`)
    }
  }

  walk(obj)

  const byWithdraw = candidates.find((c) => c.data.slice(0, 10).toLowerCase() === '0x8612372a')
  if (byWithdraw) return byWithdraw

  // prefer candidate with non-zero value and longer calldata
  const ranked = [...candidates].sort((a, b) => {
    const av = a.value > 0n ? 1 : 0
    const bv = b.value > 0n ? 1 : 0
    if (av !== bv) return bv - av
    return (b.data?.length || 0) - (a.data?.length || 0)
  })

  return ranked[0] || null
}

async function saveDebugJson(address, payload, tag = 'accounts') {
  const fs = await import('node:fs/promises')
  const dir = process.env.DEBUG_DIR || 'debug'
  await fs.mkdir(dir, { recursive: true })
  const file = `${dir}/${tag}-${address.toLowerCase()}.json`
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
  return file
}

async function prepareClaim(wallet, provider) {
  const address = wallet.address
  const noncePayload = await getNonce(address)
  const message = pickMessage(noncePayload, address)
  const signature = await wallet.signMessage(message)
  const login = await signIn({ address, message, signature })
  const accessToken = login?.accessToken
  if (!accessToken) throw new Error('no accessToken returned')

  const accounts = await getAccounts(accessToken)

  // schema often returns eligibility status first; tx payload appears only when claim is actually available
  const eligibleList = Array.isArray(accounts?.accounts)
    ? accounts.accounts.filter((x) => x?.type === 'WALLET' && x?.isEligible === true)
    : []
  const pohPassed = accounts?.pohPassed
  const submitted = accounts?.submitted

  const tx = extractClaimTx(accounts)
  if (!tx) {
    const debugFile = await saveDebugJson(address, accounts, 'accounts')
    const hints = []
    if (submitted === true) hints.push('submitted=true')
    if (pohPassed === false) hints.push('pohPassed=false (need PoH/Authena first)')
    hints.push(`eligibleWallets=${eligibleList.length}`)
    throw new Error(`No claim tx payload in /submission/accounts. ${hints.join(', ')}. Saved: ${debugFile}`)
  }

  const claimValue = process.env.CLAIM_VALUE_WEI
    ? BigInt(process.env.CLAIM_VALUE_WEI)
    : (tx.value > 0n ? tx.value : 500000000000000n) // default 0.0005 ETH

  return {
    address,
    txRequest: {
      to: tx.to,
      data: tx.data,
      value: claimValue
    },
    sourcePath: tx.path
  }
}

function csvEscape(value) {
  const s = String(value ?? '')
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replaceAll('"', '""')}"`
  return s
}

function toCsv(rows) {
  const header = ['index', 'address', 'privateKey', 'status', 'txHash', 'to', 'valueWei', 'note']
  return [header.join(','), ...rows.map((r) => [
    r.index,
    r.address,
    r.privateKey,
    r.status,
    r.txHash || '',
    r.to || '',
    r.valueWei || '',
    r.note || ''
  ].map(csvEscape).join(','))].join('\n')
}

async function main() {
  const mnemonic = required('MNEMONIC').trim()
  const count = Number(process.env.COUNT || 20)
  const dryRun = (process.env.DRY_RUN || 'true').toLowerCase() !== 'false'
  const rpcUrl = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com'

  if (!Number.isInteger(count) || count <= 0) throw new Error('COUNT must be a positive integer')

  const provider = new JsonRpcProvider(rpcUrl)
  const wallets = deriveWallets(mnemonic, count)
  const rows = []

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i].connect(provider)
    process.stdout.write(`[${i + 1}/${wallets.length}] ${wallet.address} ... `)

    try {
      const prepared = await prepareClaim(wallet, provider)
      if (dryRun) {
        console.log(`DRY_RUN to=${prepared.txRequest.to}`)
        rows.push({
          index: i,
          address: wallet.address,
          privateKey: wallet.privateKey,
          status: 'dry_run',
          txHash: '',
          to: prepared.txRequest.to,
          valueWei: prepared.txRequest.value.toString(),
          note: `payload=${prepared.sourcePath}`
        })
      } else {
        const tx = await wallet.sendTransaction(prepared.txRequest)
        console.log(`SENT ${tx.hash}`)
        rows.push({
          index: i,
          address: wallet.address,
          privateKey: wallet.privateKey,
          status: 'sent',
          txHash: tx.hash,
          to: prepared.txRequest.to,
          valueWei: prepared.txRequest.value.toString(),
          note: `payload=${prepared.sourcePath}`
        })
      }
    } catch (err) {
      console.log('FAIL')
      rows.push({
        index: i,
        address: wallet.address,
        privateKey: wallet.privateKey,
        status: 'fail',
        txHash: '',
        to: '',
        valueWei: '',
        note: String(err?.message || err)
      })
    }

    const sleepMs = Number(process.env.SLEEP_MS || 300)
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
  }

  const outFile = process.env.OUT_FILE || 'claim-results.csv'
  const fs = await import('node:fs/promises')
  await fs.writeFile(outFile, toCsv(rows), 'utf8')

  console.log('\n=== SUMMARY ===')
  console.log(`checked: ${rows.length}`)
  console.log(`sent: ${rows.filter((x) => x.status === 'sent').length}`)
  console.log(`dry_run: ${rows.filter((x) => x.status === 'dry_run').length}`)
  console.log(`fail: ${rows.filter((x) => x.status === 'fail').length}`)
  console.log(`saved: ${outFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
