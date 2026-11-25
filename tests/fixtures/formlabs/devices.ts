// spec-derived, not captured: https://formlabs-dashboard-api-resources.s3.us-east-1.amazonaws.com/formlabs-local-api-v0.9.11.html
// The Form 4 entry carries the required fields of the "Form 4 or Form 4L
// Printer" shape (Form4FamilyDeviceStatusModel). Values are synthetic.
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
      is_remote_print_enabled: false,
      estimated_print_time_remaining_ms: 5_400_000,
      tank_id: 'synthetic-tank',
      tank_material_code: 'FLGPBK05',
      cartridge_data: {},
      ready_to_print_now: false,
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
