const PEM_DASHES = '-----'
const PEM_WORD_BEGIN = 'BEGIN '
const PEM_WORD_END = 'END '
const LABEL_CERT = 'CERTIFICATE'
const LABEL_PKCS8 = 'PRIVATE KEY'
const LABEL_PKCS8_ENC = 'ENCRYPTED PRIVATE KEY'
const LABEL_RSA = 'RSA PRIVATE KEY'
const LABEL_EC = 'EC PRIVATE KEY'

export const KOBRA_CLIENT_CERT_COMMON_NAME = 'AnycubicSlicer'

export type KobraClientCertErrorReason =
  'missing' | 'unreadable' | 'wrong-subject' | 'expired'

export type KobraClientCertMetadata = {
  subject: string
  commonName: string | null
  notBefore: number
  notAfter: number
  notBeforeIso: string
  notAfterIso: string
  fingerprintSha256: string
}

export type KobraClientCertValidated =
  | {
      ok: true
      format: 'pem' | 'pkcs12'
      metadata: KobraClientCertMetadata
      certificatePem: string
      keyPem: string
    }
  | {
      ok: false
      reason: KobraClientCertErrorReason
      message: string
      metadata?: Partial<KobraClientCertMetadata>
    }

function wrapPem(label: string, der: Uint8Array): string {
  const b64 = bytesToBase64(der)
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64))
  return (
    PEM_DASHES +
    PEM_WORD_BEGIN +
    label +
    PEM_DASHES +
    '\n' +
    lines.join('\n') +
    '\n' +
    PEM_DASHES +
    PEM_WORD_END +
    label +
    PEM_DASHES +
    '\n'
  )
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const clean = b64.replace(/[\r\n\s]+/g, '')
  if (
    !clean ||
    clean.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)
  ) {
    throw new Error('Invalid base64 payload')
  }
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(clean, 'base64')
    const out = new Uint8Array(buf.length)
    out.set(buf)
    return out
  }
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

type DerNode = {
  tag: number
  constructed: boolean
  headerLength: number
  valueStart: number
  valueLength: number
  end: number
  rawStart: number
}

function readDer(
  bytes: Uint8Array,
  offset: number,
  limit = bytes.length,
): DerNode {
  if (offset >= limit) throw new Error('Truncated DER node')
  const tag = bytes[offset]!
  const constructed = (tag & 0x20) !== 0
  if ((tag & 0x1f) === 0x1f) throw new Error('Unsupported high-tag DER node')
  if (offset + 1 >= limit) throw new Error('Truncated DER length')
  const lenByte = bytes[offset + 1]!
  let headerLength = 2
  let valueLength = 0
  if ((lenByte & 0x80) === 0) {
    valueLength = lenByte
  } else {
    const count = lenByte & 0x7f
    if (count === 0 || count > 4 || offset + 1 + count >= limit) {
      throw new Error('Unsupported DER length encoding')
    }
    headerLength = 2 + count
    for (let i = 0; i < count; i++) {
      valueLength = (valueLength << 8) | bytes[offset + 2 + i]!
    }
  }
  const valueStart = offset + headerLength
  const end = valueStart + valueLength
  if (valueLength < 0 || end > limit)
    throw new Error('DER length exceeds bounds')
  return {
    tag,
    constructed,
    headerLength,
    valueStart,
    valueLength,
    end,
    rawStart: offset,
  }
}

function readDerChildren(bytes: Uint8Array, node: DerNode): DerNode[] {
  const children: DerNode[] = []
  let pos = node.valueStart
  while (pos < node.end) {
    const child = readDer(bytes, pos, node.end)
    children.push(child)
    pos = child.end
  }
  if (pos !== node.end) throw new Error('Malformed constructed DER node')
  return children
}

function decodeOid(bytes: Uint8Array, node: DerNode): string {
  if (node.tag !== 0x06 || node.valueLength < 1) throw new Error('Expected OID')
  const first = bytes[node.valueStart]!
  const arcs: number[] = [Math.floor(first / 40), first % 40]
  let acc = 0
  let inArc = false
  for (let i = node.valueStart + 1; i < node.end; i++) {
    const b = bytes[i]!
    acc = (acc << 7) | (b & 0x7f)
    inArc = true
    if ((b & 0x80) === 0) {
      arcs.push(acc)
      acc = 0
      inArc = false
    }
  }
  if (inArc) throw new Error('Truncated OID')
  return arcs.join('.')
}

function decodeDerString(bytes: Uint8Array, node: DerNode): string {
  const slice = bytes.subarray(node.valueStart, node.end)
  // BMPString (0x1e): big-endian UTF-16
  if (node.tag === 0x1e) {
    let out = ''
    for (let i = 0; i + 1 < slice.length; i += 2) {
      out += String.fromCharCode((slice[i]! << 8) | slice[i + 1]!)
    }
    return out
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(slice)
}

function decodeDerIntegerBytes(bytes: Uint8Array, node: DerNode): Uint8Array {
  if (node.tag !== 0x02 || node.valueLength < 1)
    throw new Error('Expected INTEGER')
  let start = node.valueStart
  while (start < node.end - 1 && bytes[start] === 0) start++
  return bytes.subarray(start, node.end)
}

function decodeSmallInt(bytes: Uint8Array, node: DerNode): number {
  if (node.tag !== 0x02 || node.valueLength < 1 || node.valueLength > 6) {
    throw new Error('Expected small INTEGER')
  }
  let v = 0
  for (let i = node.valueStart; i < node.end; i++) v = v * 256 + bytes[i]!
  return v
}

function parseAsn1Time(bytes: Uint8Array, node: DerNode): number {
  const raw = new TextDecoder('ascii').decode(
    bytes.subarray(node.valueStart, node.end),
  )
  if (node.tag === 0x17) {
    // UTCTime: YYMMDDHHMMSSZ
    const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(raw)
    if (!m) throw new Error('Invalid UTCTime')
    const yy = Number(m[1])
    const year = yy >= 50 ? 1900 + yy : 2000 + yy
    return Date.UTC(
      year,
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    )
  }
  if (node.tag === 0x18) {
    // GeneralizedTime: YYYYMMDDHHMMSSZ
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(
      raw,
    )
    if (!m) throw new Error('Invalid GeneralizedTime')
    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    )
  }
  throw new Error('Unsupported X.509 time tag')
}

const ATTR_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
}

type ParsedX509 = {
  subject: string
  commonName: string | null
  notBefore: number
  notAfter: number
  spkiDer: Uint8Array
  publicAlgorithmOid: string
  rsaModulus: Uint8Array | null
  ecPoint: Uint8Array | null
}

function parseX509Der(der: Uint8Array): ParsedX509 {
  const root = readDer(der, 0, der.length)
  if (root.tag !== 0x30 || root.end !== der.length) {
    throw new Error('Invalid X.509 certificate structure')
  }
  const certParts = readDerChildren(der, root)
  if (certParts.length !== 3) throw new Error('Invalid X.509 certificate parts')
  const tbs = certParts[0]!
  if (tbs.tag !== 0x30) throw new Error('Invalid tbsCertificate')
  const fields = readDerChildren(der, tbs)
  let idx = 0
  if (fields[0]?.tag === 0xa0) idx++ // optional [0] EXPLICIT version
  // serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
  if (fields.length < idx + 6) throw new Error('Truncated tbsCertificate')
  const validity = fields[idx + 3]!
  const subjectNode = fields[idx + 4]!
  const spkiNode = fields[idx + 5]!
  if (
    validity.tag !== 0x30 ||
    subjectNode.tag !== 0x30 ||
    spkiNode.tag !== 0x30
  ) {
    throw new Error('Malformed X.509 fields')
  }
  const validityChildren = readDerChildren(der, validity)
  if (validityChildren.length !== 2) throw new Error('Malformed X.509 validity')
  const notBefore = parseAsn1Time(der, validityChildren[0]!)
  const notAfter = parseAsn1Time(der, validityChildren[1]!)

  const rdns = readDerChildren(der, subjectNode)
  const parts: string[] = []
  let commonName: string | null = null
  for (const rdn of rdns) {
    if (rdn.tag !== 0x31) continue
    for (const atv of readDerChildren(der, rdn)) {
      if (atv.tag !== 0x30) continue
      const pair = readDerChildren(der, atv)
      if (pair.length !== 2) continue
      const oid = decodeOid(der, pair[0]!)
      const val = decodeDerString(der, pair[1]!)
      const label = ATTR_NAMES[oid] ?? oid
      parts.push(`${label}=${val}`)
      if (oid === '2.5.4.3') commonName = val
    }
  }
  const subject = parts.join(', ')

  const spkiDer = der.subarray(spkiNode.rawStart, spkiNode.end)
  const spkiChildren = readDerChildren(der, spkiNode)
  if (
    spkiChildren.length !== 2 ||
    spkiChildren[0]!.tag !== 0x30 ||
    spkiChildren[1]!.tag !== 0x03
  ) {
    throw new Error('Invalid SPKI')
  }
  const algChildren = readDerChildren(der, spkiChildren[0]!)
  const publicAlgorithmOid = decodeOid(der, algChildren[0]!)
  const spkiBitStart = spkiChildren[1]!.valueStart
  if (spkiChildren[1]!.valueLength < 2 || der[spkiBitStart] !== 0) {
    throw new Error('Invalid SPKI bit string')
  }
  const keyBits = der.subarray(spkiBitStart + 1, spkiChildren[1]!.end)
  let rsaModulus: Uint8Array | null = null
  let ecPoint: Uint8Array | null = null
  if (publicAlgorithmOid === '1.2.840.113549.1.1.1') {
    const rsaPub = readDer(keyBits, 0, keyBits.length)
    const rsaFields = readDerChildren(keyBits, rsaPub)
    if (rsaFields.length < 2) throw new Error('Invalid RSA SPKI')
    rsaModulus = decodeDerIntegerBytes(keyBits, rsaFields[0]!)
  } else if (publicAlgorithmOid === '1.2.840.10045.2.1') {
    ecPoint = keyBits
  }

  return {
    subject,
    commonName,
    notBefore,
    notAfter,
    spkiDer,
    publicAlgorithmOid,
    rsaModulus,
    ecPoint,
  }
}

type ParsedPrivateKey = {
  algorithmOid: string
  rsaModulus: Uint8Array | null
  ecPoint: Uint8Array | null
  canonicalDer: Uint8Array
  canonicalLabel: string
}

function parseUnencryptedPrivateKeyDer(
  der: Uint8Array,
  label: string,
): ParsedPrivateKey {
  const root = readDer(der, 0, der.length)
  if (root.tag !== 0x30 || root.end !== der.length) {
    throw new Error('Malformed private key ASN.1')
  }
  const children = readDerChildren(der, root)
  if (label === LABEL_RSA) {
    if (children.length < 9 || children[1]!.tag !== 0x02) {
      throw new Error('Malformed RSA private key')
    }
    return {
      algorithmOid: '1.2.840.113549.1.1.1',
      rsaModulus: decodeDerIntegerBytes(der, children[1]!),
      ecPoint: null,
      canonicalDer: der,
      canonicalLabel: LABEL_RSA,
    }
  }
  if (label === LABEL_EC) {
    // ECPrivateKey ::= SEQUENCE { version INTEGER(1), privateKey OCTET STRING, parameters [0] OPTIONAL, publicKey [1] OPTIONAL }
    if (children.length < 2 || children[1]!.tag !== 0x04) {
      throw new Error('Malformed EC private key')
    }
    let ecPoint: Uint8Array | null = null
    for (const child of children) {
      if (child.tag === 0xa1) {
        const inner = readDerChildren(der, child)[0]
        if (
          inner?.tag === 0x03 &&
          inner.valueLength >= 2 &&
          der[inner.valueStart] === 0
        ) {
          ecPoint = der.subarray(inner.valueStart + 1, inner.end)
        }
      }
    }
    return {
      algorithmOid: '1.2.840.10045.2.1',
      rsaModulus: null,
      ecPoint,
      canonicalDer: der,
      canonicalLabel: LABEL_EC,
    }
  }
  // PKCS#8 PrivateKeyInfo
  if (
    children.length < 3 ||
    children[0]!.tag !== 0x02 ||
    children[1]!.tag !== 0x30 ||
    children[2]!.tag !== 0x04
  ) {
    throw new Error('Malformed PKCS#8 private key')
  }
  const algChildren = readDerChildren(der, children[1]!)
  const algOid = decodeOid(der, algChildren[0]!)
  const inner = der.subarray(children[2]!.valueStart, children[2]!.end)
  if (algOid === '1.2.840.113549.1.1.1') {
    const innerParsed = parseUnencryptedPrivateKeyDer(inner, LABEL_RSA)
    return {
      algorithmOid: algOid,
      rsaModulus: innerParsed.rsaModulus,
      ecPoint: null,
      canonicalDer: der,
      canonicalLabel: LABEL_PKCS8,
    }
  }
  if (algOid === '1.2.840.10045.2.1') {
    const innerParsed = parseUnencryptedPrivateKeyDer(inner, LABEL_EC)
    return {
      algorithmOid: algOid,
      rsaModulus: null,
      ecPoint: innerParsed.ecPoint,
      canonicalDer: der,
      canonicalLabel: LABEL_PKCS8,
    }
  }
  return {
    algorithmOid: algOid,
    rsaModulus: null,
    ecPoint: null,
    canonicalDer: der,
    canonicalLabel: LABEL_PKCS8,
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function keysMatch(cert: ParsedX509, key: ParsedPrivateKey): boolean {
  if (cert.publicAlgorithmOid !== key.algorithmOid) return false
  if (cert.rsaModulus && key.rsaModulus) {
    return bytesEqual(cert.rsaModulus, key.rsaModulus)
  }
  if (cert.ecPoint && key.ecPoint) {
    return bytesEqual(cert.ecPoint, key.ecPoint)
  }
  return true
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copy))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function pbkdf2HashName(
  prfOid: string | null,
): 'SHA-1' | 'SHA-256' | 'SHA-512' {
  switch (prfOid) {
    case null:
    case '1.2.840.113549.2.7':
      return 'SHA-1'
    case '1.2.840.113549.2.9':
      return 'SHA-256'
    case '1.2.840.113549.2.11':
      return 'SHA-512'
    default:
      throw new Error('Unsupported PBKDF2 PRF OID: ' + prfOid)
  }
}

async function derivePbkdf2Bits(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  hash: 'SHA-1' | 'SHA-256' | 'SHA-512',
  lengthBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations,
      hash,
    },
    baseKey,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}

function stripPkcs7Padding(
  padded: Uint8Array,
  blockSize: number,
): Uint8Array<ArrayBuffer> {
  if (padded.length === 0 || padded.length % blockSize !== 0) {
    throw new Error('Invalid padded ciphertext')
  }
  const pad = padded[padded.length - 1]!
  if (pad < 1 || pad > blockSize) throw new Error('Invalid PKCS#7 padding')
  for (let i = padded.length - pad; i < padded.length; i++) {
    if (padded[i] !== pad) throw new Error('Invalid PKCS#7 padding')
  }
  return padded.slice(0, padded.length - pad)
}

async function decryptPbes2(
  bytes: Uint8Array,
  pbes2Params: DerNode,
  ciphertext: Uint8Array,
  passphrase: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts = readDerChildren(bytes, pbes2Params)
  if (parts.length !== 2) throw new Error('Invalid PBES2 params')
  const kdfAlg = readDerChildren(bytes, parts[0]!)
  const encAlg = readDerChildren(bytes, parts[1]!)
  const kdfOid = decodeOid(bytes, kdfAlg[0]!)
  if (kdfOid !== '1.2.840.113549.1.5.12') {
    throw new Error('Unsupported PBES2 KDF: ' + kdfOid)
  }
  const pbkdf2Params = readDerChildren(bytes, kdfAlg[1]!)
  const saltNode = pbkdf2Params[0]!
  const iterNode = pbkdf2Params[1]!
  if (saltNode.tag !== 0x04)
    throw new Error('Expected PBKDF2 salt OCTET STRING')
  const salt = bytes.subarray(saltNode.valueStart, saltNode.end)
  const iterations = decodeSmallInt(bytes, iterNode)
  if (iterations < 1 || iterations > 5_000_000)
    throw new Error('Invalid PBKDF2 iteration count')
  let keyLength: number | null = null
  let prfOid: string | null = null
  for (let i = 2; i < pbkdf2Params.length; i++) {
    const p = pbkdf2Params[i]!
    if (p.tag === 0x02) keyLength = decodeSmallInt(bytes, p)
    else if (p.tag === 0x30) {
      prfOid = decodeOid(bytes, readDerChildren(bytes, p)[0]!)
    }
  }
  const encOid = decodeOid(bytes, encAlg[0]!)
  const ivNode = encAlg[1]
  if (!ivNode || ivNode.tag !== 0x04) throw new Error('Missing cipher IV')
  const iv = bytes.subarray(ivNode.valueStart, ivNode.end)
  if (encOid === '1.2.840.113549.3.7') {
    const keyBytes = await derivePbkdf2Bits(
      passphrase,
      salt,
      iterations,
      pbkdf2HashName(prfOid),
      keyLength ?? 24,
    )
    return decrypt3DesCbc(ciphertext, keyBytes.subarray(0, 24), iv)
  }
  let aesKeyLen: number
  if (encOid === '2.16.840.1.101.3.4.1.2') aesKeyLen = 16
  else if (encOid === '2.16.840.1.101.3.4.1.22') aesKeyLen = 24
  else if (encOid === '2.16.840.1.101.3.4.1.42') aesKeyLen = 32
  else throw new Error('Unsupported PBES2 cipher OID: ' + encOid)

  const keyBytes = await derivePbkdf2Bits(
    passphrase,
    salt,
    iterations,
    pbkdf2HashName(prfOid),
    keyLength ?? aesKeyLen,
  )
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes.subarray(0, aesKeyLen)),
    'AES-CBC',
    false,
    ['decrypt'],
  )
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: toArrayBuffer(iv) },
    cryptoKey,
    toArrayBuffer(ciphertext),
  )
  return new Uint8Array(plain)
}

// RFC 7292 Appendix B PKCS#12 KDF
function encodeBmpPassword(passphrase: string): Uint8Array {
  if (!passphrase) return new Uint8Array(0)
  const out = new Uint8Array((passphrase.length + 1) * 2)
  for (let i = 0; i < passphrase.length; i++) {
    const code = passphrase.charCodeAt(i)
    out[i * 2] = (code >> 8) & 0xff
    out[i * 2 + 1] = code & 0xff
  }
  return out
}

async function pkcs12Kdf(
  hash: 'SHA-1' | 'SHA-256' | 'SHA-512',
  idByte: number,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  neededBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const v = hash === 'SHA-512' ? 128 : 64
  const u = hash === 'SHA-1' ? 20 : hash === 'SHA-256' ? 32 : 64
  const D = new Uint8Array(v).fill(idByte)
  const pwd = encodeBmpPassword(passphrase)
  const slen = salt.length > 0 ? Math.ceil(salt.length / v) * v : 0
  const plen = pwd.length > 0 ? Math.ceil(pwd.length / v) * v : 0
  const I = new Uint8Array(slen + plen)
  for (let i = 0; i < slen; i++) I[i] = salt[i % salt.length]!
  for (let i = 0; i < plen; i++) I[slen + i] = pwd[i % pwd.length]!

  const c = Math.ceil(neededBytes / u)
  const A = new Uint8Array(c * u)
  for (let i = 0; i < c; i++) {
    const buf = new Uint8Array(D.length + I.length)
    buf.set(D)
    buf.set(I, D.length)
    let Ai = new Uint8Array(
      await crypto.subtle.digest(hash, toArrayBuffer(buf)),
    )
    for (let r = 1; r < iterations; r++) {
      Ai = new Uint8Array(await crypto.subtle.digest(hash, toArrayBuffer(Ai)))
    }
    A.set(Ai, i * u)
    if (i + 1 < c) {
      const B = new Uint8Array(v)
      for (let k = 0; k < v; k++) B[k] = Ai[k % u]!
      for (let off = 0; off < I.length; off += v) {
        let carry = 1
        for (let k = v - 1; k >= 0; k--) {
          const sum = I[off + k]! + B[k]! + carry
          I[off + k] = sum & 0xff
          carry = sum >> 8
        }
      }
    }
  }
  return A.slice(0, neededBytes)
}

// Compact clean-room 3DES-CBC for legacy PKCS#12 archives (pbeWithSHAAnd3-KeyTripleDES-CBC)
const DES_IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38,
  30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1,
  59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39,
  31, 23, 15, 7,
]
const DES_FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14,
  54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28,
  35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9,
  49, 17, 57, 25,
]
const DES_E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16,
  17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29,
  28, 29, 30, 31, 32, 1,
]
const DES_P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32,
  27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
]
const DES_PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
  27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38,
  30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
]
const DES_PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27,
  20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34,
  53, 46, 42, 50, 36, 29, 32,
]
const DES_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
const DES_S = [
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2,
    13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7,
    3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8,
    14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9,
    3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6,
    10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5,
    10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15,
    0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14,
    5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7,
    13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6,
    3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12,
    9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1,
    13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1,
    10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0,
    5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3,
    7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13,
    15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
]

function desPermute(bits: number[], table: number[]): number[] {
  return table.map((idx) => bits[idx - 1]!)
}
function bytesToBits(b: Uint8Array): number[] {
  const bits: number[] = []
  for (let i = 0; i < b.length; i++) {
    for (let j = 7; j >= 0; j--) bits.push((b[i]! >> j) & 1)
  }
  return bits
}
function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(bits.length / 8)
  for (let i = 0; i < out.length; i++) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]!
    out[i] = v
  }
  return out
}
function desSubkeys(key8: Uint8Array): number[][] {
  const permuted = desPermute(bytesToBits(key8), DES_PC1)
  let C = permuted.slice(0, 28)
  let D = permuted.slice(28)
  const keys: number[][] = []
  for (const s of DES_SHIFTS) {
    C = C.slice(s).concat(C.slice(0, s))
    D = D.slice(s).concat(D.slice(0, s))
    keys.push(desPermute(C.concat(D), DES_PC2))
  }
  return keys
}
function desBlock(
  bits64: number[],
  subkeys: number[][],
  decrypt: boolean,
): number[] {
  const ip = desPermute(bits64, DES_IP)
  let L = ip.slice(0, 32)
  let R = ip.slice(32)
  for (let round = 0; round < 16; round++) {
    const k = subkeys[decrypt ? 15 - round : round]!
    const expanded = desPermute(R, DES_E)
    const xored = expanded.map((b, i) => b ^ k[i]!)
    const sOut: number[] = []
    for (let box = 0; box < 8; box++) {
      const off = box * 6
      const row = (xored[off]! << 1) | xored[off + 5]!
      const col =
        (xored[off + 1]! << 3) |
        (xored[off + 2]! << 2) |
        (xored[off + 3]! << 1) |
        xored[off + 4]!
      const val = DES_S[box]![row * 16 + col]!
      for (let bit = 3; bit >= 0; bit--) sOut.push((val >> bit) & 1)
    }
    const f = desPermute(sOut, DES_P)
    const nextR = L.map((b, i) => b ^ f[i]!)
    L = R
    R = nextR
  }
  return desPermute(R.concat(L), DES_FP)
}

function decrypt3DesCbc(
  ciphertext: Uint8Array,
  key24: Uint8Array,
  iv8: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (ciphertext.length === 0 || ciphertext.length % 8 !== 0) {
    throw new Error('Invalid 3DES ciphertext length')
  }
  const k1 = desSubkeys(key24.subarray(0, 8))
  const k2 = desSubkeys(key24.subarray(8, 16))
  const k3 = desSubkeys(key24.subarray(16, 24))
  const out = new Uint8Array(ciphertext.length)
  let prev = iv8
  for (let off = 0; off < ciphertext.length; off += 8) {
    const block = ciphertext.subarray(off, off + 8)
    let bits = desBlock(bytesToBits(block), k3, true)
    bits = desBlock(bits, k2, false)
    bits = desBlock(bits, k1, true)
    const plain = bitsToBytes(bits)
    for (let i = 0; i < 8; i++) out[off + i] = plain[i]! ^ prev[i]!
    prev = block
  }
  return stripPkcs7Padding(out, 8)
}

async function decryptPkcs12Algorithm(
  bytes: Uint8Array,
  algIdNode: DerNode,
  ciphertext: Uint8Array,
  passphrase: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const algChildren = readDerChildren(bytes, algIdNode)
  const oid = decodeOid(bytes, algChildren[0]!)
  if (oid === '1.2.840.113549.1.5.13') {
    return decryptPbes2(bytes, algChildren[1]!, ciphertext, passphrase)
  }
  if (oid === '1.2.840.113549.1.12.1.3') {
    // pbeWithSHAAnd3-KeyTripleDES-CBC
    const pbeParams = readDerChildren(bytes, algChildren[1]!)
    const salt = bytes.subarray(pbeParams[0]!.valueStart, pbeParams[0]!.end)
    const iterations = decodeSmallInt(bytes, pbeParams[1]!)
    const key = await pkcs12Kdf('SHA-1', 1, passphrase, salt, iterations, 24)
    const iv = await pkcs12Kdf('SHA-1', 2, passphrase, salt, iterations, 8)
    return decrypt3DesCbc(ciphertext, key, iv)
  }
  throw new Error('Unsupported PKCS#12 encryption algorithm OID: ' + oid)
}

async function decryptEncryptedPrivateKey(
  der: Uint8Array,
  passphrase: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const root = readDer(der, 0, der.length)
  const parts = readDerChildren(der, root)
  if (parts.length !== 2 || parts[0]!.tag !== 0x30 || parts[1]!.tag !== 0x04) {
    throw new Error('Malformed encrypted private key')
  }
  const ciphertext = der.subarray(parts[1]!.valueStart, parts[1]!.end)
  return decryptPkcs12Algorithm(der, parts[0]!, ciphertext, passphrase)
}

function macDigestName(oid: string): 'SHA-1' | 'SHA-256' | 'SHA-512' {
  switch (oid) {
    case '1.3.14.3.2.26':
      return 'SHA-1'
    case '2.16.840.1.101.3.4.2.1':
      return 'SHA-256'
    case '2.16.840.1.101.3.4.2.3':
      return 'SHA-512'
    default:
      throw new Error('Unsupported PKCS#12 MAC digest OID: ' + oid)
  }
}

async function verifyPkcs12Mac(
  bytes: Uint8Array,
  macNode: DerNode,
  authContent: Uint8Array,
  passphrase: string,
): Promise<boolean> {
  const macParts = readDerChildren(bytes, macNode)
  if (macParts.length < 2) throw new Error('Malformed PKCS#12 MacData')
  const digestInfoParts = readDerChildren(bytes, macParts[0]!)
  const digestAlgParts = readDerChildren(bytes, digestInfoParts[0]!)
  const hashName = macDigestName(decodeOid(bytes, digestAlgParts[0]!))
  const expectedMac = bytes.subarray(
    digestInfoParts[1]!.valueStart,
    digestInfoParts[1]!.end,
  )
  const macSalt = bytes.subarray(macParts[1]!.valueStart, macParts[1]!.end)
  const iterations = macParts[2] ? decodeSmallInt(bytes, macParts[2]) : 1
  const keyLen = hashName === 'SHA-1' ? 20 : hashName === 'SHA-256' ? 32 : 64
  const macKey = await pkcs12Kdf(
    hashName,
    3,
    passphrase,
    macSalt,
    iterations,
    keyLen,
  )
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(macKey),
    { name: 'HMAC', hash: hashName },
    false,
    ['sign'],
  )
  const actual = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, toArrayBuffer(authContent)),
  )
  return bytesEqual(actual, expectedMac)
}

async function parsePkcs12Archive(
  bytes: Uint8Array,
  passphrase: string | undefined,
): Promise<{ certs: Uint8Array[]; keys: Uint8Array[] }> {
  const pfx = readDer(bytes, 0, bytes.length)
  if (pfx.tag !== 0x30 || pfx.end !== bytes.length) {
    throw new Error('Not a PKCS#12 archive')
  }
  const pfxParts = readDerChildren(bytes, pfx)
  if (pfxParts.length < 2 || decodeSmallInt(bytes, pfxParts[0]!) !== 3) {
    throw new Error('Unsupported PKCS#12 version')
  }
  const authSafe = readDerChildren(bytes, pfxParts[1]!)
  const authOid = decodeOid(bytes, authSafe[0]!)
  if (authOid !== '1.2.840.113549.1.7.1' || authSafe[1]?.tag !== 0xa0) {
    throw new Error('Unsupported PKCS#12 AuthSafe')
  }
  const authOctet = readDerChildren(bytes, authSafe[1]!)[0]!
  const authContent = bytes.subarray(authOctet.valueStart, authOctet.end)

  const pwd = passphrase ?? ''
  if (pfxParts[2]) {
    const macOk = await verifyPkcs12Mac(bytes, pfxParts[2], authContent, pwd)
    if (!macOk)
      throw new Error(
        'PKCS#12 MAC check failed (wrong passphrase or corrupt file)',
      )
  }

  const safesNode = readDer(authContent, 0, authContent.length)
  const safeContentInfos = readDerChildren(authContent, safesNode)
  const certs: Uint8Array[] = []
  const keys: Uint8Array[] = []

  const extractSafeBags = async (safeBytes: Uint8Array) => {
    const seq = readDer(safeBytes, 0, safeBytes.length)
    for (const bagNode of readDerChildren(safeBytes, seq)) {
      const bagParts = readDerChildren(safeBytes, bagNode)
      const bagId = decodeOid(safeBytes, bagParts[0]!)
      if (bagParts[1]?.tag !== 0xa0) continue
      const bagVal = readDerChildren(safeBytes, bagParts[1]!)[0]!
      if (bagId === '1.2.840.113549.1.12.10.1.3') {
        // CertBag ::= SEQUENCE { certId OID, certValue [0] EXPLICIT ANY }
        const cb = readDerChildren(safeBytes, bagVal)
        const certId = decodeOid(safeBytes, cb[0]!)
        if (certId === '1.2.840.113549.1.9.22.1' && cb[1]?.tag === 0xa0) {
          const certOctet = readDerChildren(safeBytes, cb[1]!)[0]!
          certs.push(safeBytes.slice(certOctet.valueStart, certOctet.end))
        }
      } else if (bagId === '1.2.840.113549.1.12.10.1.2') {
        // PKCS8ShroudedKeyBag ::= EncryptedPrivateKeyInfo
        const der = safeBytes.subarray(bagVal.rawStart, bagVal.end)
        keys.push(await decryptEncryptedPrivateKey(der, pwd))
      } else if (bagId === '1.2.840.113549.1.12.10.1.1') {
        // KeyBag ::= PrivateKeyInfo
        keys.push(safeBytes.slice(bagVal.rawStart, bagVal.end))
      }
    }
  }

  for (const ci of safeContentInfos) {
    const ciParts = readDerChildren(authContent, ci)
    const ciOid = decodeOid(authContent, ciParts[0]!)
    if (ciOid === '1.2.840.113549.1.7.1' && ciParts[1]?.tag === 0xa0) {
      const oct = readDerChildren(authContent, ciParts[1]!)[0]!
      await extractSafeBags(authContent.subarray(oct.valueStart, oct.end))
    } else if (ciOid === '1.2.840.113549.1.7.6' && ciParts[1]?.tag === 0xa0) {
      const encData = readDerChildren(
        authContent,
        readDerChildren(authContent, ciParts[1]!)[0]!,
      )
      const eci = readDerChildren(authContent, encData[1]!)
      // EncryptedContentInfo ::= SEQUENCE { contentType, contentEncryptionAlgorithm, encryptedContent [0] IMPLICIT OCTET STRING }
      const encNode = eci[2]!
      const ciphertext = authContent.subarray(encNode.valueStart, encNode.end)
      const plain = await decryptPkcs12Algorithm(
        authContent,
        eci[1]!,
        ciphertext,
        pwd,
      )
      await extractSafeBags(plain)
    }
  }
  return { certs, keys }
}

type PemBlock = { label: string; der: Uint8Array }

function extractPemBlocks(text: string): PemBlock[] {
  const re = new RegExp(
    PEM_DASHES +
      PEM_WORD_BEGIN +
      '([A-Z0-9 ]+)' +
      PEM_DASHES +
      '([\\s\\S]*?)' +
      PEM_DASHES +
      PEM_WORD_END +
      '\\1' +
      PEM_DASHES,
    'g',
  )
  const blocks: PemBlock[] = []
  for (const match of text.matchAll(re)) {
    const label = match[1]!
    const der = base64ToBytes(match[2]!)
    blocks.push({ label, der })
  }
  return blocks
}

async function finalizeCertAndKey(input: {
  format: 'pem' | 'pkcs12'
  certDer: Uint8Array
  parsedCert: ParsedX509
  parsedKey: ParsedPrivateKey
  now: number
}): Promise<KobraClientCertValidated> {
  const fingerprintSha256 = await sha256Hex(input.certDer)
  const metadata: KobraClientCertMetadata = {
    subject: input.parsedCert.subject || '(vazio)',
    commonName: input.parsedCert.commonName,
    notBefore: input.parsedCert.notBefore,
    notAfter: input.parsedCert.notAfter,
    notBeforeIso: new Date(input.parsedCert.notBefore).toISOString(),
    notAfterIso: new Date(input.parsedCert.notAfter).toISOString(),
    fingerprintSha256,
  }
  if (!keysMatch(input.parsedCert, input.parsedKey)) {
    return {
      ok: false,
      reason: 'unreadable',
      message:
        'A chave privada não corresponde ao certificado informado (unreadable key pair mismatch).',
      metadata,
    }
  }
  if (
    (input.parsedCert.commonName ?? '').trim() !== KOBRA_CLIENT_CERT_COMMON_NAME
  ) {
    return {
      ok: false,
      reason: 'wrong-subject',
      message: `Subject inválido (${metadata.subject}): esperado CN=${KOBRA_CLIENT_CERT_COMMON_NAME} (wrong subject).`,
      metadata,
    }
  }
  if (
    input.now < input.parsedCert.notBefore ||
    input.now >= input.parsedCert.notAfter
  ) {
    return {
      ok: false,
      reason: 'expired',
      message: `Certificado expirado ou fora da janela de validade (expira em ${metadata.notAfterIso}; expired).`,
      metadata,
    }
  }
  return {
    ok: true,
    format: input.format,
    metadata,
    certificatePem: wrapPem(LABEL_CERT, input.certDer),
    keyPem: wrapPem(
      input.parsedKey.canonicalLabel,
      input.parsedKey.canonicalDer,
    ),
  }
}

export async function validateKobraClientCertificate(input: {
  text?: string | undefined
  bytes?: Uint8Array | undefined
  passphrase?: string | undefined
  now?: number | undefined
}): Promise<KobraClientCertValidated> {
  const now = input.now ?? Date.now()
  const rawBytes = input.bytes
  const rawText = input.text?.trim() ?? ''

  if ((!rawBytes || rawBytes.byteLength === 0) && !rawText) {
    return {
      ok: false,
      reason: 'missing',
      message:
        'Certificado do cliente ausente (client certificate missing): selecione um arquivo PEM ou PKCS#12.',
    }
  }

  let decodedText = rawText
  if (!decodedText && rawBytes) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(
      rawBytes.subarray(0, Math.min(rawBytes.length, 64)),
    )
    if (head.includes(PEM_DASHES + PEM_WORD_BEGIN)) {
      decodedText = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes)
    }
  }

  if (decodedText.includes(PEM_DASHES + PEM_WORD_BEGIN)) {
    let blocks: PemBlock[]
    try {
      blocks = extractPemBlocks(decodedText)
    } catch {
      return {
        ok: false,
        reason: 'unreadable',
        message: 'Arquivo PEM ilegível ou base64 corrompido (unreadable PEM).',
      }
    }
    const certBlocks = blocks.filter((b) => b.label === LABEL_CERT)
    const keyBlocks = blocks.filter(
      (b) =>
        b.label === LABEL_PKCS8 ||
        b.label === LABEL_RSA ||
        b.label === LABEL_EC ||
        b.label === LABEL_PKCS8_ENC,
    )
    if (certBlocks.length === 0 || keyBlocks.length === 0) {
      return {
        ok: false,
        reason: 'unreadable',
        message:
          'O PEM precisa conter o certificado e a chave privada correspondentes (unreadable: missing certificate or private key).',
      }
    }
    try {
      const certs = certBlocks.map((b) => ({
        der: b.der,
        parsed: parseX509Der(b.der),
      }))
      const keys: ParsedPrivateKey[] = []
      for (const kb of keyBlocks) {
        if (kb.label === LABEL_PKCS8_ENC) {
          const plain = await decryptEncryptedPrivateKey(
            kb.der,
            input.passphrase ?? '',
          )
          keys.push(parseUnencryptedPrivateKeyDer(plain, LABEL_PKCS8))
        } else {
          keys.push(parseUnencryptedPrivateKeyDer(kb.der, kb.label))
        }
      }
      for (const c of certs) {
        for (const k of keys) {
          if (keysMatch(c.parsed, k)) {
            return await finalizeCertAndKey({
              format: 'pem',
              certDer: c.der,
              parsedCert: c.parsed,
              parsedKey: k,
              now,
            })
          }
        }
      }
      return await finalizeCertAndKey({
        format: 'pem',
        certDer: certs[0]!.der,
        parsedCert: certs[0]!.parsed,
        parsedKey: keys[0]!,
        now,
      })
    } catch {
      return {
        ok: false,
        reason: 'unreadable',
        message:
          'Não foi possível ler o certificado ou descriptografar a chave privada PEM (unreadable).',
      }
    }
  }

  if (!rawBytes || rawBytes.byteLength === 0) {
    return {
      ok: false,
      reason: 'unreadable',
      message: 'Formato de certificado ilegível ou não suportado (unreadable).',
    }
  }

  try {
    const archive = await parsePkcs12Archive(rawBytes, input.passphrase)
    if (archive.certs.length === 0 || archive.keys.length === 0) {
      return {
        ok: false,
        reason: 'unreadable',
        message:
          'Arquivo PKCS#12 sem certificado e chave privada válidos (unreadable PKCS#12).',
      }
    }
    const parsedCerts = archive.certs.map((der) => ({
      der,
      parsed: parseX509Der(der),
    }))
    const parsedKeys = archive.keys.map((der) =>
      parseUnencryptedPrivateKeyDer(der, LABEL_PKCS8),
    )
    for (const c of parsedCerts) {
      for (const k of parsedKeys) {
        if (keysMatch(c.parsed, k)) {
          return await finalizeCertAndKey({
            format: 'pkcs12',
            certDer: c.der,
            parsedCert: c.parsed,
            parsedKey: k,
            now,
          })
        }
      }
    }
    return await finalizeCertAndKey({
      format: 'pkcs12',
      certDer: parsedCerts[0]!.der,
      parsedCert: parsedCerts[0]!.parsed,
      parsedKey: parsedKeys[0]!,
      now,
    })
  } catch {
    return {
      ok: false,
      reason: 'unreadable',
      message:
        'Não foi possível abrir o arquivo PKCS#12 (senha incorreta ou arquivo corrompido; unreadable).',
    }
  }
}
