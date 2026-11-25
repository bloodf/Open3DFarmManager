# Kobra X native detail capabilities

The [clean-room LAN specification](../compatibility/kobra-x-lan.md) records
the vendor protocol observations and sources. The detail view uses print,
temperature and multiColorBox reports. ACE slots are observations.
The native assignment collects status and can opt in to the Connector's
existing signed command path through `pause.control.assignmentIds`. The
Connector uses the assignment's private onboarding binding and pinned direct
LAN MQTT connection for pause, resume, cancel, idle nozzle and bed
temperature, part fan, light, load, unload and starting an uploaded file.
These controls have simulator evidence. Hardware control qualification is
pending. Native camera media remains unavailable.

For a Kobra X with one ACE Pro, signed `start_print.ams_mapping` identifies
the source for each slicer filament in order. Holder positions use 0–2. ACE
positions use 4–7. The Connector checks the reported box and slot and refuses
a slot reported empty. Signed `load_filament.tray` uses those same indices.
Standalone unload requires exactly one feeder reporting a loaded slot.
Upload the file through the printer's native slicer path before starting it.

The detail page leaves movement, extrusion, macros, console, object
exclusion, queues, bed mesh, configuration, services, history, timelapse,
power and updates unavailable. The Kobra X LAN protocol has no raw G-code
console channel.
