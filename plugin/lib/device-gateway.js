/**
 * v4: the entrance the owner's devices (the Mac first) use to hand Mira their observations — Feishu, mail, screen.
 * DSH's own routes admit only the owner's browser, so this listens separately, on loopback only (a device reaches
 * it through an SSH tunnel), and admits a request only with a known device token; the token decides which device
 * is speaking. Everything past the door is the existing Observations intake: policy (off until the owner enables
 * it), receipts, duplicates and quotas.
 * The same door has a second set of routes, /files: the read-only file reader on the owner's computer waits there
 * for a read request from the personal assistant and hands back its answer (mac-files.js).
 * A third, /shot: the owner's screenshot shortcut hands in a picture to ask about (shots.js).
 */
import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const MAX_BODY = 4 * 1024 * 1024
const OPERATIONS = { observation: new Set(['hello', 'chunk', 'ingest']), files: new Set(['poll', 'result']), shot: new Set(['ask', 'say', 'reply']) }
const digest = value => createHash('sha256').update(value).digest()

function validDevice(raw) {
  if (!raw || typeof raw !== 'object' || Object.keys(raw).some(k => !['deviceId', 'name', 'tokenSha256'].includes(k))) throw Error('设备设置字段无效')
  if (!/^[\w:.-]{1,128}$/.test(raw.deviceId ?? '')) throw Error('设备标识无效')
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80) throw Error('设备名称无效')
  if (!/^[0-9a-f]{64}$/.test(raw.tokenSha256 ?? '')) throw Error('设备凭据摘要无效')
  return { deviceId: raw.deviceId, name: raw.name.trim(), hash: Buffer.from(raw.tokenSha256, 'hex') }
}

/** Devices from a file only the current user can read: {"devices":[{deviceId,name,tokenSha256}]}. Only token digests are kept. */
export function loadDeviceTokens(file) {
  if (!isAbsolute(file)) throw Error('设备凭据文件需要绝对路径')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 65536) throw Error('设备凭据文件须为当前用户私有文件')
    const input = JSON.parse(readFileSync(fd, 'utf8'))
    if (!Array.isArray(input?.devices) || input.devices.length > 20) throw Error('设备凭据文件需要最多 20 个 devices')
    return input.devices
  } finally { closeSync(fd) }
}

export class DeviceGateway {
  constructor({ observations, files, shots, devices, logger }) {
    this.observations = observations;this.files = files;this.shots = shots;this.logger = logger
    this.devices = devices.map(validDevice)
    if (new Set(this.devices.map(d => d.deviceId)).size !== this.devices.length) throw Error('设备标识重复')
  }

  device(header) {
    const match = /^Bearer ([\x21-\x7e]{16,512})$/.exec(header || '')
    if (!match) return null
    const hash = digest(match[1])
    return this.devices.find(d => timingSafeEqual(d.hash, hash)) ?? null
  }

  async handle(request, response) {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });response.end(JSON.stringify(body)) }
    const match = /^\/api\/desktop\/(observation|files|shot)\/([a-z]+)$/.exec(new URL(request.url, 'http://device').pathname)
    if (request.method !== 'POST' || !match || !OPERATIONS[match[1]].has(match[2]) || (match[1] === 'files' && !this.files) || (match[1] === 'shot' && !this.shots)) { request.resume();return send(404, { error: '没有这个设备接口', code: 'NOT_FOUND' }) }
    const device = this.device(request.headers.authorization)
    if (!device) { request.resume();return send(401, { error: '设备凭据无效', code: 'UNAUTHORIZED' }) }
    // Only a known device gets this far; an oversized body is drained, never kept or parsed.
    const pieces = [];let size = 0
    for await (const piece of request) { size += piece.length;if (size <= MAX_BODY) pieces.push(piece) }
    if (size > MAX_BODY) return send(413, { error: '请求过大', code: 'TOO_LARGE' })
    let body
    try { body = JSON.parse(Buffer.concat(pieces).toString('utf8')) } catch { return send(400, { error: '请求不是有效 JSON', code: 'BAD_JSON' }) }
    if (match[1] === 'shot') {
      const gone = new AbortController()
      response.once('close', () => gone.abort())
      try {
        const out = match[2] === 'ask' ? await this.shots.ask(device, body) : match[2] === 'say' ? this.shots.say(device, body) : await this.shots.reply(device, body, gone.signal)
        return send(200, out)
      } catch (error) { return send(400, { error: String(error?.message ?? error).slice(0, 300), code: 'BAD_REQUEST' }) }
    }
    if (match[1] === 'files') {
      try {
        if (match[2] === 'result') return send(200, this.files.result(device, body))
        // The reader's wait for work is held open; if its connection drops, the wait is let go.
        const gone = new AbortController()
        response.once('close', () => gone.abort())
        return send(200, await this.files.poll(device, body, gone.signal))
      } catch (error) { return send(400, { error: String(error?.message ?? error).slice(0, 300), code: 'BAD_REQUEST' }) }
    }
    try {
      const operation = match[2], intake = this.observations
      const result = operation === 'hello' ? intake.hello(device.deviceId, device.name, body?.report ?? {})
        : operation === 'chunk' ? await intake.chunk(device.deviceId, body ?? {})
        : await intake.ingest(device.deviceId, body ?? {})
      send(200, result)
    } catch (error) {
      send(error.code === 'FILE_QUOTA_EXCEEDED' ? 507 : 409, { error: String(error?.message ?? error).slice(0, 300), code: error.code ?? 'OBSERVATION_UNAVAILABLE' })
    }
  }

  /** Listen on loopback; resolves to the bound port. */
  listen(port, host = '127.0.0.1') {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(error => {
        this.logger?.warn('mira-projects: device request failed', error)
        if (!response.headersSent) { response.writeHead(500);response.end() }
      })
    })
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => resolve(this.server.address().port))
    })
  }

  close() {
    this.files?.stop()
    return new Promise(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }
}
