// spec-derived, not captured: SDCP V3.0.0 https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/main/SDCP%28Smart%20Device%20Control%20Protocol%29_V3.0.0_EN.md
export const status = {
  MainboardID: 'fixture01',
  Topic: 'sdcp/status/fixture01',
  Status: {
    CurrentStatus: [1],
    PrintInfo: { Status: 3, CurrentLayer: 25, TotalLayer: 100, ErrorNumber: 0 },
  },
}

export const discovery = {
  Id: 'fixture',
  Data: {
    Name: 'Test',
    MachineName: 'Saturn 4 Ultra',
    MainboardIP: '127.0.0.1',
    MainboardID: 'fixture01',
    ProtocolVersion: 'V3.0.0',
    FirmwareVersion: 'V1.0.0',
  },
}
export const incompatibleDiscovery = {
  ...discovery,
  Data: { ...discovery.Data, ProtocolVersion: 'V2.0.0' },
}
