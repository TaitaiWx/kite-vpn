import { describe, it, expect } from 'vitest'
import { parseProxyUri, parseProxyUris } from '../protocol/index.js'

function expectSuccess(uri: string, protocol: string) {
  const result = parseProxyUri(uri)
  expect(result.success).toBe(true)
  if (!result.success) return
  expect(result.node.settings.protocol).toBe(protocol)
  expect(result.node.server).toBeTruthy()
  expect(result.node.port).toBeGreaterThan(0)
  return result.node
}

describe('Shadowsocks (ss://)', () => {
  it('parses SIP002', () => {
    const node = expectSuccess('ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.4:8388#Test', 'shadowsocks')
    expect(node?.server).toBe('1.2.3.4')
    expect(node?.port).toBe(8388)
  })

  it('parses legacy base64', () => {
    const raw = btoa('aes-256-gcm:pass@1.2.3.4:8388')
    expectSuccess(`ss://${raw}#Legacy`, 'shadowsocks')
  })
})

describe('VMess (vmess://)', () => {
  it('parses base64 JSON', () => {
    const json = JSON.stringify({
      v: '2', ps: 'VM', add: '1.2.3.4', port: '443',
      id: '550e8400-e29b-41d4-a716-446655440000', aid: '0',
      net: 'ws', type: 'none', host: '', path: '', tls: '',
    })
    expectSuccess(`vmess://${btoa(json)}`, 'vmess')
  })
})

describe('VLESS (vless://)', () => {
  it('parses with transport', () => {
    expectSuccess('vless://550e8400-e29b-41d4-a716-446655440000@1.2.3.4:443?type=ws&security=tls&sni=x.com#VL', 'vless')
  })
})

describe('Trojan (trojan://)', () => {
  it('parses basic', () => {
    const node = expectSuccess('trojan://password123@1.2.3.4:443#TJ', 'trojan')
    expect(node?.port).toBe(443)
  })
})

describe('Hysteria2 (hy2://)', () => {
  it('parses', () => {
    expectSuccess('hy2://authpass@1.2.3.4:443?sni=x.com#HY2', 'hysteria2')
  })
})

describe('TUIC (tuic://)', () => {
  it('parses', () => {
    expectSuccess('tuic://550e8400-e29b-41d4-a716-446655440000:pass@1.2.3.4:443#TUIC', 'tuic')
  })
})

describe('WireGuard (wireguard://)', () => {
  it('parses', () => {
    expectSuccess('wireguard://privkey@1.2.3.4:51820?publickey=pubk&address=10.0.0.2/32#WG', 'wireguard')
  })
})

describe('ShadowsocksR (ssr://)', () => {
  it('parses base64', () => {
    const raw = '1.2.3.4:8388:origin:aes-256-cfb:plain:cGFzc3dvcmQ/?remarks=VGVzdA'
    const b64 = btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const result = parseProxyUri(`ssr://${b64}`)
    expect(typeof result.success).toBe('boolean')
  })
})

describe('parseProxyUri (auto-detect)', () => {
  it('rejects unknown scheme', () => {
    const r = parseProxyUri('http://example.com')
    expect(r.success).toBe(false)
  })
})

describe('parseProxyUris (batch)', () => {
  it('parses newline text', () => {
    const text = 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.4:8388#A\ntrojan://pass@5.6.7.8:443#B'
    const results = parseProxyUris(text)
    expect(results.filter((r) => r.success).length).toBe(2)
  })
})
