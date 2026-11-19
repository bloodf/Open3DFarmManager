# Kobra X native detail capabilities

The [clean-room LAN specification](../compatibility/kobra-x-lan.md) records
the vendor protocol observations and sources. The detail view uses print,
temperature and multiColorBox reports. ACE slots are observations.
The native adapter implements the temperature, part fan, light, print
lifecycle and file operations described in the specification. The agent's
native assignment currently collects status. It has no signed command or
camera media route for that assignment.

The detail page leaves movement, extrusion, macros, console, object
exclusion, queues, bed mesh, configuration, services, history, timelapse,
power and updates unavailable. The LAN specification does not establish
support for those panels as a whole.
