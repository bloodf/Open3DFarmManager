// SPDX-License-Identifier: MIT

package ingest

import (
	"bufio"
	"bytes"
	"strings"
	"testing"

	"github.com/bluenviron/gortsplib/v5/pkg/base"
	"github.com/bluenviron/gortsplib/v5/pkg/sdpunmarshaler"
)

// Original synthetic fixture. Parameter sets are deliberately in-band only.
const fixtureSDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=fixture\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=42e01f\r\na=control:trackID=0\r\n"

func TestSDPFixtureProfile(t *testing.T) {
	desc, err := sdpunmarshaler.UnmarshalWithLimits([]byte(fixtureSDP), *sdpLimits())
	if err != nil || ValidateSDP(desc, fixtureDestination()) != nil { t.Fatalf("valid fixture: %v", err) }
	for _, body := range []string{
		strings.Replace(fixtureSDP, "RTP/AVP", "RTP/SAVP", 1),
		strings.Replace(fixtureSDP, "video", "audio", 1),
		strings.Replace(fixtureSDP, "H264/90000", "H265/90000", 1),
		strings.Replace(fixtureSDP, "packetization-mode=1", "packetization-mode=0", 1),
		strings.Replace(fixtureSDP, "packetization-mode=1", "packetization-mode=1;sprop-parameter-sets=Zw==,aA==", 1),
		strings.Replace(fixtureSDP, "profile-level-id=42e01f", "profile-level-id=zzzzzz", 1),
		strings.Replace(fixtureSDP, "packetization-mode=1", "packetization-mode=1;packetization-mode=1", 1),
		strings.Replace(fixtureSDP, "trackID=0", "rtsp://192.0.2.2:8554/track", 1),
		strings.Replace(fixtureSDP, "trackID=0", "trackID=0?secret=x", 1),
		strings.Replace(fixtureSDP, "control:*", "control:rtsp://192.0.2.2:8554/fixture", 1),
		strings.Replace(fixtureSDP, "c=IN IP4 0.0.0.0", "c=IN IP4 224.0.0.1", 1),
		strings.Replace(fixtureSDP, "s=fixture", "s=fixture\r\ni=unsupported", 1),
		fixtureSDP+"a=sendonly\r\n", fixtureSDP+"a=crypto:1 x\r\n", fixtureSDP+"a=key-mgmt:x\r\n", fixtureSDP+"a=unknown:x\r\n",
		fixtureSDP+"a=control:duplicate\r\n", fixtureSDP+"m=audio 0 RTP/AVP 0\r\n",
		strings.Replace(fixtureSDP, "RTP/AVP 96", "RTP/AVP 96 97", 1),
	} {
		desc, err := sdpunmarshaler.UnmarshalWithLimits([]byte(body), *sdpLimits())
		if err == nil && ValidateSDP(desc, fixtureDestination()) == nil { t.Fatal("accepted unsupported SDP") }
	}
}

func TestUpstreamBodyAndSDPBounds(t *testing.T) {
	for _, body := range []string{
		strings.Repeat("x", 16385), fixtureSDP+"a=x:"+strings.Repeat("x", 2049)+"\r\n",
		fixtureSDP+strings.Repeat("a=x:y\r\n", 33), fixtureSDP+strings.Repeat("\r\n", 65),
	} {
		if _, err := sdpunmarshaler.UnmarshalWithLimits([]byte(body), *sdpLimits()); err == nil { t.Fatal("accepted over-limit SDP") }
	}
	// The existing RTSP reader rejects the declared body before body read.
	wire := []byte("RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 16385\r\n\r\n")
	var res base.Response
	if res.UnmarshalWithLimits(bufio.NewReader(bytes.NewReader(wire)), base.ReadLimits{MaxBodyBytes: 16384}) == nil { t.Fatal("accepted over-limit body") }
	exact := base.Response{StatusCode: 200, Body: bytes.Repeat([]byte{1}, 16384)}
	wire, err := exact.Marshal()
	if err != nil { t.Fatal(err) }
	if res.UnmarshalWithLimits(bufio.NewReader(bytes.NewReader(wire)), base.ReadLimits{MaxBodyBytes: 16384}) != nil || len(res.Body) != 16384 { t.Fatal("rejected exact RTSP body cap") }
}

func TestRequestMethodBodyAndCredentialPolicy(t *testing.T) {
	u, _ := base.ParseURL("rtsp://127.0.0.1:8554/fixture")
	for _, req := range []*base.Request{
		{Method: base.Announce, URL: u}, {Method: base.Record, URL: u},
		{Method: base.Play, URL: u, Body: []byte{1}},
		{Method: base.Play, URL: u, Header: base.Header{"authorization": {"Basic invalid"}}},
		{Method: base.Play, URL: u, Header: base.Header{"Proxy-Authorization": {"Basic invalid"}}},
	} {
		if validateRequest(req, fixtureDestination()) != ErrPolicy { t.Fatal("accepted forbidden outgoing request") }
	}
	for _, method := range []base.Method{base.Options, base.Describe, base.Setup, base.Play, base.GetParameter, base.Teardown} {
		if validateRequest(&base.Request{Method: method, URL: u}, fixtureDestination()) != nil { t.Fatal("rejected supported request method") }
	}
}

func TestURIAndResponsePolicy(t *testing.T) {
	for _, value := range []string{
		"rtsp://127.0.0.1:8554/fixture", "rtsp://127.0.0.1:8554/fixture/trackID=0",
	} {
		u, err := base.ParseURL(value)
		if err != nil || validateURL(u, fixtureDestination()) != nil { t.Fatal("rejected same-origin URI") }
	}
	for _, value := range []string{
		"rtsp://192.0.2.1:8554/fixture", "rtsp://127.0.0.1:8555/fixture", "rtsp://fixture.invalid:8554/fixture",
		"rtsps://127.0.0.1:8554/fixture", "rtsp://user:pass@127.0.0.1:8554/fixture", "rtsp://127.0.0.1/fixture",
		"rtsp://127.0.0.1:8554/fixture?", "rtsp://127.0.0.1:8554/fixture?x=y", "rtsp://127.0.0.1:8554/fixture#x",
		"rtsp://127.0.0.1:8554/%0d", "rtsp://[::ffff:127.0.0.1]:8554/fixture",
	} {
		u, err := base.ParseURL(value)
		if err == nil && validateURL(u, fixtureDestination()) == nil { t.Fatal("accepted forbidden URI") }
	}
	for _, control := range []string{"trackID=0", "/trackID=0", "rtsp://127.0.0.1:8554/fixture/trackID=0"} {
		if validateControl(control, fixtureDestination(), false) != nil { t.Fatal("rejected supported control") }
	}
	for _, status := range []base.StatusCode{301, 302, 303, 304, 305, 307, 308, 401, 407, 404, 500} {
		if validateResponse(&base.Response{StatusCode: status}, fixtureDestination()) != ErrPolicy { t.Fatal("accepted unsupported status") }
	}
	for _, key := range []string{"Content-Base", "Content-Location"} {
		for _, value := range []string{"rtsp://192.0.2.1:8554/fixture", "//other/fixture", "/fixture?x=y"} {
			if validateResponse(&base.Response{StatusCode: 200, Header: base.Header{key: {value}}}, fixtureDestination()) != ErrPolicy { t.Fatal("accepted unsafe base/location") }
		}
		if validateResponse(&base.Response{StatusCode: 200, Header: base.Header{key: {"/fixture/"}}}, fixtureDestination()) != nil { t.Fatal("rejected relative base/location") }
	}
}
