import { HDNodeWallet } from 'ethers'

const PORTAL_ID = 'bbe62884-b0e3-4328-a20c-0544351402b5'
const API_BASE = `https://portal-api.magna.so/api/v2/${PORTAL_ID}`

function required(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

function buildSiweMessage({ address, nonce, domain = 'claim.espresso.foundation', uri = 'https://claim.espresso.foundation', chainId = 1, statement = 'Espresso' }) {
  const issuedAt = new Date().toISOString()
  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}`
}

async function getNonce(address) {
  const url = `${API_BASE}/auth/nonce?wallet=${address}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`nonce failed ${address}: ${res.status} ${res.statusText}`)
  return res.json()
}

async function signIn({ address, platform, message, signature }) {
  const res = await fetch(`${API_BASE}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: address, platform, message, signature })
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
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`accounts failed: ${res.status} ${res.statusText} ${text}`)
  }
  return res.json()
}

function deriveWallets(mnemonic, count, pathPrefix = `m/44'/60'/0'/0`) {
  const wallets = []
  for (let i = 0; i < count; i++) {
    const path = `${pathPrefix}/${i}`
    wallets.push(HDNodeWallet.fromPhrase(mnemonic, undefined, path))
  }
  return wallets
}

function pickMessage(noncePayload, address) {
  if (noncePayload?.message) return noncePayload.message
  const nonce = noncePayload?.nonce ?? noncePayload?.data?.nonce
  if (!nonce) throw new Error(`nonce payload missing nonce/message for ${address}`)

  const customTemplate = process.env.SIGN_MESSAGE_TEMPLATE
  if (customTemplate) {
    return customTemplate
      .replaceAll('{address}', address)
      .replaceAll('{nonce}', String(nonce))
  }

  return buildSiweMessage({ address, nonce: String(nonce), statement: process.env.SIWE_STATEMENT || 'Espresso' })
}

function inferEligibility(accounts) {
  const flat = JSON.stringify(accounts).toLowerCase()

  const positiveSignals = ['eligible', 'iseligible', 'canclaim', 'allocation', 'claimable', 'amount']
  const negativeSignals = ['ineligible', 'not eligible', 'not_eligible', 'noteligible', 'not claimable', 'blocked']

  const hasPositive = positiveSignals.some((s) => flat.includes(s))
  const hasNegative = negativeSignals.some((s) => flat.includes(s))

  if (hasNegative && !hasPositive) return false
  if (hasPositive) return true
  return null
}

function csvEscape(value) {
  const s = String(value ?? '')
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replaceAll('"', '""')}"`
  }
  return s
}

function toCsv(rows) {
  const header = ['index', 'address', 'privateKey', 'eligible', 'status', 'error']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([
      row.index,
      row.address,
      row.privateKey,
      row.eligible,
      row.status,
      row.error || ''
    ].map(csvEscape).join(','))
  }
  return lines.join('\n')
}

async function checkOne(wallet) {
  const address = wallet.address
  const noncePayload = await getNonce(address)
  const message = pickMessage(noncePayload, address)
  const signature = await wallet.signMessage(message)

  const login = await signIn({
    address,
    platform: process.env.PLATFORM || 'EVM',
    message,
    signature
  })

  const accessToken = login?.accessToken
  if (!accessToken) throw new Error(`no accessToken returned for ${address}`)

  const accounts = await getAccounts(accessToken)
  return {
    address,
    noncePayload,
    accounts
  }
}

async function main() {
  const mnemonic = required('MNEMONIC').trim()
  const count = Number(process.env.COUNT || 20)
  if (!Number.isInteger(count) || count <= 0) throw new Error('COUNT must be a positive integer')

  const wallets = deriveWallets(mnemonic, count)
  const rows = []

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i]
    process.stdout.write(`[${i + 1}/${wallets.length}] ${w.address} ... `)
    try {
      const out = await checkOne(w)
      const eligible = inferEligibility(out.accounts)
      console.log(`OK (${eligible === true ? 'eligible' : eligible === false ? 'ineligible' : 'unknown'})`)
      rows.push({
        index: i,
        address: w.address,
        privateKey: w.privateKey,
        eligible: eligible === null ? 'unknown' : String(eligible),
        status: 'ok',
        error: ''
      })
    } catch (err) {
      console.log('FAIL')
      rows.push({
        index: i,
        address: w.address,
        privateKey: w.privateKey,
        eligible: 'unknown',
        status: 'fail',
        error: String(err?.message || err)
      })
    }

    const sleepMs = Number(process.env.SLEEP_MS || 250)
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
  }

  const outFile = process.env.OUT_FILE || 'espresso-results.csv'
  const fs = await import('node:fs/promises')
  await fs.writeFile(outFile, toCsv(rows), 'utf8')

  const eligibleCount = rows.filter((x) => x.eligible === 'true').length
  const ineligibleCount = rows.filter((x) => x.eligible === 'false').length
  const unknownCount = rows.filter((x) => x.eligible === 'unknown').length

  console.log('\n=== SUMMARY ===')
  console.log(`checked: ${rows.length}`)
  console.log(`eligible: ${eligibleCount}`)
  console.log(`ineligible: ${ineligibleCount}`)
  console.log(`unknown: ${unknownCount}`)
  console.log(`saved: ${outFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
