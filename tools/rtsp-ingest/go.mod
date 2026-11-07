module open3dfarm.local/rtsp-ingest

go 1.27.1

require (
	github.com/bluenviron/gortsplib/v5 v5.6.7
	github.com/bluenviron/mediacommon/v2 v2.9.7
	github.com/google/uuid v1.6.0
	github.com/gorilla/websocket v1.5.3
	github.com/pion/rtcp v1.2.20
	github.com/pion/rtp v1.10.6
	github.com/pion/sdp/v3 v3.0.20
	github.com/pion/srtp/v3 v3.1.3
	github.com/stretchr/testify v1.12.1
	golang.org/x/net v0.59.0
)

require (
	github.com/asticode/go-astikit v0.30.0 // indirect
	github.com/asticode/go-astits v1.16.0 // indirect
	github.com/pion/logging v0.2.4 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/transport/v5 v5.1.1 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	golang.org/x/sys v0.48.0 // indirect
)

replace (
	github.com/abema/go-mp4 v1.7.3 => ../../third_party/rtsp-ingest/sources/github.com--abema--go-mp4
	github.com/asticode/go-astikit v0.30.0 => ../../third_party/rtsp-ingest/sources/github.com--asticode--go-astikit
	github.com/asticode/go-astits v1.16.0 => ../../third_party/rtsp-ingest/sources/github.com--asticode--go-astits
	github.com/bluenviron/gortsplib/v5 v5.6.7 => ../../third_party/rtsp-ingest/sources/github.com--bluenviron--gortsplib--v5
	github.com/bluenviron/mediacommon/v2 v2.9.7 => ../../third_party/rtsp-ingest/sources/github.com--bluenviron--mediacommon--v2
	github.com/davecgh/go-spew v1.1.1 => ../../third_party/rtsp-ingest/sources/github.com--davecgh--go-spew
	github.com/google/uuid v1.6.0 => ../../third_party/rtsp-ingest/sources/github.com--google--uuid
	github.com/gorilla/websocket v1.5.3 => ../../third_party/rtsp-ingest/sources/github.com--gorilla--websocket
	github.com/pion/logging v0.2.4 => ../../third_party/rtsp-ingest/sources/github.com--pion--logging
	github.com/pion/randutil v0.1.0 => ../../third_party/rtsp-ingest/sources/github.com--pion--randutil
	github.com/pion/rtcp v1.2.20 => ../../third_party/rtsp-ingest/sources/github.com--pion--rtcp
	github.com/pion/rtp v1.10.6 => ../../third_party/rtsp-ingest/sources/github.com--pion--rtp
	github.com/pion/sdp/v3 v3.0.20 => ../../third_party/rtsp-ingest/sources/github.com--pion--sdp--v3
	github.com/pion/srtp/v3 v3.1.3 => ../../third_party/rtsp-ingest/sources/github.com--pion--srtp--v3
	github.com/pion/transport/v5 v5.1.1 => ../../third_party/rtsp-ingest/sources/github.com--pion--transport--v5
	github.com/pkg/profile v1.4.0 => ../../third_party/rtsp-ingest/sources/github.com--pkg--profile
	github.com/pmezard/go-difflib v1.0.0 => ../../third_party/rtsp-ingest/sources/github.com--pmezard--go-difflib
	github.com/stretchr/objx v0.5.3 => ../../third_party/rtsp-ingest/sources/github.com--stretchr--objx
	github.com/stretchr/testify v1.12.1 => ../../third_party/rtsp-ingest/sources/github.com--stretchr--testify
	github.com/wlynxg/anet v0.0.5 => ../../third_party/rtsp-ingest/sources/github.com--wlynxg--anet
	go.yaml.in/yaml/v3 v3.0.5 => ../../third_party/rtsp-ingest/sources/go.yaml.in--yaml--v3
	golang.org/x/crypto v0.57.0 => ../../third_party/rtsp-ingest/sources/golang.org--x--crypto
	golang.org/x/net v0.59.0 => ../../third_party/rtsp-ingest/sources/golang.org--x--net
	golang.org/x/sys v0.48.0 => ../../third_party/rtsp-ingest/sources/golang.org--x--sys
	golang.org/x/term v0.46.0 => ../../third_party/rtsp-ingest/sources/golang.org--x--term
	golang.org/x/text v0.42.0 => ../../third_party/rtsp-ingest/sources/golang.org--x--text
	golang.org/x/time v0.14.0 => ../../third_party/rtsp-ingest/sources/golang.org--x--time
	gopkg.in/yaml.v2 v2.2.2 => ../../third_party/rtsp-ingest/sources/gopkg.in--yaml.v2
	gopkg.in/yaml.v3 v3.0.1 => ../../third_party/rtsp-ingest/sources/gopkg.in--yaml.v3
)
