// spec-derived, not captured: https://formlabs-dashboard-api-resources.s3.us-east-1.amazonaws.com/formlabs-local-api-v0.9.11.html
export const devices = {
  count: 2,
  devices: [
    {
      id: 'Form4-Example',
      product_name: 'Form 4',
      status: 'Printing',
      is_connected: true,
      connection_type: 'LOCAL',
      ip_address: '127.0.0.1',
      firmware_version: '1.0',
    },
    {
      id: 'Studio-Example',
      product_name: 'Form Studio 1',
      status: 'Idle',
      is_connected: true,
      connection_type: 'LOCAL',
      ip_address: '127.0.0.1',
      firmware_version: '1.0',
    },
  ],
}
